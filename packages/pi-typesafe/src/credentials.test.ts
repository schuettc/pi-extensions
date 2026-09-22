import assert from "node:assert/strict";
import test from "node:test";
import { validateApiKey } from "./credentials.ts";

test("validateApiKey accepts a printable-ASCII key and trims it", () => {
  assert.deepEqual(validateApiKey("  ts_abc123  "), { ok: true, key: "ts_abc123" });
});

test("validateApiKey rejects empty, whitespace, control, and non-ASCII", () => {
  assert.equal(validateApiKey("").ok, false);
  assert.equal(validateApiKey("ts abc").ok, false);
  assert.equal(validateApiKey("ts\tabc").ok, false);
  assert.equal(validateApiKey("ts\u00e9").ok, false);
});

test("validateApiKey rejects an over-long key", () => {
  assert.equal(validateApiKey("a".repeat(4097)).ok, false);
});
