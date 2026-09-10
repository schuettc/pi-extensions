import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./session.ts";
import type { SessionDeps } from "./session.ts";
import { EXTENSION_VERSION } from "./version.ts";

interface Recorder<A extends unknown[]> {
  (...args: A): void;
  calls: A[];
  get lastArg(): A;
}

function recorder<A extends unknown[]>(): Recorder<A> {
  const calls: A[] = [];
  const fn = ((...args: A) => {
    calls.push(args);
  }) as Recorder<A>;
  fn.calls = calls;
  Object.defineProperty(fn, "lastArg", {
    get() {
      return calls[calls.length - 1];
    },
  });
  return fn;
}

/** Reusable fake dependency set. Later tasks extend this. */
export function fakeDeps() {
  const send = recorder<[unknown]>();
  const sendUserMessage = recorder<[string]>();
  const setStatus = recorder<[string | undefined]>();
  const notify = recorder<[string, ("info" | "warning" | "error")?]>();
  const holdInput = recorder<[boolean]>();
  const readSessionEvents = (_sinceSeq: number): unknown[] => [];
  const deps: SessionDeps & {
    send: typeof send;
    sendUserMessage: typeof sendUserMessage;
    ui: { setStatus: typeof setStatus; notify: typeof notify; holdInput: typeof holdInput };
  } = {
    send,
    sendUserMessage,
    ui: { setStatus, notify, holdInput },
    readSessionEvents,
  };
  return deps;
}

export function lastSend(deps: ReturnType<typeof fakeDeps>): unknown {
  return deps.send.lastArg?.[0];
}

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

// Guards: after a daemon restart, replay backfills the gap; a first connect must NOT replay (no double-send).
test("a reconnect register reply replays events; a first-connect reply does not", () => {
  const deps = fakeDeps();
  const replayed = [
    { type: "turn_start" },
    { type: "message_start", id: "m9" },
  ];
  // Stub the replay source to return known entries regardless of cursor.
  deps.readSessionEvents = (_sinceSeq: number): unknown[] => replayed;
  const s = new Session(deps);

  // First connect: stores `have`, does not replay.
  s.onRegisterReply({ ok: true, data: { hostId: "h", daemonVersion: "0.3.0", accepted: true, have: 2 } });
  assert.equal(deps.send.calls.length, 0);

  // Reconnect: replays each returned entry as a live { event } frame, in order.
  s.onRegisterReply({ ok: true, data: { hostId: "h", daemonVersion: "0.3.0", accepted: true, have: 5 } });
  assert.equal(deps.send.calls.length, replayed.length);
  assert.deepEqual(deps.send.calls[0][0], { event: { type: "turn_start" } });
  assert.deepEqual(deps.send.calls[1][0], { event: { type: "message_start", id: "m9" } });
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
