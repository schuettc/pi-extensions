import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, stripProgressPartial } from "./session.ts";
import { EXTENSION_VERSION } from "./version.ts";
import { fakeDeps, lastSend } from "./test-helpers.ts";

// Guards: the phone never sees a session it can't identify — register must carry id, project, work, dir, and both versions.
test("buildRegisterArgs stamps extensionVersion and passes identity through", () => {
  const s = new Session(fakeDeps());
  const args = s.buildRegisterArgs({
    sessionId: "S",
    project: "acceptance",
    work: "first-run",
    dir: "/abs",
    piVersion: "0.85.1",
  });
  assert.deepEqual(args, {
    sessionId: "S",
    project: "acceptance",
    work: "first-run",
    dir: "/abs",
    piVersion: "0.85.1",
    extensionVersion: EXTENSION_VERSION,
  });
});

// Guards: adoption facts ride the register payload only when present; absent
// facts are omitted so older daemons see exactly today's payload.
test("buildRegisterArgs carries identity and tmux facts when present", () => {
  const s = new Session(fakeDeps());
  const args = s.buildRegisterArgs({
    sessionId: "pi-7",
    project: "bettor-help",
    work: "contests",
    dir: "/abs",
    piVersion: "0.85.1",
    identity: "proj",
    tmux: { socket: "/private/tmp/tmux-501/proj-bettor-help", session: "bettor-help/contests", pane: "%3" },
  });
  assert.deepEqual(args, {
    sessionId: "pi-7",
    project: "bettor-help",
    work: "contests",
    dir: "/abs",
    piVersion: "0.85.1",
    extensionVersion: EXTENSION_VERSION,
    identity: "proj",
    tmux: true,
    tmuxSocket: "/private/tmp/tmux-501/proj-bettor-help",
    tmuxSession: "bettor-help/contests",
    tmuxPane: "%3",
  });
});

// Guards: every pi event reaches the phone verbatim, wrapped as { event }.
test("forwardEvent wraps the pi event verbatim", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  const evt = { type: "message_start", id: "m1" };
  s.forwardEvent(evt);
  assert.deepEqual(lastSend(deps), { event: evt });
});

// Guards: turn boundaries the phone needs to gate its composer.
test("turnStart/turnEnd emit { turn:'start' } and { turn:'end' }", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.turnStart();
  assert.deepEqual(lastSend(deps), { turn: "start" });
  s.turnEnd();
  assert.deepEqual(lastSend(deps), { turn: "end" });
});

// Guards: a clean pi exit tells the phone the session is gone.
test("exit emits { exit:{code} }", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.exit(0);
  assert.deepEqual(lastSend(deps), { exit: { code: 0 } });
});

// Guards: a phone prompt during the person's own turn is refused with a reason, never silently dropped or queued (spec §4).
test("prompt during local_turn is refused with reason turn_running", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.turnStart(); // local turn (no pending phone prompt)
  s.onInbound({ prompt: { text: "hi", from: "p1", requestId: "r1" } });
  assert.deepEqual(lastSend(deps), { refused: { requestId: "r1", reason: "turn_running" } });
  assert.equal(deps.sendUserMessage.calls.length, 0);
});

// Guards: while the phone drives, local typing is held with a visible notice and replayed after — not dropped (spec §4).
test("local input during phone_turn is held, then re-submitted on turn end", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.onInbound({ prompt: { text: "do it", from: "p1", requestId: "r2" } }); // starts phone turn
  s.turnStart();
  assert.equal(s.submitLocalInput("my local note"), false); // held
  assert.equal(deps.ui.holdInput.lastArg[0], true);
  s.turnEnd();
  assert.equal(deps.ui.holdInput.lastArg[0], false);
  assert.equal(deps.sendUserMessage.calls.at(-1)?.[0], "my local note"); // replayed
});

// Guards: a { lock } frame brackets a phone-driven turn so the daemon can mirror "Mac is working" to other phones.
test("phone turn emits lock held on start and released on end", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.onInbound({ prompt: { text: "do it", from: "p1", requestId: "r3" } }); // starts phone turn
  s.turnStart();
  assert.deepEqual(deps.send.calls[0][0], { lock: "held" });
  assert.deepEqual(deps.send.calls[1][0], { turn: "start" });
  s.turnEnd();
  assert.deepEqual(deps.send.calls[2][0], { turn: "end" });
  assert.deepEqual(deps.send.calls[3][0], { lock: "released" });
});

