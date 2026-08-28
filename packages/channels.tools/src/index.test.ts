import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { createExtension } from "./index.ts";

const FAKE = join(import.meta.dirname, "..", "test", "fake-channel-server.ts");
const FLAKY = join(import.meta.dirname, "..", "test", "flaky-channel-server.ts");

type Handler = (event: unknown, ctx: unknown) => unknown;

type ToolDef = { name: string; execute(id: string, params: unknown): Promise<unknown> };

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const sent: Array<{ msg: unknown; opts: unknown }> = [];
  const customs: Array<{ msg: unknown; opts: unknown }> = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const tools = new Map<string, ToolDef>();
  const statuses: string[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage(content: unknown, opts: unknown) { sent.push({ msg: content, opts }); },
    sendMessage(message: unknown, opts: unknown) { customs.push({ msg: message, opts }); },
    registerTool(def: ToolDef) { registered.push(def.name); tools.set(def.name, def); },
    unregisterTool(name: string) { unregistered.push(name); tools.delete(name); },
    getAllTools() { return [{ name: "bash" }, { name: "read" }]; },
    getActiveTools() { return ["bash", "read"]; },
    setActiveTools(_names: string[]) {},
  };
  const ctx = {
    sessionManager: { getSessionId: () => "session-xyz" },
    ui: { setStatus: (_k: string, v?: string) => { statuses.push(v ?? ""); } },
    hasUI: true,
    cwd: process.cwd(),
  };
  async function fire(event: string, payload: unknown = {}): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, ctx));
    return out;
  }
  return { pi, ctx, fire, sent, customs, registered, unregistered, tools, statuses };
}

test("session_start sets AGENT_SESSION_ID before any server is spawned", async () => {
  const { pi, fire } = fakePi();
  const spawnOrder: string[] = [];
  const env: NodeJS.ProcessEnv = {};
  createExtension(pi as never, {
    env,
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE] } }),
    onBeforeSpawn: () => { spawnOrder.push(`env=${env.AGENT_SESSION_ID ?? "unset"}`); },
  });
  await fire("session_start", { reason: "startup" });
  assert.deepEqual(spawnOrder, ["env=session-xyz"],
    "identity must be set before spawn: galley channel reads it at its own startup");
  // session_start's connectAll() spawns and fully handshakes the fake server;
  // leaving it open here leaks the child process and hangs node --test.
  await fire("session_shutdown");
});

test("an inbound event delivers a hidden envelope plus a visible summary line", async () => {
  const { pi, fire, sent, customs } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE], env: { FAKE_PUSH_AFTER_MS: "50" } } }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 500));
  // The envelope rides a hidden custom message queued for the next turn —
  // pi injects the nextTurn queue before before_agent_start fires.
  assert.equal(customs.length, 1);
  const custom = customs[0].msg as { customType: string; content: string; display: boolean };
  assert.equal(custom.customType, "channel-envelope");
  assert.equal(custom.display, false);
  assert.match(custom.content, /<channel source="fake"/);
  assert.equal((customs[0].opts as { deliverAs?: string }).deliverAs, "nextTurn");
  // The visible user message is the short summary — no raw XML — and it is
  // what triggers the turn through the full prompt pipeline.
  assert.equal(sent.length, 1);
  const opts = sent[0].opts as { deliverAs?: string };
  assert.equal(opts.deliverAs, "steer");
  const text = sent[0].msg as string;
  assert.doesNotMatch(text, /<channel/);
  await fire("session_shutdown");
});

test("a server's tools are registered under their own names", async () => {
  const { pi, fire, registered } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE] } }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(registered.includes("fake_status"), `registered: ${registered.join(", ")}`);
  await fire("session_shutdown");
});

test("before_agent_start injects the connected server's instructions", async () => {
  const { pi, fire } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE] } }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  const results = await fire("before_agent_start", { systemPrompt: "BASE PROMPT" });
  const returned = results.find((r): r is { systemPrompt: string } =>
    typeof r === "object" && r !== null && "systemPrompt" in r);
  assert.ok(returned, "before_agent_start must return a modified systemPrompt");
  assert.match(returned.systemPrompt, /BASE PROMPT/);
  assert.match(returned.systemPrompt, /FAKE CORE INSTRUCTIONS/);
  await fire("session_shutdown");
});

test("before_agent_start returns undefined when nothing is connected", async () => {
  const { pi, fire } = fakePi();
  createExtension(pi as never, { env: {}, loadConfig: () => ({}) });
  await fire("session_start", { reason: "startup" });
  const results = await fire("before_agent_start", { systemPrompt: "BASE PROMPT" });
  assert.deepEqual(results, [undefined]);
  await fire("session_shutdown");
});

test("session_shutdown closes connections and clears status", async () => {
  const { pi, fire, statuses } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE] } }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  await fire("session_shutdown");
  assert.equal(statuses.at(-1), "");
});

test("a tool still works after a resume re-registers it against a fresh connection", async () => {
  const { pi, fire, tools } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({ fake: { command: process.execPath, args: [FAKE] } }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  // Simulate a resume: session_start fires again, connectAll() closes the
  // first connection's client and spawns a fresh one. A stale registration
  // guard would leave the tool's execute() bound to the now-closed client.
  await fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 300));
  const tool = tools.get("fake_status");
  assert.ok(tool, "fake_status must still be registered after resume");
  const result = (await tool.execute("call-1", {})) as { content: Array<{ text: string }> };
  assert.deepEqual(result.content, [{ type: "text", text: "fake ok" }]);
  await fire("session_shutdown");
});

