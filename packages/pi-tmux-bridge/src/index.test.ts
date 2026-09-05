import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const busHandlers = new Map<string, Handler[]>();
  const sent: Array<{ message: unknown; options: unknown }> = [];
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    events: {
      on(event: string, handler: Handler) {
        busHandlers.set(event, [...(busHandlers.get(event) ?? []), handler]);
      },
    },
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options });
    },
  };
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "sess-1" },
    cwd: "/work/proj",
    model: { id: "Qwen3.8-27B" },
    getContextUsage: () => ({ tokens: 12000, contextWindow: 32000, percent: 37 }),
    ui: { setStatus: () => {} },
  };
  async function fire(event: string, payload: unknown = {}, overrideCtx?: unknown) {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, overrideCtx ?? ctx));
    return out;
  }
  async function fireBus(event: string, payload: unknown = {}) {
    const out: unknown[] = [];
    for (const h of busHandlers.get(event) ?? []) out.push(await h(payload, undefined as never));
    return out;
  }
  return {
    pi,
    ctx,
    fire,
    fireBus,
    events: () => [...handlers.keys()],
    busEvents: () => [...busHandlers.keys()],
    sent,
  };
}

// A tmux address that cannot collide with a real server or pane on the
// operator's machine: no `-L harness-test` server exists and `%999999` is far
// past any live pane id. Combined with injecting writeState/ringBell/runTmux in
// every test that would otherwise reach a default, the suite touches no real
// tmux server and no real state file.
const ctxTmux = { socket: "harness-test", pane: "%999999" };
const noopTmux = (_s: string, _a: string[]) => undefined;
const noopBell = (_c: unknown) => {};

test("it subscribes to exactly the lifecycle events it needs", async () => {
  const { pi, events } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux });
  const subscribed = events().sort();
  assert.deepEqual(subscribed, [
    "agent_settled", "session_info_changed", "session_shutdown", "session_start", "turn_end",
  ].sort());
});

test("session_start stamps the tmux session option and calls the SessionStart hook", async () => {
  const { pi, fire } = fakePi();
  const stamps: string[][] = [];
  const musterCalls: Array<{ args: string[]; input: string }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, args) => { stamps.push(args); return undefined; },
    runMuster: (_c, args, input) => { musterCalls.push({ args, input }); return ""; },
  });
  await fire("session_start", { reason: "startup" });
  assert.ok(stamps.some((a) => a.includes("@harness_session") && a.includes("sess-1")),
    `expected a @harness_session stamp, got ${JSON.stringify(stamps)}`);
  const hookCall = musterCalls.find((c) => c.args[1] === "SessionStart");
  assert.ok(hookCall, "expected a hook SessionStart pi call");
  assert.deepEqual(JSON.parse(hookCall.input), { session_id: "sess-1", cwd: "/work/proj", source: "startup" });
});

test("a resume or fork reason passes source: resume to the SessionStart hook", async () => {
  for (const reason of ["resume", "fork"]) {
    const { pi, fire } = fakePi();
    const musterCalls: Array<{ input: string }> = [];
    createHarness(pi as never, { raiseAttention: noopBell,
      tmux: () => ctxTmux,
      runTmux: noopTmux,
      runMuster: (_c, _a, input) => { musterCalls.push({ input }); return ""; },
    });
    await fire("session_start", { reason });
    assert.equal(JSON.parse(musterCalls[0].input).source, "resume", `reason ${reason} should map to source: resume`);
  }
});

test("session_start injects non-empty SessionStart stdout, triggering a turn only when it mentions unread mail", async () => {
  const { pi, fire, sent } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: noopTmux,
    runMuster: () => "muster: reconnected as 'pi-97' (revived) — 2 unread thread(s); call get_inbox with alias 'pi-97'",
  });
  await fire("session_start", { reason: "resume" });
  assert.equal(sent.length, 1);
  assert.match(String((sent[0].message as { content: string }).content), /unread/);
  assert.deepEqual(sent[0].options, { triggerTurn: true });
});

test("session_start does not inject when SessionStart stdout is empty", async () => {
  const { pi, fire, sent } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux, runTmux: noopTmux, runMuster: () => "" });
  await fire("session_start", { reason: "startup" });
  assert.deepEqual(sent, []);
});