// Guards: register no longer replays \u2014 the daemon drives catch-up via a
// {"resend":{since}} frame (streaming spec \u00a74.3). Neither a first-connect nor a
// reconnect register reply sends anything.
test("register reply never replays (catch-up is driven by resend)", () => {
  const deps = fakeDeps();
  deps.getEntries = (): unknown[] => [{ type: "message", message: { role: "assistant" } }];
  const s = new Session(deps);

  s.onRegisterReply({ ok: true, data: { hostId: "h", daemonVersion: "0.3.0", accepted: true, have: 2 } });
  assert.equal(deps.send.calls.length, 0);

  s.onRegisterReply({ ok: true, data: { hostId: "h", daemonVersion: "0.3.0", accepted: true, have: 5 } });
  assert.equal(deps.send.calls.length, 0);
});

// Guards: a version mismatch is one plain sentence in pi and then silence — never a silent downstream failure (C6, spec §7).
test("version_mismatch reply renders one notice and makes the session inert", () => {
  const deps = fakeDeps(); const s = new Session(deps);
  s.onRegisterReply({ ok: false, error: "version_mismatch: daemon 0.3.0 requires extension >= 0.1.0" });
  assert.equal(deps.ui.notify.calls.length, 1);
  assert.match(deps.ui.notify.lastArg[0], /update/i);
  assert.equal(s.active(), false);
  s.forwardEvent({ type: "turn_start" });          // must be a no-op now
  assert.equal(deps.send.calls.length, 0);
});

// Guards: a presence frame updates the status line.
test("onInbound presence sets the status text", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.onInbound({ presence: { phones: [{ deviceId: "p", name: "iPhone", state: "driving" }] } });
  assert.equal(deps.ui.setStatus.lastArg[0], "phone is working");
});

import type { SessionDeps } from "./session.ts";

function recDeps() {
  const sent: unknown[] = [];
  const statuses: (string | undefined)[] = [];
  const notes: string[] = [];
  const r = {
    sent,
    statuses,
    notes,
    // pi's in-memory entry list (sessionManager.getEntries()); the cursor unit.
    entries: [] as unknown[],
    deps: undefined as unknown as SessionDeps,
  };
  r.deps = {
    send: (o) => sent.push(o),
    sendUserMessage: () => {},
    ui: {
      setStatus: (t) => statuses.push(t),
      notify: (m) => notes.push(m),
      holdInput: () => {},
    },
    getEntries: () => r.entries,
  };
  return r;
}

// Guards: the pane always tells the truth about whether the phone can see it.
test("connection disconnected overrides presence until connected", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  s.onInbound({ presence: { phones: [{ deviceId: "p", name: "P", state: "connected" }] } });
  s.onInbound({ connection: "disconnected" });
  s.onInbound({ connection: "connected" });
  assert.deepEqual(r.statuses, ["phone connected", "hail: disconnected · /hail connect", "phone connected"]);
});

test("connection unavailable notifies and leaves the status alone", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  s.onInbound({ connection: "unavailable" });
  assert.deepEqual(r.statuses, []);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0], /isn't shared with your phone/);
});

// Guards: a control-socket drop is the unknown / no-daemon state, NOT an
// explicit "disconnected" \u2014 the status line keeps today's presence text; only the
// daemon's explicit disconnected frame shows CONNECTION_STATUS_DISCONNECTED.
test("a socket disconnect does not flip the status to the disconnected text", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  s.onInbound({ presence: { phones: [{ deviceId: "p", name: "P", state: "connected" }] } });
  s.onTransportDown();
  assert.deepEqual(r.statuses, ["phone connected"]);
});

test("requestConnection sends connect/disconnect frames", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  assert.equal(s.requestConnection(false), true);
  assert.equal(s.requestConnection(true), true);
  assert.deepEqual(r.sent, [{ connection: "disconnect" }, { connection: "connect" }]);
});

// Guards (b): resend replays only message entries after `since`, each tagged
// with cursor = since + i + 1 (threading `since` through), then signals done.
test("resend replays message entries after since with cursor since+i+1 then done", () => {
  const r = recDeps();
  r.entries = [
    { type: "message", message: { role: "user" } }, // 1 (at/​before since \u2192 skipped)
    { type: "model_change" }, // 2 (non-message \u2192 skipped)
    { type: "message", message: { role: "assistant" } }, // 3
  ];
  const s = new Session(r.deps);
  s.onInbound({ resend: { since: 1 } });
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: { role: "assistant" } }, replay: true, cursor: 3 },
    { resend: "done" },
  ]);
});