test("a tool result with isError:true is signaled by throwing, not returned silently", async () => {
  const { pi, fire, tools } = fakePi();
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({
      fake: { command: process.execPath, args: [FAKE], env: { FAKE_TOOL_ISERROR: "1" } },
    }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  const tool = tools.get("fake_status");
  assert.ok(tool, "fake_status must be registered");
  await assert.rejects(() => tool!.execute("call-1", {}), /FAKE TOOL ERROR TEXT/);
  await fire("session_shutdown");
});

test("a retry that lands before connectAll resolves does not have its tools dropped as stale", async () => {
  // The race F1's own fix created: `fake` fails, schedules a 50ms retry, and
  // reconnects while `slow` is still handshaking. onConnected registers
  // fake_status. Then session_start's own registerTools() runs — and if it
  // registers from connectAll's returned array (which cannot contain `fake`,
  // whose first attempt failed) instead of manager.connections(), it treats
  // fake_status as stale and unregisters it. The channel is live, its
  // instructions are injected, its events wake the agent, and its tool is gone
  // for the rest of the session with no further retry scheduled.
  const { pi, fire, tools, unregistered } = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-channels-race-"));
  const counterFile = join(dir, "count.txt");
  try {
    createExtension(pi as never, {
      env: {},
      loadConfig: () => ({
        fake: { command: process.execPath, args: [FLAKY], env: { FLAKY_COUNTER_FILE: counterFile } },
        // A DISTINCT tool name is essential: if both servers advertised
        // fake_status, the stale computation would never drop it and this test
        // would pass against the buggy code.
        slow: {
          command: process.execPath,
          args: [FAKE],
          env: { FAKE_INIT_DELAY_MS: "400", FAKE_TOOL_NAME: "slow_status" },
        },
      }),
      retryBaseMs: 50,
      retryMaxMs: 50,
    });
    // session_start does not resolve until `slow` finishes its 400ms handshake,
    // so the 50ms retry lands squarely inside it.
    await fire("session_start", { reason: "startup" });
    assert.ok(
      tools.has("fake_status"),
      `fake_status must survive session_start's registerTools; unregistered: ${unregistered.join(", ")}`,
    );
    assert.ok(
      !unregistered.includes("fake_status"),
      "fake_status must not be treated as stale — the retry had already registered it",
    );
    const tool = tools.get("fake_status");
    const result = (await tool!.execute("call-1", {})) as { content: Array<{ text: string }> };
    assert.deepEqual(result.content, [{ type: "text", text: "fake ok" }], "the surviving tool must still work");
  } finally {
    // In the finally, not after the assertions: a failing assertion would
    // otherwise skip it and leave the channels open, hanging the test runner.
    await fire("session_shutdown");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a channel that reconnects via retry gets its tools re-registered (F1)", async () => {
  const { pi, fire, tools } = fakePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-channels-flaky-"));
  const counterFile = join(dir, "count.txt");
  try {
    createExtension(pi as never, {
      env: {},
      loadConfig: () => ({
        fake: { command: process.execPath, args: [FLAKY], env: { FLAKY_COUNTER_FILE: counterFile } },
      }),
      retryBaseMs: 50,
      retryMaxMs: 50,
    });
    await fire("session_start", { reason: "startup" });
    // The first attempt dies mid-handshake, so session_start's own
    // registerTools() call runs with zero connections — this is the state
    // pre-fix leaves the channel in forever.
    assert.ok(!tools.has("fake_status"), "the first (failed) attempt must not have registered anything yet");
    // 50ms later the retry connects for real.
    await new Promise((r) => setTimeout(r, 500));
    const tool = tools.get("fake_status");
    assert.ok(tool, "fake_status must be registered once the retry reconnects");
    const result = (await tool!.execute("call-1", {})) as { content: Array<{ text: string }> };
    assert.deepEqual(result.content, [{ type: "text", text: "fake ok" }]);
    await fire("session_shutdown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale tools are dropped from the active set when unregisterTool is unavailable (F5)", async () => {
  const { pi, fire, tools } = fakePi();
  (pi as { unregisterTool?: unknown }).unregisterTool = undefined;
  const activeToolsCalls: string[][] = [];
  pi.getActiveTools = () => ["bash", "read", "fake_status"];
  pi.setActiveTools = (names: string[]) => { activeToolsCalls.push(names); };
  let channelConfigured = true;
  createExtension(pi as never, {
    env: {},
    loadConfig: (): Record<string, import("./config.ts").ChannelServerDef> =>
      channelConfigured ? { fake: { command: process.execPath, args: [FAKE] } } : {},
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(tools.has("fake_status"));
  // Simulate a resume where the channel is no longer configured: connectAll
  // tears down the old connection and there is nothing left to register, so
  // "fake_status" is now stale.
  channelConfigured = false;
  await fire("session_start", { reason: "resume" });
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(
    activeToolsCalls.some((names) => !names.includes("fake_status")),
    `expected setActiveTools to be called without fake_status, got: ${JSON.stringify(activeToolsCalls)}`,
  );
  await fire("session_shutdown");
});

test("a registerTool failure during session_start does not block the mail gate from opening", async () => {
  const { pi, fire, sent } = fakePi();
  pi.registerTool = () => {
    throw new Error("boom: registerTool exploded");
  };
  createExtension(pi as never, {
    env: {},
    loadConfig: () => ({
      fake: { command: process.execPath, args: [FAKE], env: { FAKE_PUSH_AFTER_MS: "50" } },
    }),
  });
  await fire("session_start", { reason: "startup" });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(sent.length, 1,
    "mail must still be delivered even though session_start's registerTool step threw");
  await fire("session_shutdown");
});
