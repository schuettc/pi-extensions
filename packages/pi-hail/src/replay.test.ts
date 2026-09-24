import { test } from "node:test";
import assert from "node:assert/strict";
import { entriesAfter } from "./replay.ts";

// entriesAfter is a PURE helper over pi's in-memory entry list
// (sessionManager.getEntries()). The cursor unit is an index into that list.
// It maps each stored {"type":"message", message} entry AFTER `since` to a
// {"type":"message_end", message} event tagged with cursor = since + i + 1
// (i = the entry's index within the slice). Non-message entries are skipped
// but still consume a slice position.

test("entriesAfter maps message entries to message_end frames with cursor since+i+1", () => {
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "one" }] } },
    { type: "model_change" },
    { type: "message", message: { role: "toolResult", content: [] } },
  ];
  assert.deepEqual(entriesAfter(entries, 0), [
    {
      event: {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "one" }] },
      },
      cursor: 1,
    },
    { event: { type: "message_end", message: { role: "toolResult", content: [] } }, cursor: 3 },
  ]);
});

test("entriesAfter threads `since`: only entries after the cursor, with absolute cursors", () => {
  const entries = [
    { type: "message", message: { role: "assistant" } },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "assistant" } },
  ];
  assert.deepEqual(entriesAfter(entries, 2), [
    { event: { type: "message_end", message: { role: "assistant" } }, cursor: 3 },
  ]);
});

test("entriesAfter skips non-message entry types", () => {
  const entries = [{ type: "custom" }, { type: "compaction" }, { type: "session_info" }];
  assert.deepEqual(entriesAfter(entries, 0), []);
});

// Guards: pi's _flushPendingBashMessages persists {"type":"message",
// role:"bashExecution"} entries WITHOUT a message_end emit, so those never
// stream live. Replay must skip them (and other non-live roles) while they
// still occupy their slice index, so cursors stay each emitted entry's true
// position. Only user | assistant | toolResult | system roles replay.
test("entriesAfter replays only roles that stream live, skipping bashExecution while keeping the index", () => {
  const entries = [
    { type: "message", message: { role: "user" } }, // 0 (skipped by since=1)
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } }, // 1
    { type: "message", message: { role: "bashExecution", content: [] } }, // 2 (never live)
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "b" }] } }, // 3
  ];
  assert.deepEqual(entriesAfter(entries, 1), [
    {
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "a" }] } },
      cursor: 2,
    },
    {
      event: { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "b" }] } },
      cursor: 4,
    },
  ]);
});

test("entriesAfter past the end yields nothing", () => {
  assert.deepEqual(entriesAfter([{ type: "message", message: {} }], 5), []);
});
