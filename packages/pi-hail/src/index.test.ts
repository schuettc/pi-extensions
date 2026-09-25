import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createExtension } from "./index.ts";
import type { Duplex } from "./socket.ts";

// These cases model a pi started in a bare terminal (no tmux): identity falls
// back to cwd basename unless a test injects @hail_session via getTmuxSessionId.
// The worker/CI shell may itself run inside tmux, so clear $TMUX here to keep
// readTmuxFacts() deterministic (inTmux:false) — matching the brief's premise.
delete process.env.TMUX;
delete process.env.TMUX_PANE;

/** In-process fake Duplex (same shape as socket.test.ts): captures writes; lets a test push `data`. */
class FakeDuplex extends EventEmitter implements Duplex {
  writes: string[] = [];
  ended = false;
  write(s: string): boolean {
    this.writes.push(s);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  push(chunk: string): void {
    this.emit("data", chunk);
  }
}

interface Spy<A extends unknown[]> {
  (...args: A): void;
  calls: A[];
}
function spy<A extends unknown[]>(): Spy<A> {
  const calls: A[] = [];
  const fn = ((...args: A) => {
    calls.push(args);
  }) as Spy<A>;
  fn.calls = calls;
  return fn;
}

/** A fake pi: records handlers registered via pi.on / pi.events.on and lets a test fire them. */
function makeFakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const busHandlers = new Map<string, ((data: unknown) => unknown)[]>();
  const sendUserMessage = spy<[string]>();
  const pi = {
    on(ev: string, h: (event: unknown, ctx: unknown) => unknown) {
      const list = handlers.get(ev) ?? [];
      list.push(h);
      handlers.set(ev, list);
    },
    events: {
      on(ch: string, h: (data: unknown) => unknown) {
        const list = busHandlers.get(ch) ?? [];
        list.push(h);
        busHandlers.set(ch, list);
      },
    },
    sendUserMessage: (t: string) => sendUserMessage(t),
    registerCommand: () => {},
  };
  return {
    pi,
    sendUserMessage,
    fire(ev: string, event: unknown, ctx: unknown): unknown[] {
      return (handlers.get(ev) ?? []).map((h) => h(event, ctx));
    },
    fireBus(ch: string, data: unknown): void {
      for (const h of busHandlers.get(ch) ?? []) h(data);
    },
  };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    cwd: "/abs/acceptance",
    sessionManager: {
      getSessionId: () => "S",
      getSessionFile: () => undefined,
      getEntries: () => [],
    },
    ui: { setStatus: spy<[string, unknown]>(), notify: spy<[string, unknown]>() },
    ...overrides,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

// Guards: a subagent or headless run must not register a session or hijack the pane (the pi-tmux-bridge ownership bug).
test("non-tui context registers nothing", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx({ mode: "print" }));
  await tick();
  await tick();
  assert.equal(fake.writes.length, 0);
});

// Guards: the live check — a pi started on the Mac registers with its identity and forwards its first turn.
test("tui session_start registers, and turn_start/turn_end forward through the socket", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, {
    connect: async () => fake,
    getPermissionsService: () => undefined,
    getTmuxSessionId: () => undefined,
  });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  // First written line is the register frame carrying the captured identity.
  assert.match(fake.writes[0], /"cmd":"session\.register"/);
  const reg = JSON.parse(fake.writes[0]);
  assert.equal(reg.args.sessionId, "S");
  assert.equal(reg.args.project, "acceptance");
  assert.equal(reg.args.dir, "/abs/acceptance");
  // Daemon accepts.
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fire("turn_start", { type: "turn_start" }, makeCtx());
  fire("turn_end", { type: "turn_end" }, makeCtx());
  const frames = fake.writes.slice(1).map((w) => JSON.parse(w));
  assert.ok(frames.some((f) => f.turn === "start"), "expected a { turn:'start' } frame");
  assert.ok(frames.some((f) => f.turn === "end"), "expected a { turn:'end' } frame");
});

// Guards (d): the register frame reports the pane's current in-memory cursor
// (sessionManager.getEntries().length) so the daemon seeds a fresh slot to it
// and never replays pre-existing history (streaming spec \u00a74.1).
test("register frame reports cursor = getEntries().length", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  const ctx = makeCtx({
    sessionManager: {
      getSessionId: () => "S",
      getSessionFile: () => undefined,
      getEntries: () => [{ type: "message" }, { type: "message" }, { type: "custom" }],
    },
  });
  fire("session_start", {}, ctx);
  await tick();
  await tick();
  const reg = JSON.parse(fake.writes[0]);
  assert.equal(reg.args.cursor, 3);
});

