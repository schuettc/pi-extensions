// Regression — pi-hail OOM on long streamed turns (muster #502).
//
// pi crashed with "JavaScript heap out of memory" mid-stream on a turn that
// streamed one big `write` tool call: index forwarded every `message_update`
// verbatim, and pi's event carries the FULL partial message TWICE (`message`
// and `assistantMessageEvent.partial`), so encodeLine → JSON.stringify per delta
// made bytes/turn ∝ deltas × size (quadratic); DaemonSocket.send ignored
// write()'s backpressure, so a slow daemon reader let the Node write buffer grow
// unbounded.
//
// This test drives the WHOLE path (Session → DaemonSocket → a slow/paused reader
// duplex) through a ~150 KB streamed turn of 3000 growing `message_update`
// events and asserts the fix holds it bounded:
//   - total JSON bytes actually written stay well under 20 MB (vs the hundreds
//     of MB a verbatim forward would stringify — measured as the baseline);
//   - the peak write-buffer never exceeds ~2 MB (backpressure gate);
//   - the final message_end is delivered intact;
//   - the last progress snapshot before message_end is the NEWEST (newest-wins).

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DaemonSocket, type Duplex } from "./socket.ts";
import { Session, type SessionDeps, type TimerHandle } from "./session.ts";
import { encodeLine, type RegisterArgs } from "./protocol.ts";

/** A slow/paused reader: writes pile into `writableLength` and are only cleared
 *  when the test calls drain() (the reader consumed the buffer). Tracks the peak
 *  buffered byte count ever reached. */
class SlowReaderDuplex extends EventEmitter implements Duplex {
  writes: string[] = [];
  totalBytes = 0;
  writableLength = 0;
  writableNeedDrain = false;
  peak = 0;
  write(s: string): boolean {
    this.writes.push(s);
    const n = Buffer.byteLength(s);
    this.totalBytes += n;
    this.writableLength += n;
    if (this.writableLength > this.peak) this.peak = this.writableLength;
    // Model node's highWaterMark: report full once the buffer is large.
    if (this.writableLength >= 64 * 1024) this.writableNeedDrain = true;
    return !this.writableNeedDrain;
  }
  end(): void {}
  push(chunk: string): void {
    this.emit("data", chunk);
  }
  /** The reader consumed everything buffered so far → the socket drains. */
  drain(): void {
    this.writableLength = 0;
    this.writableNeedDrain = false;
    this.emit("drain");
  }
}

const REGISTER_ARGS: RegisterArgs = {
  sessionId: "S",
  project: "p",
  work: "w",
  dir: "/abs",
  piVersion: "0.85.1",
  extensionVersion: "0.4.1",
};

/** Build a message_update whose cumulative `message` (and pi's duplicate
 *  `assistantMessageEvent.partial`) grow toward ~150 KB — a streamed write. */
