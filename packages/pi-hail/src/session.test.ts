import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./session.ts";
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
  deps.readSessionEntriesAfter = (): { events: unknown[]; cursor: number } => ({
    events: [{ type: "message_end", message: { role: "assistant" } }],
    cursor: 3,
  });
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
    entries: { events: [] as unknown[], cursor: 0 } as { events: unknown[]; cursor: number },
    deps: undefined as unknown as SessionDeps,
  };
  r.deps = {
    send: (o) => sent.push(o),
    sendUserMessage: () => {},
    ui: { setStatus: (t) => statuses.push(t), notify: (m) => notes.push(m), holdInput: () => {} },
    readSessionEntriesAfter: () => r.entries,
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

test("requestConnection sends connect/disconnect frames", () => {
  const r = recDeps();
  const s = new Session(r.deps);
  assert.equal(s.requestConnection(false), true);
  assert.equal(s.requestConnection(true), true);
  assert.deepEqual(r.sent, [{ connection: "disconnect" }, { connection: "connect" }]);
});

test("resend replays completed entries then signals done", () => {
  const r = recDeps();
  r.entries = { events: [{ type: "message_end", message: { role: "assistant" } }], cursor: 3 };
  const s = new Session(r.deps);
  s.onInbound({ resend: { since: 1 } });
  assert.deepEqual(r.sent, [
    { event: { type: "message_end", message: { role: "assistant" } }, replay: true },
    { resend: "done" },
  ]);
});
