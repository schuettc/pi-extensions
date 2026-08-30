import { test } from "node:test";
import assert from "node:assert/strict";
import { decideMetered } from "./gate.ts";

const bridge = { provider: "claude-bridge", id: "opus" };
const metered = { provider: "anthropic", id: "claude-opus" };

test("selecting the metered anthropic provider reverts to the previous safe model", () => {
  const d = decideMetered({ selected: metered, previous: bridge, override: false, defaultSafe: bridge });
  assert.deepEqual(d?.revertTo, bridge);
  assert.match(d!.reason, /metered|extra usage/i);
});

test("with no safe previous, it reverts to the default safe model", () => {
  const d = decideMetered({ selected: metered, previous: metered, override: false, defaultSafe: bridge });
  assert.deepEqual(d?.revertTo, bridge);
});

test("a safe selection is not reverted", () => {
  assert.equal(decideMetered({ selected: bridge, previous: metered, override: false, defaultSafe: bridge }), undefined);
});

test("the override lets the metered provider through", () => {
  assert.equal(decideMetered({ selected: metered, previous: bridge, override: true, defaultSafe: bridge }), undefined);
});

test("reverting to a safe model never itself asks for a revert (no loop)", () => {
  // The value the gate reverts TO must be safe, so a model_select for it decides undefined.
  const d = decideMetered({ selected: metered, previous: bridge, override: false, defaultSafe: bridge });
  assert.equal(decideMetered({ selected: d!.revertTo, previous: metered, override: false, defaultSafe: bridge }), undefined);
});