function makeUpdate(i: number, n: number): unknown {
  const size = Math.ceil((150 * 1024 * (i + 1)) / n);
  const text = "x".repeat(size);
  const message = { role: "assistant", content: [{ type: "text", text }] };
  return {
    type: "message_update",
    message,
    // The duplicate cumulative snapshot pi carries — what we strip.
    assistantMessageEvent: {
      type: "text_delta",
      delta: "x",
      partial: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

test("a 150 KB / 3000-event streamed turn against a slow reader stays bounded (muster #502)", async () => {
  const N = 3000;
  const fake = new SlowReaderDuplex();

  // A controllable clock + timer for the progress throttle.
  let nowMs = 0;
  interface T {
    fireAt: number;
    cb: () => void;
    cancelled: boolean;
  }
  const timers: T[] = [];
  const fireDue = () => {
    for (const t of timers) {
      if (!t.cancelled && t.fireAt <= nowMs) {
        t.cancelled = true;
        t.cb();
      }
    }
  };

  const socket = new DaemonSocket({
    connect: async () => fake,
    backoffMs: [3_600_000],
    onLine: () => {},
    onDown: () => {},
  });
  const reg = socket.register(REGISTER_ARGS);
  await Promise.resolve();
  await Promise.resolve();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.4.0","accepted":true}}\n');
  await reg;

  // Measure only the turn: reset the buffer/write log after the handshake.
  fake.writes.length = 0;
  fake.totalBytes = 0;
  fake.writableLength = 0;
  fake.writableNeedDrain = false;
  fake.peak = 0;

  const deps: SessionDeps = {
    send: (o) => socket.send(o),
    canSendProgress: () => socket.canSendProgress(),
    onDrain: (cb) => socket.onDrain(cb),
    sendUserMessage: () => {},
    ui: { setStatus: () => {}, notify: () => {}, holdInput: () => {}, openDialog: () => new Promise(() => {}) },
    getEntries: () => [],
    now: () => nowMs,
    setTimer: (cb, ms): TimerHandle => {
      const t: T = { fireAt: nowMs + ms, cb, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as T).cancelled = true;
    },
  };
  const session = new Session(deps);
  session.onRegisterReply({ ok: true, data: { hostId: "h", daemonVersion: "0.4.0", accepted: true, have: 0 } });

  // Compute the naive baseline: what a verbatim forward would have stringified
  // (every event, full message + its duplicate partial) — the pre-fix cost.
  let baselineBytes = 0;
  const events: unknown[] = [];
  for (let i = 0; i < N; i++) {
    const e = makeUpdate(i, N);
    events.push(e);
    baselineBytes += Buffer.byteLength(encodeLine({ event: e }));
  }

  // Stream the turn: message_start, 3000 deltas (~1 ms apart), message_end.
  session.forwardEvent({ type: "message_start", message: { role: "assistant", content: [] } });
  fireDue();
  for (let i = 0; i < N; i++) {
    session.forwardEvent(events[i]);
    nowMs += 1; // deltas arrive ~1 ms apart (far faster than the 250 ms window)
    fireDue();
    // A slow reader consumes the buffer roughly every 500 ms of stream time.
    if (nowMs % 500 === 0) fake.drain();
  }
  const finalMessage = (events[N - 1] as { message: unknown }).message;
  session.forwardEvent({ type: "message_end", message: finalMessage });
  fireDue();

  // ── Measurements ──────────────────────────────────────────────────────────
  const totalBytes = fake.totalBytes;
  const peakBytes = fake.peak;
  const stringifyCountAfter = fake.writes.length; // one encodeLine per written frame
  const stringifyCountBefore = N; // verbatim forward stringifies every delta
  // eslint-disable-next-line no-console
  console.log(
    `[muster #502] stringify count: before=${stringifyCountBefore} after=${stringifyCountAfter}; ` +
      `bytes written: baseline(naive)=${(baselineBytes / 1e6).toFixed(1)} MB after=${(totalBytes / 1e6).toFixed(2)} MB; ` +
      `peak write buffer=${(peakBytes / 1e6).toFixed(2)} MB`,
  );

  // The baseline is genuinely enormous (hundreds of MB) — the OOM.
  assert.ok(baselineBytes > 100 * 1e6, `baseline should dwarf the fix (was ${baselineBytes})`);
  // Total bytes actually written stay well under 20 MB.
  assert.ok(totalBytes < 20 * 1e6, `total bytes written must stay < 20 MB (was ${totalBytes})`);
  // Peak write buffer stays under ~2 MB (backpressure gate).
  assert.ok(peakBytes < 2 * 1e6, `peak write buffer must stay < 2 MB (was ${peakBytes})`);
  // Far fewer stringifies than deltas (throttle + backpressure coalescing).
  assert.ok(stringifyCountAfter < N / 10, `expected coalescing (${stringifyCountAfter} vs ${N})`);

  // The final message_end is delivered intact, as the LAST frame.
  const lastFrame = JSON.parse(fake.writes[fake.writes.length - 1]) as {
    event: { type: string; message: { content: { text: string }[] } };
    cursor?: number;
  };
  assert.equal(lastFrame.event.type, "message_end");
  assert.equal(lastFrame.event.message.content[0].text.length, Math.ceil((150 * 1024 * N) / N));

  // The last PROGRESS snapshot before message_end is the newest (newest-wins):
  // its message equals the final 150 KB snapshot.
  const progressFrames = fake.writes
    .slice(0, -1)
    .map((l) => JSON.parse(l) as { event?: { type?: string; message?: { content?: { text: string }[] } } })
    .filter((f) => f.event?.type === "message_update");
  assert.ok(progressFrames.length > 0, "at least one progress frame was delivered");
  const lastProgress = progressFrames[progressFrames.length - 1];
  assert.equal(
    lastProgress.event?.message?.content?.[0].text.length,
    (finalMessage as { content: { text: string }[] }).content[0].text.length,
    "the last progress snapshot before message_end is the newest",
  );

  // And no partial duplicate ever rode the wire.
  for (const f of progressFrames) {
    assert.equal("partial" in ((f.event as { assistantMessageEvent?: object }).assistantMessageEvent ?? {}), false);
  }

  socket.close();
});