test("session_start injects a plain registration line without triggering a turn", async () => {
  const { pi, fire, sent } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux, runTmux: noopTmux, runMuster: () => "muster: registered as 'pi-97'" });
  await fire("session_start", { reason: "startup" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].options, { triggerTurn: false });
});

test("turn_end writes the state file", async () => {
  const { pi, fire } = fakePi();
  const written: Array<{ pct: number; model: string }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    writeState: (o) => written.push({ pct: o.contextPct, model: o.model }),
    ringBell: noopBell,
  });
  await fire("turn_end", {});
  assert.deepEqual(written, [{ pct: 37, model: "Qwen3.8-27B" }]);
});

test("turn_end skips the write when getContextUsage returns undefined, but still rings the bell path", async () => {
  const { pi, fire } = fakePi();
  const written: unknown[] = [];
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux, writeState: (o) => written.push(o), ringBell: noopBell });
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "sess-1" },
    cwd: "/work/proj",
    model: { id: "Qwen3.8-27B" },
    getContextUsage: () => undefined,
    ui: { setStatus: () => {} },
  };
  await fire("turn_end", {}, ctx);
  assert.deepEqual(written, [], "an unknown usage must not fabricate a state write");
});

test("turn_end skips the write when percent is null (fresh post-compaction)", async () => {
  const { pi, fire } = fakePi();
  const written: unknown[] = [];
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux, writeState: (o) => written.push(o), ringBell: noopBell });
  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "sess-1" },
    cwd: "/work/proj",
    model: { id: "Qwen3.8-27B" },
    getContextUsage: () => ({ tokens: null, contextWindow: 32000, percent: null }),
    ui: { setStatus: () => {} },
  };
  await fire("turn_end", {}, ctx);
  assert.deepEqual(written, [], "a null percent must not be written as a fabricated 0");
});

// The state write and the bell are independent notifications that happen to
// share turn_end. A throw in getContextUsage/writeState (or a missing
// ctx.model) must not suppress the bell for that turn.
test("a throwing writeState does not suppress the bell", async () => {
  const { pi, fire } = fakePi();
  const bellCalls: unknown[] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    writeState: () => { throw new Error("disk full"); },
    ringBell: (ctx) => bellCalls.push(ctx),
  });
  await fire("turn_end", {});
  assert.equal(bellCalls.length, 1, "the bell must still ring when writeState throws");
});

test("the drain runs on agent_settled and NOT on turn_end", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: noopTmux,
    writeState: () => {},
    ringBell: noopBell,
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("turn_end", {});
  assert.ok(!musterCalls.some((c) => c.args[1] === "Stop"), "turn_end must not drain");
  await fire("agent_settled", {});
  assert.ok(musterCalls.some((c) => c.args[1] === "Stop"), "agent_settled must drain");
});

test("drain injects the block reason and passes stop_hook_active on the settle", async () => {
  const { pi, fire, sent } = fakePi();
  const inputs: string[] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runMuster: (_c, _a, input) => {
      inputs.push(input);
      return JSON.stringify({ decision: "block", reason: "You have 2 unread threads" });
    },
  });
  await fire("agent_settled", {});
  assert.equal(JSON.parse(inputs[0]).stop_hook_active, false);
  assert.equal(sent.length, 1);
  assert.equal((sent[0].message as { content: string }).content, "You have 2 unread threads");
  assert.deepEqual(sent[0].options, { triggerTurn: true });
});

// This is the assertion the drain-loop guard exists for: injecting a reason
// starts a turn, which produces another settle. Without tracking that WE
// triggered it, that settle re-drains, sees the same unread mail, and
// injects again — forever, for as long as mail stays unread. Two consecutive
// settles with mail waiting must call drain twice, pass stop_hook_active:
// true on the second, and inject exactly once.
test("the loop guard: two consecutive settles with mail waiting drain twice but inject only once", async () => {
  const { pi, fire, sent } = fakePi();
  const inputs: string[] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runMuster: (_c, _a, input) => {
      inputs.push(input);
      return JSON.stringify({ decision: "block", reason: "You have 2 unread threads" });
    },
  });
  await fire("agent_settled", {});
  await fire("agent_settled", {});
  assert.equal(inputs.length, 2, "drain must be called on every settle");
  assert.equal(JSON.parse(inputs[0]).stop_hook_active, false, "first settle: we did not just trigger it");
  assert.equal(JSON.parse(inputs[1]).stop_hook_active, true, "second settle: we triggered it via injection");
  assert.equal(sent.length, 1, "must inject exactly once, not once per settle");
});

