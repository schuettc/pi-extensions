// Guards: a daemon frame split across two socket chunks must not be parsed as one, or the phone sees garbled events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeLine, decodeLine, splitFrames } from "./protocol.ts";

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
