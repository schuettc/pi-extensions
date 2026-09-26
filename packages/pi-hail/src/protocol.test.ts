// Guards: a daemon frame split across two socket chunks must not be parsed as one, or the phone sees garbled events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeLine, decodeLine, splitFrames } from "./protocol.ts";
import type { Outbound } from "./protocol.ts";

// T2.3 — the askDone outcome is allowed|denied only; `deferred` is gone from
// the wire (one dialog, nothing to defer to). This is a type-level guard: the
// ts-expect-error directive below typechecks ONLY once `deferred` is no longer
// a member of the union.
test("askDone outcome union is allowed|denied only (no deferred)", () => {
  const allowed: Outbound = { askDone: { requestId: "r", outcome: "allowed", by: "mac" } };
  const denied: Outbound = { askDone: { requestId: "r", outcome: "denied", by: "phone" } };
  assert.ok(allowed && denied);
  const bad: Outbound = {
    // @ts-expect-error `deferred` is no longer a valid askDone outcome
    askDone: { requestId: "r", outcome: "deferred", by: "mac" },
  };
  assert.ok(bad);
});

test("encodeLine appends exactly one newline and round-trips", () => {
  const s = encodeLine({ turn: "start" });
  assert.equal(s, '{"turn":"start"}\n');
  assert.deepEqual(decodeLine(s.trimEnd()), { turn: "start" });
});

test("splitFrames keeps a partial trailing line as rest", () => {
  const { lines, rest } = splitFrames('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  assert.equal(rest, '{"c":');
});

test("splitFrames returns no lines when no newline present", () => {
  const { lines, rest } = splitFrames('{"partial":');
  assert.deepEqual(lines, []);
  assert.equal(rest, '{"partial":');
});