test("the loop guard resets once mail clears: a third settle with no reason re-arms it", async () => {
  const { pi, fire, sent } = fakePi();
  let call = 0;
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runMuster: () => {
      call += 1;
      // Mail waiting for the first two settles, then cleared.
      if (call <= 2) return JSON.stringify({ decision: "block", reason: "You have 2 unread threads" });
      return "";
    },
  });
  await fire("agent_settled", {}); // injects, flag -> true
  await fire("agent_settled", {}); // flag true, still reason present -> skip, flag -> false
  await fire("agent_settled", {}); // no reason -> nothing to inject regardless
  assert.equal(sent.length, 1);
});

test("session_info_changed renames tmux and calls become with --no-inject", async () => {
  const { pi, fire } = fakePi();
  const tmuxCalls: string[][] = [];
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, a) => { tmuxCalls.push(a); return undefined; },
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: "new-name" });
  assert.ok(tmuxCalls.some((a) => a[0] === "rename-session"), "expected a tmux rename");
  const becomeCall = musterCalls.find((c) => c.args[0] === "become");
  assert.deepEqual(becomeCall?.args, ["become", "new-name", "--no-inject"]);
});

test("a bare /name keeps the session's project prefix, like prefix T", async () => {
  const { pi, fire } = fakePi();
  const tmuxCalls: string[][] = [];
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, a) => {
      tmuxCalls.push(a);
      return a[0] === "display-message" ? "proj/old-work" : undefined;
    },
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: "new-work" });
  const rename = tmuxCalls.find((a) => a[0] === "rename-session");
  assert.ok(rename?.includes("proj/new-work"), `expected proj/new-work, got ${JSON.stringify(rename)}`);
  const becomeCall = musterCalls.find((c) => c.args[0] === "become");
  assert.deepEqual(becomeCall?.args, ["become", "proj/new-work", "--no-inject"]);
});

test("a /name carrying '/' is taken verbatim: the re-homing escape hatch", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, a) => (a[0] === "display-message" ? "proj/old-work" : undefined),
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: "other/work" });
  const becomeCall = musterCalls.find((c) => c.args[0] === "become");
  assert.deepEqual(becomeCall?.args, ["become", "other/work", "--no-inject"]);
});

test("muster's prefixed /name echo does not round-trip a second become", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, a) => (a[0] === "display-message" ? "proj/old-work" : undefined),
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: "new-work" });
  await fire("session_info_changed", { name: "proj/new-work" });
  const becomeCalls = musterCalls.filter((c) => c.args[0] === "become");
  assert.equal(becomeCalls.length, 1, "the composed-name echo must be recognized as our own rename");
});

test("a cleared name renames nothing rather than claiming an empty alias", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: undefined });
  assert.ok(!musterCalls.some((c) => c.args[0] === "become"), "an empty name must not become");
});

test("repeating the same name is a no-op: only the first occurrence renames and becomes", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  const tmuxCalls: string[][] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: (_s, a) => { tmuxCalls.push(a); return undefined; },
    runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
  });
  await fire("session_info_changed", { name: "same-name" });
  await fire("session_info_changed", { name: "same-name" });
  const becomeCalls = musterCalls.filter((c) => c.args[0] === "become");
  const renameCalls = tmuxCalls.filter((a) => a[0] === "rename-session");
  assert.equal(becomeCalls.length, 1, "the outside-in echo must not round-trip a second become");
  assert.equal(renameCalls.length, 1);
});

test("a non-tui session is inert on every event: subagents and headless runs are guests, not pane owners", async () => {
  const { pi, fire } = fakePi();
  const calls: unknown[] = [];
  createHarness(pi as never, { raiseAttention: (c) => calls.push(c),
    tmux: () => ctxTmux,
    runTmux: (_s, a) => { calls.push(a); return undefined; },
    runMuster: (_c, a, i) => { calls.push({ a, i }); return ""; },
    writeState: (o) => calls.push(o),
    removeState: (c) => calls.push(c),
    ringBell: (c) => calls.push(c),
  });
  const subagentCtx = {
    mode: "print",
    sessionManager: { getSessionId: () => "sub-1" },
    cwd: "/work/proj",
    model: { id: "m" },
    getContextUsage: () => ({ tokens: 1, contextWindow: 2, percent: 50 }),
    ui: { setStatus: () => {} },
  };
  for (const e of ["session_start", "turn_end", "agent_settled", "session_info_changed", "session_shutdown"]) {
    await fire(e, { name: "Explore#deadbeef", reason: "quit" }, subagentCtx);
  }
  assert.deepEqual(calls, [], "a print-mode session must not touch the pane's tmux name, bus row, or state file");
});

