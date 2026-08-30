import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuardrails } from "./index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const setModelCalls: unknown[] = [];
  let setModelImpl: (model: unknown) => unknown = (model) => {
    setModelCalls.push(model);
    return true;
  };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async setModel(model: unknown) {
      return setModelImpl(model);
    },
    setSetModelImpl(fn: (model: unknown) => unknown) {
      setModelImpl = fn;
    },
  };
  const notifications: Array<{ message: string; level: string }> = [];
  const registry = new Map<string, { provider: string; id: string }>();
  function registerModel(provider: string, id: string) {
    registry.set(`${provider}/${id}`, { provider, id });
  }
  const ctx = {
    model: { provider: "llama.cpp", id: "qwen3-coder" },
    ui: {
      notify: (message: string, level: string) => notifications.push({ message, level }),
    },
    modelRegistry: {
      find: (provider: string, id: string) => registry.get(`${provider}/${id}`),
    },
  };
  async function fire(event: string, payload: unknown = {}, overrideCtx?: unknown) {
    const out: unknown[] = [];
    for (const h of handlers.get(event) ?? []) out.push(await h(payload, overrideCtx ?? ctx));
    return out;
  }
  return { pi, ctx, fire, events: () => [...handlers.keys()], notifications, setModelCalls, registerModel };
}

test("model_select onto anthropic with no override reverts and notifies", async () => {
  const { pi, ctx, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.deepEqual(setModelCalls, [{ provider: "llama.cpp", id: "qwen3-coder" }]);
});

test("model_select onto a safe provider does not revert", async () => {
  const { pi, ctx, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "llama.cpp", id: "qwen3-coder" },
    previousModel: undefined,
    source: "set",
  });
  assert.equal(notifications.length, 0);
  assert.deepEqual(setModelCalls, []);
});

test("override env truthy skips the revert even onto anthropic", async () => {
  const { pi, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: { PI_ALLOW_METERED_ANTHROPIC: "1" } });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.equal(notifications.length, 0);
  assert.deepEqual(setModelCalls, []);
});