// T1.3 \u2014 onInbound reads `limit` off the resend frame and passes it through.
test("onInbound resend passes since and limit to onResend", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  const calls: Array<[number, number | undefined]> = [];
  s.onResend = (since: number, limit?: number) => {
    calls.push([since, limit]);
  };
  s.onInbound({ resend: { since: 5, limit: 2 } });
  s.onInbound({ resend: { since: 5 } });
  assert.deepEqual(calls, [
    [5, 2],
    [5, 0],
  ]);
});

// T1.2 \u2014 onResend(since, limit): limit 0 (or absent) is uncapped \u2014 all frames
// after `since`, no marker, then done (today's behavior).
test("onResend with limit 0 replays every frame after since with no marker", () => {
  const r = recDeps();
  r.entries = [
    { type: "message", message: { role: "assistant" } }, // 1
    { type: "message", message: { role: "assistant" } }, // 2
    { type: "message", message: { role: "assistant" } }, // 3
  ];
  const s = new Session(r.deps);
  s.onResend(0, 0);
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: { role: "assistant" } }, replay: true, cursor: 1 },
    { event: { type: "message_end", message: { role: "assistant" } }, replay: true, cursor: 2 },
    { event: { type: "message_end", message: { role: "assistant" } }, replay: true, cursor: 3 },
    { resend: "done" },
  ]);
});

// T1.2 \u2014 more frames than limit: FIRST a hail_history_trimmed marker carrying
// the count skipped and the cursor of the LAST skipped frame, THEN exactly
// `limit` kept frames with their TRUE absolute cursors, THEN done.
test("onResend caps to the last `limit` frames and prepends a trimmed marker", () => {
  const r = recDeps();
  r.entries = [
    { type: "message", message: { role: "assistant", content: "a" } }, // 1
    { type: "message", message: { role: "assistant", content: "b" } }, // 2
    { type: "message", message: { role: "assistant", content: "c" } }, // 3
    { type: "message", message: { role: "assistant", content: "d" } }, // 4
  ];
  const s = new Session(r.deps);
  s.onResend(0, 2);
  assert.deepEqual(r.sent, [
    { event: { type: "hail_history_trimmed", skipped: 2 }, replay: true, cursor: 2 },
    { event: { type: "message_end", message: { role: "assistant", content: "c" } }, replay: true, cursor: 3 },
    { event: { type: "message_end", message: { role: "assistant", content: "d" } }, replay: true, cursor: 4 },
    { resend: "done" },
  ]);
});

// T1.2 \u2014 fewer/equal frames than limit: NO marker, all frames, done.
test("onResend with frames <= limit sends no marker", () => {
  const r = recDeps();
  r.entries = [
    { type: "message", message: { role: "assistant", content: "a" } }, // 1
    { type: "message", message: { role: "assistant", content: "b" } }, // 2
  ];
  const s = new Session(r.deps);
  s.onResend(0, 2);
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: { role: "assistant", content: "a" } }, replay: true, cursor: 1 },
    { event: { type: "message_end", message: { role: "assistant", content: "b" } }, replay: true, cursor: 2 },
    { resend: "done" },
  ]);
});

// Guards (a) \u2014 the pinning test for pi's ordering: at message_end, extensions run
// BEFORE sessionManager.appendMessage persists the entry, so getEntries() is one
// short. The reported cursor (getEntries().length + 1) must equal the entry's
// FINAL 1-based position after the append.
test("message_end reports cursor equal to the entry's final position (append happens after)", () => {
  const r = recDeps();
  r.entries = [
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
  ];
  const s = new Session(r.deps);
  const msg = { role: "assistant", content: [{ type: "text", text: "hi" }] };
  // pi emits message_end while getEntries() still has 2 entries.
  s.forwardEvent({ type: "message_end", message: msg });
  // pi now persists the entry (position 3).
  r.entries.push({ type: "message", message: msg });
  assert.deepEqual(r.sent, [{ event: { type: "message_end", message: msg }, cursor: 3 }]);
  assert.equal(r.entries.length, 3);
});

// Guards: a message_end whose role is NOT persisted (e.g. a transient role)
// carries no cursor; tool_execution_end never carries a cursor.
test("non-persisted roles and tool_execution_end carry no cursor", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  s.forwardEvent({ type: "message_end", message: { role: "bashExecution" } });
  s.forwardEvent({ type: "tool_execution_end", id: "t1" });
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: { role: "bashExecution" } } },
    { event: { type: "tool_execution_end", id: "t1" } },
  ]);
});