test("session_shutdown removes the state file and calls the SessionEnd hook", async () => {
  const { pi, fire } = fakePi();
  const removed: unknown[] = [];
  const musterCalls: Array<{ args: string[]; input: string }> = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    removeState: (c) => removed.push(c),
    runMuster: (_c, args, input) => { musterCalls.push({ args, input }); return ""; },
  });
  await fire("session_shutdown", {});
  assert.equal(removed.length, 1);
  const hookCall = musterCalls.find((c) => c.args[1] === "SessionEnd");
  assert.ok(hookCall, "expected a hook SessionEnd pi call");
  assert.deepEqual(JSON.parse(hookCall.input), { session_id: "sess-1" });
});

test("outside tmux every handler is inert and none throws", async () => {
  const { pi, fire } = fakePi();
  const calls: unknown[] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => undefined,
    runTmux: (_s, a) => { calls.push(a); return undefined; },
    runMuster: (_c, a, i) => { calls.push({ a, i }); return ""; },
    writeState: (o) => calls.push(o),
    removeState: (c) => calls.push(c),
  });
  for (const e of ["session_start", "turn_end", "agent_settled", "session_info_changed", "session_shutdown"]) {
    await fire(e, { name: "x" });
  }
  assert.deepEqual(calls, [], "nothing pane-scoped may run without a pane");
});

test("a throwing handler dependency never escapes into pi", async () => {
  const { pi, fire } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: () => { throw new Error("no tmux"); },
    writeState: () => { throw new Error("disk full"); },
    ringBell: () => { throw new Error("no tty"); },
    removeState: () => { throw new Error("gone"); },
    runMuster: () => { throw new Error("no muster"); },
  });
  for (const e of ["session_start", "turn_end", "agent_settled", "session_info_changed", "session_shutdown"]) {
    await fire(e, { name: "x" });
  }
});

// F1: a settled agent with no queued continuation is a pane waiting on input.
// Acceptance #4 — waiting on input raises the SwiftBar attention item — is
// unmet unless agent_settled raises it.
test("agent_settled raises the SwiftBar attention item with the tmux context", async () => {
  const { pi, fire } = fakePi();
  const raised: unknown[] = [];
  createHarness(pi as never, {
    tmux: () => ctxTmux,
    raiseAttention: (c) => raised.push(c),
    runMuster: () => "",
  });
  await fire("agent_settled", {});
  assert.deepEqual(raised, [ctxTmux], "a settled agent is waiting on input; raise attention");
});

// F4 (RED-first): the state file is the liveness signal. If the session-id read
// throws — a torn-down ctx during quit — removeState must already have run, or
// the bar shows a dead session until the reader's 7-day backstop.
test("session_shutdown removes the state file even when the session-id read throws", async () => {
  const { pi, fire } = fakePi();
  const removed: unknown[] = [];
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    removeState: (c) => removed.push(c),
    runMuster: () => "",
  });
  const brokenCtx = {
    mode: "tui",
    sessionManager: { getSessionId: () => { throw new Error("ctx torn down"); } },
  };
  await fire("session_shutdown", {}, brokenCtx);
  assert.equal(removed.length, 1, "removeState must run before the session-id read, not after");
});

// F5 (RED-first): a resume with unread mail injects on session_start (triggering
// a turn); the settle that turn produces must NOT re-inject the same mail as a
// drain block reason. One resume, one post.
test("a resume with unread mail then a settle injects exactly once, not twice", async () => {
  const { pi, fire, sent } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell,
    tmux: () => ctxTmux,
    runTmux: noopTmux,
    runMuster: (_c, args) => {
      if (args[1] === "SessionStart") return "muster: reconnected as 'pi-97' — 2 unread thread(s)";
      if (args[1] === "Stop") return JSON.stringify({ decision: "block", reason: "You have 2 unread threads" });
      return "";
    },
  });
  await fire("session_start", { reason: "resume" });
  await fire("agent_settled", {});
  assert.equal(sent.length, 1, "one resume with mail must post exactly once, not once per turn");
  assert.deepEqual(sent[0].options, { triggerTurn: true }, "the single post is the session_start injection");
});

