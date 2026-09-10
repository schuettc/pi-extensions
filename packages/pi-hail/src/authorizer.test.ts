import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { Session } from "./session.ts";
import { createPhoneAuthorizer } from "./authorizer.ts";
import { fakeDeps } from "./test-helpers.ts";

/** A no-op AuthorizerLog stub — a link records a trail; the test ignores it. */
function fakeLog(): AuthorizerLog {
  return { review: () => {}, debug: () => {} };
}

/**
 * A deterministic clock over node:test's mock timers: `advance` fires the
 * authorizer's real setTimeout without waiting on wall-clock time.
 */
function fakeClock() {
  mock.timers.enable({ apis: ["setTimeout"] });
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
      mock.timers.tick(ms);
    },
    reset: () => mock.timers.reset(),
  };
}

// Guards: a phone-driven turn that hits a permission gate is NOT stuck — the phone's allow is applied as the verdict.
test("authorize returns allow when the phone answers allow during a phone turn", async () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.onInbound({ prompt: { text: "rm x", from: "p1", requestId: "r0" } });
  s.turnStart(); // phone_turn
  const auth = createPhoneAuthorizer({ session: s, timeoutMs: 1000 });
  const p = auth.authorize({ requestId: "r9" } as never, {} as never, fakeLog());
  s.onInbound({ answer: { requestId: "r9", value: "allow" } });
  assert.deepEqual(await p, { kind: "allow" });
});

// Guards: no phone answer in time falls back to pi's own prompt (defer) — a gate never hangs forever.
test("authorize defers on timeout", async () => {
  const clock = fakeClock();
  try {
    const s = new Session(fakeDeps());
    s.onInbound({ prompt: { text: "x", from: "p", requestId: "r1" } });
    s.turnStart();
    const auth = createPhoneAuthorizer({ session: s, timeoutMs: 10 });
    const p = auth.authorize({ requestId: "rX" } as never, {} as never, fakeLog());
    clock.advance(11);
    assert.deepEqual(await p, { kind: "defer" });
  } finally {
    clock.reset();
  }
});

// Guards: during a LOCAL turn pi-hail must not intercept — it defers so pi/pi-auto-review decide normally.
test("authorize defers immediately outside a phone turn", async () => {
  const s = new Session(fakeDeps());
  s.turnStart(); // local_turn
  const auth = createPhoneAuthorizer({ session: s, timeoutMs: 1000 });
  assert.deepEqual(await auth.authorize({ requestId: "r" } as never, {} as never, fakeLog()), {
    kind: "defer",
  });
});