// Guards (c) \u2014 round trip: live cursors for 3 messages are 1,2,3; a resend from
// the 2nd message's cursor (2) replays EXACTLY the 3rd.
test("round trip: live cursors 1,2,3 then resend from 2 replays exactly the 3rd", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  for (let i = 0; i < 3; i++) {
    const msg = { role: "assistant", content: [{ type: "text", text: `m${i}` }] };
    s.forwardEvent({ type: "message_end", message: msg }); // cursor = entries.length + 1
    r.entries.push({ type: "message", message: msg }); // pi persists after
  }
  const liveCursors = r.sent
    .map((f) => (f as { cursor?: number }).cursor)
    .filter((c): c is number => c !== undefined);
  assert.deepEqual(liveCursors, [1, 2, 3]);

  r.sent.length = 0;
  s.onInbound({ resend: { since: 2 } });
  assert.deepEqual(r.sent, [
    {
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "m2" }] } },
      replay: true,
      cursor: 3,
    },
    { resend: "done" },
  ]);
});

// Guards: a bashExecution entry (persisted by pi WITHOUT a message_end emit, so
// never streamed live) sits between two live messages. Live and replay cursors
// must agree \u2014 no duplicate, and no live-visible message skipped.
test("round trip: a bash entry between live messages \u2014 live and replay cursors agree", () => {
  const r = recDeps();
  const s = new Session(r.deps);

  // message 1 (assistant) streams live at cursor 1, then pi persists it.
  const m1 = { role: "assistant", content: [{ type: "text", text: "m1" }] };
  s.forwardEvent({ type: "message_end", message: m1 });
  r.entries.push({ type: "message", message: m1 });
  // pi flushes a bash entry (no message_end emit) \u2014 appended to entries only.
  r.entries.push({ type: "message", message: { role: "bashExecution", content: [] } });
  // message 2 (assistant) streams live at cursor 3, then pi persists it.
  const m2 = { role: "assistant", content: [{ type: "text", text: "m2" }] };
  s.forwardEvent({ type: "message_end", message: m2 });
  r.entries.push({ type: "message", message: m2 });

  const liveCursors = r.sent
    .map((f) => (f as { cursor?: number }).cursor)
    .filter((c): c is number => c !== undefined);
  assert.deepEqual(liveCursors, [1, 3]); // bash never streamed live

  // Resend from the 1st message's cursor replays EXACTLY m2 at the same cursor 3.
  r.sent.length = 0;
  s.onInbound({ resend: { since: 1 } });
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: m2 }, replay: true, cursor: 3 },
    { resend: "done" },
  ]);
});

// Guards (d): the register cursor is getEntries().length, threaded through
// buildRegisterArgs so the daemon seeds a fresh slot to the pane's position.
test("buildRegisterArgs threads the register cursor (getEntries().length)", () => {
  const r = recDeps();
  r.entries = [{ type: "message" }, { type: "message" }, { type: "custom" }];
  const s = new Session(r.deps);
  const args = s.buildRegisterArgs({
    sessionId: "S",
    project: "p",
    work: "w",
    dir: "/d",
    piVersion: "0.85.1",
    cursor: r.deps.getEntries().length,
  });
  assert.equal(args.cursor, 3);
});

// ── Commit A: strip duplicate partial snapshots from progress events (muster #502) ──

// Guards: pi's message_update carries the FULL partial message twice (`message`
// and `assistantMessageEvent.partial`); forwarding both makes bytes/turn grow
// quadratically. Strip the duplicate `partial`, KEEP `message` (the phone
// renders from it), and never mutate pi's own event object.
test("stripProgressPartial removes assistantMessageEvent.partial without mutating the original", () => {
  const partial = { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] };
  const message = { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] };
  const event = {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "text_delta", delta: "x", partial },
  };
  const stripped = stripProgressPartial(event) as {
    type: string;
    message: unknown;
    assistantMessageEvent: Record<string, unknown>;
  };
  // partial gone from the copy…
  assert.equal("partial" in stripped.assistantMessageEvent, false);
  // …message kept (same reference is fine — it's the snapshot the phone renders)…
  assert.equal(stripped.message, message);
  assert.equal(stripped.assistantMessageEvent.type, "text_delta");
  assert.equal(stripped.assistantMessageEvent.delta, "x");
  // …and pi's original event is untouched (no mutation).
  assert.equal("partial" in event.assistantMessageEvent, true);
  assert.notEqual(stripped, event);
  assert.notEqual(stripped.assistantMessageEvent, event.assistantMessageEvent);
});

