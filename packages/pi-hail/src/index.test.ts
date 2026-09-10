import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createExtension } from "./index.ts";
import type { Duplex } from "./socket.ts";

/** In-process fake Duplex (same shape as socket.test.ts): captures writes; lets a test push `data`. */
class FakeDuplex extends EventEmitter implements Duplex {
  writes: string[] = [];
  ended = false;
  write(s: string): void {
    this.writes.push(s);
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
  createExtension(pi, { connect: async () => fake, getPermissionsService: () => undefined });
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