// A rename fires become() to claim the new alias live; if a reload or switch
// then fires session_shutdown, tombstoning on that non-quit reason races the
// become and leaves both the old and new aliases departed (live galley
// trial). Only a real quit ends the conversation on the bus.
test("session_shutdown tombstones and drops state ONLY on reason quit", async () => {
  const { pi, fire } = fakePi();
  const musterCalls: Array<{ args: string[] }> = [];
  const removed: unknown[] = [];
  const mk = () =>
    createHarness(pi as never, {
      raiseAttention: noopBell,
      tmux: () => ctxTmux,
      runTmux: noopTmux,
      writeState: () => {},
      ringBell: noopBell,
      removeState: (ctx) => removed.push(ctx),
      runMuster: (_c, args) => { musterCalls.push({ args }); return ""; },
    });

  mk();
  for (const reason of ["reload", "new", "resume", "fork"]) {
    musterCalls.length = 0;
    removed.length = 0;
    await fire("session_shutdown", { reason });
    assert.ok(
      !musterCalls.some((c) => c.args[1] === "SessionEnd"),
      `reason ${reason} must NOT tombstone`,
    );
    assert.equal(removed.length, 0, `reason ${reason} must NOT drop the state file`);
  }

  musterCalls.length = 0;
  removed.length = 0;
  await fire("session_shutdown", { reason: "quit" });
  assert.ok(
    musterCalls.some((c) => c.args[1] === "SessionEnd"),
    "reason quit must tombstone",
  );
  assert.equal(removed.length, 1, "reason quit must drop the state file");
});

test("a permission ui_prompt rings the bell and raises the permission flag", async () => {
  const { pi, fire, fireBus } = fakePi();
  const bells: unknown[] = [];
  const perms: string[] = [];
  createHarness(pi as never, {
    tmux: () => ctxTmux,
    raiseAttention: noopBell,
    ringBell: (c) => bells.push(c),
    raisePermissionAttention: () => perms.push("raise"),
    clearPermissionAttention: () => perms.push("clear"),
  });
  await fire("session_start", { reason: "startup" });
  await fireBus("permissions:ui_prompt", { requestId: "req-1", surface: "bash", value: "rm -rf x" });
  assert.equal(bells.length, 1, "prompt must ring the bell");
  assert.deepEqual(perms, ["raise"]);
});

test("the matching decision clears the permission flag; a stray one does not", async () => {
  const { pi, fire, fireBus } = fakePi();
  const perms: string[] = [];
  createHarness(pi as never, {
    tmux: () => ctxTmux,
    raiseAttention: noopBell,
    ringBell: noopBell,
    raisePermissionAttention: () => perms.push("raise"),
    clearPermissionAttention: () => perms.push("clear"),
  });
  await fire("session_start", { reason: "startup" });
  await fireBus("permissions:ui_prompt", { requestId: "req-1" });
  await fireBus("permissions:decision", { requestId: "other", result: "allow" });
  assert.deepEqual(perms, ["raise"], "an unrelated decision must not clear the flag");
  await fireBus("permissions:decision", { requestId: "req-1", result: "allow" });
  assert.deepEqual(perms, ["raise", "clear"], "the resolving decision clears the flag");
});

test("a subagent node (never owned the pane) ignores permission prompts", async () => {
  const { pi, fire, fireBus, ctx } = fakePi();
  const perms: string[] = [];
  const bells: unknown[] = [];
  createHarness(pi as never, {
    tmux: () => ctxTmux,
    raiseAttention: noopBell,
    ringBell: (c) => bells.push(c),
    raisePermissionAttention: () => perms.push("raise"),
    clearPermissionAttention: () => perms.push("clear"),
  });
  await fire("session_start", { reason: "startup" }, { ...ctx, mode: "print" });
  await fireBus("permissions:ui_prompt", { requestId: "req-1" });
  assert.deepEqual(perms, [], "a non-owning node must not raise the flag");
  assert.deepEqual(bells, [], "a non-owning node must not ring");
});

test("it subscribes to exactly the pi.events channels it needs", async () => {
  const { pi, busEvents } = fakePi();
  createHarness(pi as never, { raiseAttention: noopBell, tmux: () => ctxTmux });
  assert.deepEqual(
    busEvents().sort(),
    ["permissions:decision", "permissions:ui_prompt"].sort(),
  );
});