// Guards: tool_execution_update's `partialResult` is the tool's ONLY live output
// payload and the phone renders it (client toolOutput reads partialResult), so it
// must be KEPT verbatim \u2014 pi's WithoutPartial strips only message_update. Growth
// is bounded by the per-toolCallId throttle + backpressure, not by stripping.
test("stripProgressPartial keeps tool_execution_update.partialResult (the phone's live tool output)", () => {
  const event = {
    type: "tool_execution_update",
    toolCallId: "t1",
    toolName: "write",
    args: { path: "/p" },
    partialResult: { output: "y".repeat(1000) },
  };
  const result = stripProgressPartial(event) as Record<string, unknown>;
  // partialResult preserved
  assert.equal("partialResult" in result, true);
  assert.deepEqual(result.partialResult, { output: "y".repeat(1000) });
  // and the event passes through unchanged (same reference \u2014 no needless copy / no mutation)
  assert.equal(result, event);
});

// Guards: non-progress events and events without the duplicate field pass
// through unchanged (same reference — no needless copy).
test("stripProgressPartial passes non-progress events through unchanged", () => {
  const start = { type: "message_start", message: { role: "assistant" } };
  assert.equal(stripProgressPartial(start), start);
  const noPartial = { type: "message_update", message: {}, assistantMessageEvent: { type: "text_delta" } };
  assert.equal(stripProgressPartial(noPartial), noPartial);
});

// ── Commit B: throttle progress events newest-wins (muster #502) ──

/** A controllable clock + trailing-flush timer for the progress throttle, plus
 *  a recording send. No real time passes; `advance(ms)` fires due timers. */
