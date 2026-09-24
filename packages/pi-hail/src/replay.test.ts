import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { readSessionEntriesAfter } from "./replay.ts";

function fixtureFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-hail-replay-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(JSON.parse(l))).join("\n") + "\n");
  return path;
}

test("reads entries after the cursor and maps message entries to message_end", () => {
  const path = fixtureFile([
    `{"type":"session"}`,
    `{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}`,
    `{"type":"model_change"}`,
    `{"type":"message","message":{"role":"toolResult","content":[]}}`,
  ]);
  const { events, cursor } = readSessionEntriesAfter(path, 1); // skip entry 1 (session)
  assert.equal(cursor, 4); // total entry count
  assert.deepEqual(events, [
    { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
    { type: "message_end", message: { role: "toolResult", content: [] } },
  ]);
});

test("skips non-message entry types", () => {
  const path = fixtureFile([
    `{"type":"custom"}`,
    `{"type":"compaction"}`,
    `{"type":"thinking_level_change"}`,
    `{"type":"session_info"}`,
  ]);
  const { events, cursor } = readSessionEntriesAfter(path, 0);
  assert.deepEqual(events, []);
  assert.equal(cursor, 4);
});

test("resend past the end yields no events", () => {
  const path = fixtureFile([`{"type":"message","message":{"role":"assistant"}}`]);
  const { events, cursor } = readSessionEntriesAfter(path, 5);
  assert.deepEqual(events, []);
  assert.equal(cursor, 1);
});

test("a missing file is best-effort empty", () => {
  const { events, cursor } = readSessionEntriesAfter("/no/such/file", 0);
  assert.deepEqual(events, []);
  assert.equal(cursor, 0);
});
