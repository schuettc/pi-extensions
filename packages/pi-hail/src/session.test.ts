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

// Guards (P1): the Mac-dialog capability is wired into SessionDeps.ui so the
// pure Session can open ctx.ui.select and dismiss it with an AbortSignal.
test("SessionDeps.ui exposes an openDialog capability the Session can drive", async () => {
  const deps = fakeDeps();
  const ac = new AbortController();
  const p = deps.ui.openDialog("Allow bash?", ["Allow", "Deny", "More options…"], ac.signal);
  assert.equal(deps.ui.openDialog.calls.length, 1);
  assert.equal(deps.ui.openDialog.calls[0][0], "Allow bash?");
  assert.deepEqual(deps.ui.openDialog.calls[0][1], ["Allow", "Deny", "More options…"]);
  assert.equal(deps.ui.openDialog.calls[0][2], ac.signal);
  deps.ui.openDialog.resolve("Allow");
  assert.equal(await p, "Allow");
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
      openDialog: () => new Promise<string | undefined>(() => {}),
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