// Guards: a daemon-spawned pi must register under the Hail task id stamped on
// its tmux window, not pi's independently generated native session id. The
// daemon holds the phone's pending prompt under this exact id.
test("daemon pane registers with its @hail_session task id", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  const taskId = "cgd7vipge4pis2fc4exiofslmq";
  createExtension(pi, {
    connect: async () => fake,
    getPermissionsService: () => undefined,
    getTmuxSessionId: () => taskId,
  });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();

  const reg = JSON.parse(fake.writes[0]);
  assert.equal(reg.args.sessionId, taskId);
});

// Guards: turn lifecycle is emitted ONLY as {turn} frames — never also as an {event} carrying a pi turn rpc, or the daemon rotates turn keys twice per turn (C4, bridge PR #140).
test("turn lifecycle emits only {turn} frames, never a forwarded {event}", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fire("turn_start", { type: "turn_start" }, makeCtx());
  fire("turn_end", { type: "turn_end" }, makeCtx());
  const frames = fake.writes.slice(1).map((w) => JSON.parse(w));
  const turnFrames = frames.filter((f) => f.turn !== undefined).map((f) => f.turn);
  assert.deepEqual(
    turnFrames,
    ["start", "end"],
    "turn lifecycle frames must be exactly { turn:'start' } then { turn:'end' }",
  );
  const leakedTurnEvent = frames.find((f) => {
    if (f.event === undefined) return false;
    const rpc = f.event as { type?: string; method?: string } | null;
    return (
      rpc?.type === "turn_start" ||
      rpc?.type === "turn_end" ||
      rpc?.method === "turn_start" ||
      rpc?.method === "turn_end"
    );
  });
  assert.equal(
    leakedTurnEvent,
    undefined,
    "turn lifecycle must NEVER be forwarded as an {event} carrying a pi turn rpc (would rotate turn keys twice)",
  );
});

// Guards: a phone prompt arriving on the socket is submitted to pi as typed input carrying its turn.
test("inbound prompt calls pi.sendUserMessage", async () => {
  const { pi, fire, sendUserMessage } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fake.push('{"prompt":{"text":"do it","from":"p1","requestId":"r1"}}\n');
  await tick();
  assert.equal(sendUserMessage.calls.length, 1);
  assert.deepEqual(sendUserMessage.calls[0], ["do it"]);
});

// Guards: local typing during a phone-driven turn is HELD (not passed through to pi) — the soft-lock input hold (spec §4).
test("interactive input during a phone turn is held, but passes through while idle", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  // While idle (no phone turn), interactive input passes through untouched.
  const idleResults = fire("input", { source: "interactive", text: "hi" }, makeCtx());
  assert.deepEqual(idleResults[0], { action: "continue" });
  // A phone prompt starts a phone-driven turn.
  fake.push('{"prompt":{"text":"do it","from":"p1","requestId":"r1"}}\n');
  await tick();
  fire("turn_start", { type: "turn_start" }, makeCtx());
  // Now local typing must be HELD, not passed through to pi.
  const heldResults = fire("input", { source: "interactive", text: "local edit" }, makeCtx());
  assert.deepEqual(heldResults[0], { action: "handled" });
});

// Guards: no daemon → the extension is silent and pi still starts (never blocks / never throws).
test("failed connect does not throw from session_start", async () => {
  const { pi, fire } = makeFakePi();
  let leaked: unknown = null;
  const guard = (reason: unknown) => {
    leaked = reason;
  };
  process.once("unhandledRejection", guard);
  try {
    createExtension(pi, {
      connect: async () => {
        throw new Error("no daemon");
      },
      getPermissionsService: () => undefined,
    });
    assert.doesNotThrow(() => fire("session_start", {}, makeCtx()));
    await tick();
    await tick();
    assert.equal(leaked, null, "a rejected connect must not surface as an unhandled rejection");
  } finally {
    process.removeListener("unhandledRejection", guard);
  }
});

// Guards (P3): pi-hail no longer forwards permissions:ui_prompt \u2014 the blank
// phantom card that had only Deny is gone.
test("permissions:ui_prompt is no longer forwarded to the phone", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  const before = fake.writes.length;
  fireBus("permissions:ui_prompt", { requestId: "r1", payload: {} });
  await tick();
  assert.equal(fake.writes.length, before, "permissions:ui_prompt must produce no frame");
});

