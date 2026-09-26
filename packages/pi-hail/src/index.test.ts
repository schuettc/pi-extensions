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

// ── T2.4: register the prompt answerer on permissions:ready ─────────────────

/** A fake PromptAnswerer whose answer/dispose calls are recorded. */
function makeAnswerer() {
  const answers = spy<[string, "allow" | "deny"]>();
  const dispose = spy<[]>();
  return { answer: (r: string, v: "allow" | "deny") => (answers(r, v), true), dispose, answers };
}

/** A ctx whose ui.notify is a spy the test can inspect (captured at start). */
function ctxWithNotify() {
  const notify = spy<[string, unknown]>();
  const ctx = makeCtx({ ui: { setStatus: spy<[string, unknown]>(), notify } });
  return { ctx, notify };
}

/** Capture console.error while `fn` runs; return the recorded arg lists. */
async function captureConsoleError(fn: () => Promise<void>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return errors;
}

// Guards (E.3, case 1): a service carrying the fork's seam registers the
// "pi-hail" answerer once, idempotent across repeat readies, disposed on quit.
test("permissions:ready registers the pi-hail answerer (idempotent), disposed on quit", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  const answerer = makeAnswerer();
  const names: string[] = [];
  const service = {
    registerPromptAnswerer: (name: string) => {
      names.push(name);
      return answerer;
    },
  };
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => service as never });
  fire("session_start", {}, makeCtx());
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  fireBus("permissions:ready", { sessionId: "S" });
  await tick();
  assert.deepEqual(names, ["pi-hail"]);
  // A repeat ready must not register again.
  fireBus("permissions:ready", { sessionId: "S" });
  await tick();
  assert.deepEqual(names, ["pi-hail"], "registration is idempotent across repeat readies");
  // A clean quit disposes the answerer.
  fire("session_shutdown", { reason: "quit" }, makeCtx());
  assert.equal(answerer.dispose.calls.length, 1, "answerer disposed on quit");
});

// Guards (E.3, case 2): a permission service WITHOUT the fork's seam warns once,
// visibly (pi UI notify + console.error), and keeps phone approvals disabled.
test("a service without registerPromptAnswerer warns once and registers no answerer", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  // Plain upstream shape: registerAuthorizer present, registerPromptAnswerer absent.
  const service = { registerAuthorizer: () => () => {} };
  const { ctx, notify } = ctxWithNotify();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => service as never });
  fire("session_start", {}, ctx);
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  const errors = await captureConsoleError(async () => {
    fireBus("permissions:ready", { sessionId: "S" });
    await tick();
    fireBus("permissions:ready", { sessionId: "S" }); // repeat: still once
    await tick();
  });
  const wanted = "hail: phone approvals need @schuettc/pi-permission-system";
  const warnNotifies = notify.calls.filter((c) => c[0] === wanted && c[1] === "warning");
  assert.equal(warnNotifies.length, 1, "warns exactly once through pi's UI");
  const warnLogs = errors.filter((e) => e[0] === wanted);
  assert.equal(warnLogs.length, 1, "logs the warning once");
});

// Guards (E.3, case 3): no permission system at all \u2014 pi-hail is quiet, no
// warning through the UI or the console; approvals are simply absent.
test("no permission system: quiet, no warning", async () => {
  const { pi, fire, fireBus } = makeFakePi();
  const fake = new FakeDuplex();
  const { ctx, notify } = ctxWithNotify();
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
  fire("session_start", {}, ctx);
  await tick();
  await tick();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await tick();
  const errors = await captureConsoleError(async () => {
    fireBus("permissions:ready", { sessionId: "S" });
    await tick();
  });
  assert.equal(notify.calls.length, 0, "no UI notification when there is no permission system");
  assert.equal(errors.length, 0, "no console warning when there is no permission system");
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