test("defaultSafe guard: a session captured on anthropic never becomes the revert target", async () => {
  const { pi, ctx, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("anthropic", "claude-opus-4");
  createGuardrails(pi as never, { env: {} });
  // Simulate an (impossible-by-design) session_start captured while on the
  // metered provider: defaultSafe must not be set from it.
  const anthropicCtx = { ...ctx, model: { provider: "anthropic", id: "claude-opus-4" } };
  await fire("session_start", { reason: "startup" }, anthropicCtx);
  // Now a metered selection with no safe previous model: the gate has no
  // safe defaultSafe to fall back to and must never revert TO anthropic.
  await fire(
    "model_select",
    {
      model: { provider: "anthropic", id: "claude-opus-4-again" },
      previousModel: undefined,
      source: "set",
    },
    anthropicCtx,
  );
  const revertedToMetered = setModelCalls.some((m: any) => m?.provider === "anthropic");
  assert.equal(revertedToMetered, false, "must never revert to a metered model");
});

test("before_agent_start appends the injected prose to the base prompt", async () => {
  const { pi, fire } = fakePi();
  createGuardrails(pi as never, { env: {}, loadProse: () => ["X"] });
  const results = await fire("before_agent_start", { systemPrompt: "base prompt text" });
  const result = results[0] as { systemPrompt: string };
  assert.match(result.systemPrompt, /base prompt text/);
  assert.match(result.systemPrompt, /\bX\b/);
});

test("before_agent_start leaves the system prompt unchanged when loadProse returns empty", async () => {
  const { pi, fire } = fakePi();
  createGuardrails(pi as never, { env: {}, loadProse: () => [] });
  const results = await fire("before_agent_start", { systemPrompt: "base prompt text" });
  const result = results[0] as { systemPrompt: string };
  assert.equal(result.systemPrompt, "base prompt text");
});

test("a throwing setModel does not escape the model_select handler", async () => {
  const { pi, fire, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  pi.setSetModelImpl(() => {
    throw new Error("registry exploded");
  });
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await assert.doesNotReject(
    fire("model_select", {
      model: { provider: "anthropic", id: "claude-opus-4" },
      previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
      source: "set",
    }),
  );
});

test("a successful revert notifies success (warning) and does not notify an error", async () => {
  const { pi, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.deepEqual(setModelCalls, [{ provider: "llama.cpp", id: "qwen3-coder" }]);
  assert.equal(notifications.length, 1, "exactly one notify: the success warning");
  assert.equal(notifications[0].level, "warning");
});

test("a registry miss on the revert target notifies an error, not a false success, and does not throw", async () => {
  const { pi, fire, notifications, setModelCalls } = fakePi();
  // Deliberately do NOT registerModel("llama.cpp", "qwen3-coder") — the
  // registry lookup misses, so the revert cannot actually happen.
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await assert.doesNotReject(
    fire("model_select", {
      model: { provider: "anthropic", id: "claude-opus-4" },
      previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
      source: "set",
    }),
  );
  assert.deepEqual(setModelCalls, [], "setModel must not be called when the registry misses");
  assert.equal(notifications.length, 1, "exactly one notify: the failure error");
  assert.equal(notifications[0].level, "error");
  assert.match(notifications[0].message, /anthropic/);
});

test("a throwing setModel notifies an error, not a false success", async () => {
  const { pi, fire, notifications, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  pi.setSetModelImpl(() => {
    throw new Error("registry exploded");
  });
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.equal(notifications.length, 1, "exactly one notify: the failure error");
  assert.equal(notifications[0].level, "error");
});

test("a falsy setModel result (no API key) notifies an error, not a false success", async () => {
  const { pi, fire, notifications, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  pi.setSetModelImpl(() => false);
  createGuardrails(pi as never, { env: {} });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.equal(notifications.length, 1, "exactly one notify: the failure error");
  assert.equal(notifications[0].level, "error");
});

test("before_agent_start: a throwing appendPolicy returns the original prompt untouched and does not throw", async () => {
  const { pi, fire } = fakePi();
  createGuardrails(pi as never, {
    env: {},
    loadProse: () => ["X"],
    appendPolicy: () => {
      throw new Error("prose exploded");
    },
  });
  const results = await fire("before_agent_start", { systemPrompt: "base prompt text" });
  const result = results[0] as { systemPrompt: string };
  assert.equal(result.systemPrompt, "base prompt text");
});

test("it subscribes to exactly the lifecycle events it needs", async () => {
  const { pi, events } = fakePi();
  createGuardrails(pi as never, { env: {} });
  assert.deepEqual(
    events().sort(),
    ["before_agent_start", "model_select", "session_start"].sort(),
  );
});

test("override env must be exactly '1': PI_ALLOW_METERED_ANTHROPIC=0 still reverts", async () => {
  const { pi, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: { PI_ALLOW_METERED_ANTHROPIC: "0" } });
  await fire("session_start", { reason: "startup" });
  await fire("model_select", {
    model: { provider: "anthropic", id: "claude-opus-4" },
    previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
    source: "set",
  });
  assert.deepEqual(
    setModelCalls,
    [{ provider: "llama.cpp", id: "qwen3-coder" }],
    "=0 must not read as an override",
  );
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("defaultSafe unset + safe previousModel: reverts to previousModel", async () => {
  const { pi, ctx, fire, notifications, setModelCalls, registerModel } = fakePi();
  registerModel("llama.cpp", "qwen3-coder");
  createGuardrails(pi as never, { env: {} });
  // session_start on the metered provider leaves defaultSafe unset.
  const anthropicCtx = { ...ctx, model: { provider: "anthropic", id: "claude-opus-4" } };
  await fire("session_start", { reason: "startup" }, anthropicCtx);
  notifications.length = 0; // drop the session_start warning
  await fire(
    "model_select",
    {
      model: { provider: "anthropic", id: "claude-opus-4" },
      previousModel: { provider: "llama.cpp", id: "qwen3-coder" },
      source: "set",
    },
    anthropicCtx,
  );
  assert.deepEqual(setModelCalls, [{ provider: "llama.cpp", id: "qwen3-coder" }]);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
});

test("defaultSafe unset + no safe target: notifies, never calls setModel, never throws", async () => {
  const { pi, ctx, fire, notifications, setModelCalls } = fakePi();
  createGuardrails(pi as never, { env: {} });
  const anthropicCtx = { ...ctx, model: { provider: "anthropic", id: "claude-opus-4" } };
  await fire("session_start", { reason: "startup" }, anthropicCtx);
  notifications.length = 0;
  await assert.doesNotReject(
    fire(
      "model_select",
      {
        model: { provider: "anthropic", id: "claude-opus-4-again" },
        previousModel: { provider: "anthropic", id: "claude-opus-4" },
        source: "set",
      },
      anthropicCtx,
    ),
  );
  assert.deepEqual(setModelCalls, [], "no safe target: setModel must never be called");
  assert.equal(notifications.length, 1, "the user must be told, not silently left on metered");
  assert.ok(["warning", "error"].includes(notifications[0].level));
  assert.match(notifications[0].message, /no safe revert target/);
});

test("session_start on the metered provider fires a warning notify", async () => {
  const { pi, ctx, fire, notifications } = fakePi();
  createGuardrails(pi as never, { env: {} });
  const anthropicCtx = { ...ctx, model: { provider: "anthropic", id: "claude-opus-4" } };
  await fire("session_start", { reason: "startup" }, anthropicCtx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "warning");
  assert.match(notifications[0].message, /no safe default captured/);
});