// Guards (P3): an ask pi-hail defers is closed on the phone when the permission
// system's own dialog decides it \u2014 permissions:decision \u2192 askDone allowed/mac.
test("permissions:decision closes a deferred ask on the wire (allowed/mac)", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  // Capture the authorizer the extension registers on permissions:ready.
  let authorize:
    | ((d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>)
    | undefined;
  const service = {
    registerAuthorizer: (_name: string, fn: typeof authorize) => {
      authorize = fn;
      return () => {};
    },
  };
  // A controllable Mac select dialog (ctx.ui.select).
  let resolveSelect: (v: string | undefined) => void = () => {};
  const select = (_t: string, _o: string[], _opts?: unknown) =>
    new Promise<string | undefined>((r) => {
      resolveSelect = r;
    });
  const ctx = makeCtx({
    ui: { setStatus: spy<[string, unknown]>(), notify: spy<[string, unknown]>(), select },
  });
  createExtension(pi, {
    connect: async () => fake,
    getPermissionsService: () => service as never,
  });
  fire("session_start", {}, ctx);
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  // The daemon affirms the session is connected to phones (sent on every
  // accepted register); only then does pi-hail open a phone ask.
  fake.push('{"connection":"connected"}\n');
  await tick();
  fireBus("permissions:ready", { sessionId: "S" });
  await tick();
  assert.ok(authorize, "expected the extension to register an authorizer");
  const verdictP = authorize({ requestId: "r1", toolName: "bash", command: "rm x" }, {}, {
    review() {},
    debug() {},
  });
  await tick();
  resolveSelect("More options\u2026"); // Mac defers to the permission dialog
  assert.deepEqual(await verdictP, { kind: "defer" });
  fireBus("permissions:decision", { requestId: "r1", result: "allow" });
  await tick();
  const frames = fake.writes.map((w) => JSON.parse(w));
  const askDones = frames.map((f) => f.askDone).filter((a) => a !== undefined);
  // The deferral emits askDone deferred/mac; the decision collapses it to
  // allowed/mac \u2014 assert the final close.
  assert.deepEqual(askDones.at(-1), { requestId: "r1", outcome: "allowed", by: "mac" });
  assert.deepEqual(askDones.at(0), { requestId: "r1", outcome: "deferred", by: "mac" });
});

// Guards (fix): when the control socket drops, pi-hail falls back to NOT
// connected \u2014 an ask defers to pi's normal prompt without opening a phone ask or
// a Mac dialog, until the daemon re-affirms the session.
test("a dropped socket makes pi-hail defer asks (no ask frame, no Mac dialog)", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  let authorize:
    | ((d: unknown, q: unknown, l: unknown) => Promise<{ kind: string }>)
    | undefined;
  const service = {
    registerAuthorizer: (_name: string, fn: typeof authorize) => {
      authorize = fn;
      return () => {};
    },
  };
  const selectCalls: string[] = [];
  const select = (title: string) => {
    selectCalls.push(title);
    return new Promise<string | undefined>(() => {});
  };
  const ctx = makeCtx({
    ui: { setStatus: spy<[string, unknown]>(), notify: spy<[string, unknown]>(), select },
  });
  createExtension(pi, {
    connect: async () => fake,
    getPermissionsService: () => service as never,
  });
  fire("session_start", {}, ctx);
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fake.push('{"connection":"connected"}\n');
  await tick();
  fireBus("permissions:ready", { sessionId: "S" });
  await tick();
  assert.ok(authorize);
  // The control socket drops (daemon unreachable).
  fake.emit("close");
  await tick();
  const before = fake.writes.length;
  const verdict = await authorize({ requestId: "r9", toolName: "bash", command: "rm x" }, {}, {
    review() {},
    debug() {},
  });
  assert.deepEqual(verdict, { kind: "defer" });
  assert.equal(selectCalls.length, 0, "no Mac dialog while disconnected");
  const askFrames = fake.writes
    .slice(before)
    .map((w) => JSON.parse(w))
    .filter((f) => f.ask !== undefined);
  assert.equal(askFrames.length, 0, "no { ask } frame while disconnected");
});

// Guards: pi quit emits an exit frame with the code.
test("session_shutdown reason 'quit' emits { exit }", async () => {
  const { pi, fire } = makeFakePi();
  const fake = new FakeDuplex();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fire("session_shutdown", { reason: "quit" }, makeCtx());
  const frames = fake.writes.map((w) => JSON.parse(w));
  assert.ok(frames.some((f) => f.exit && f.exit.code === 0), "expected an { exit:{code:0} } frame");
  assert.equal(fake.ended, true);
});