function throttleDeps(opts: { canSendProgress?: () => boolean; onDrain?: (cb: () => void) => void } = {}) {
  const sent: unknown[] = [];
  let nowMs = 0;
  interface T {
    fireAt: number;
    cb: () => void;
    cancelled: boolean;
  }
  const timers: T[] = [];
  const deps = {
    send: (o: unknown) => sent.push(o),
    sendUserMessage: () => {},
    ui: {
      setStatus: () => {},
      notify: () => {},
      holdInput: () => {},
    },
    getEntries: () => [] as unknown[],
    now: () => nowMs,
    setTimer: (cb: () => void, ms: number): T => {
      const t: T = { fireAt: nowMs + ms, cb, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t: T) => {
      t.cancelled = true;
    },
    ...(opts.canSendProgress ? { canSendProgress: opts.canSendProgress } : {}),
    ...(opts.onDrain ? { onDrain: opts.onDrain } : {}),
  } as unknown as SessionDeps;
  const advance = (ms: number) => {
    nowMs += ms;
    // Fire due timers in scheduled order; a timer may schedule another.
    for (let i = 0; i < timers.length; i++) {
      const t = timers[i];
      if (!t.cancelled && t.fireAt <= nowMs) {
        t.cancelled = true;
        t.cb();
      }
    }
  };
  return { deps, sent, advance, setNow: (v: number) => (nowMs = v) };
}

const mkUpdate = (i: number) => ({
  type: "message_update",
  message: { role: "assistant", content: [{ type: "text", text: `m${i}` }] },
  assistantMessageEvent: { type: "text_delta", delta: `${i}`, partial: { big: "x".repeat(500) } },
});

// Guards: a burst of message_update deltas is coalesced newest-wins and flushed
// once when the trailing 250ms timer fires (bytes/turn stops being quadratic).
test("message_update progress is coalesced newest-wins and flushed on the 250ms timer", () => {
  const { deps, sent, advance } = throttleDeps();
  const s = new Session(deps);
  for (let i = 0; i < 5; i++) s.forwardEvent(mkUpdate(i));
  assert.equal(sent.length, 0, "held until the flush timer fires");
  advance(250);
  assert.equal(sent.length, 1, "exactly one flush carrying the newest");
  const frame = sent[0] as { event: { message: { content: { text: string }[] }; assistantMessageEvent: Record<string, unknown> } };
  assert.equal(frame.event.message.content[0].text, "m4", "the newest snapshot wins");
  assert.equal("partial" in frame.event.assistantMessageEvent, false, "and it is stripped");
});

// Guards: flushes happen at most every 250ms — a second burst inside the window
// is still held until the window elapses.
test("progress flushes at most once per 250ms window", () => {
  const { deps, sent, advance } = throttleDeps();
  const s = new Session(deps);
  s.forwardEvent(mkUpdate(0));
  advance(250); // first flush
  assert.equal(sent.length, 1);
  s.forwardEvent(mkUpdate(1));
  advance(100); // inside the window → still held
  assert.equal(sent.length, 1);
  advance(150); // window elapsed → second flush
  assert.equal(sent.length, 2);
});

// Guards: a non-progress (boundary) frame flushes pending progress FIRST so the
// wire order is preserved (boundary events must never be reordered).
test("a boundary frame flushes pending progress first, preserving order", () => {
  const { deps, sent } = throttleDeps();
  const s = new Session(deps);
  s.forwardEvent(mkUpdate(0));
  s.forwardEvent(mkUpdate(1)); // coalesced, still held
  s.turnEnd(); // boundary
  assert.equal(sent.length, 2);
  const first = sent[0] as { event?: { type?: string; message?: { content: { text: string }[] } } };
  assert.equal(first.event?.type, "message_update");
  assert.equal(first.event?.message?.content[0].text, "m1", "the newest snapshot precedes the boundary");
  assert.deepEqual(sent[1], { turn: "end" });
});

// Guards: tool_execution_update is coalesced per toolCallId, and message_update
// is tracked as its own kind — distinct keys each flush their own newest frame.
test("tool_execution_update coalesces per toolCallId; message_update tracked separately", () => {
  const { deps, sent, advance } = throttleDeps();
  const s = new Session(deps);
  s.forwardEvent({ type: "tool_execution_update", toolCallId: "a", toolName: "w", args: {}, partialResult: { n: 1 } });
  s.forwardEvent({ type: "tool_execution_update", toolCallId: "a", toolName: "w", args: {}, partialResult: { n: 2 } });
  s.forwardEvent({ type: "tool_execution_update", toolCallId: "b", toolName: "w", args: {}, partialResult: { n: 1 } });
  s.forwardEvent(mkUpdate(0));
  advance(250);
  assert.equal(sent.length, 3, "one flushed frame per distinct progress key");
  // tool a carries its NEWEST partialResult (kept \u2014 it's the phone's live output)
  const toolA = (sent as { event: { toolCallId?: string; partialResult?: { n: number } } }[]).find(
    (f) => f.event.toolCallId === "a",
  );
  assert.ok(toolA);
  assert.deepEqual(toolA!.event.partialResult, { n: 2 });
});

// ── Commit C: Session respects transport backpressure (muster #502) ──

// Guards: while the transport is over its high-water mark, progress is HELD
// (newest-wins), never written, and delivered only when the transport drains.
test("progress is held under backpressure and the newest is delivered on drain", () => {
  let canSend = true;
  let drainCb: (() => void) | undefined;
  const { deps, sent, advance } = throttleDeps({
    canSendProgress: () => canSend,
    onDrain: (cb) => {
      drainCb = cb;
    },
  });
  const s = new Session(deps);
  canSend = false;
  s.forwardEvent(mkUpdate(0));
  advance(250); // flush timer fires but the gate holds it
  assert.equal(sent.length, 0, "nothing written while over the mark");
  s.forwardEvent(mkUpdate(1)); // newest-wins while held
  advance(250);
  assert.equal(sent.length, 0);
  canSend = true;
  assert.ok(drainCb, "a drain retry was armed");
  drainCb!();
  assert.equal(sent.length, 1, "only the newest held frame is delivered on drain");
  const f = sent[0] as { event: { message: { content: { text: string }[] } } };
  assert.equal(f.event.message.content[0].text, "m1");
});

// Guards: boundary frames are ALWAYS written, even over the high-water mark, and
// they still flush the newest held progress first (order preserved).
test("a boundary frame is written even under backpressure, after flushing pending", () => {
  const { deps, sent } = throttleDeps({ canSendProgress: () => false, onDrain: () => {} });
  const s = new Session(deps);
  s.forwardEvent(mkUpdate(3)); // held (gated)
  s.turnStart(); // boundary → forced flush of pending, then the boundary
  assert.equal(sent.length, 2);
  const first = sent[0] as { event?: { type?: string } };
  assert.equal(first.event?.type, "message_update");
  assert.deepEqual(sent[1], { turn: "start" });
});
