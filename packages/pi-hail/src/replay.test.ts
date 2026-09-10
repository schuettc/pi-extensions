import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionEvents } from "./replay.ts";

/** Write a JSONL fixture under os.tmpdir() and return its path plus a cleanup. */
function withFixture(lines: unknown[]): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-hail-replay-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Guards: after a daemon restart, the phone's event history has no hole — replay resumes exactly after the daemon's `have` cursor.
test("readSessionEvents returns only entries after the have cursor, in order", () => {
  const entries = [
    { type: "message_start", id: "m1" },
    { type: "message_end", id: "m1" },
    { type: "turn_start" },
    { type: "turn_end" },
  ];
  const { file, cleanup } = withFixture(entries);
  try {
    const out = readSessionEvents(file, 2);
    assert.deepEqual(out, [{ type: "turn_start" }, { type: "turn_end" }]);
  } finally {
    cleanup();
  }
});

// Guards: a `have` of 0 (daemon has nothing) replays the whole session; a `have` past the end replays nothing.
test("have=0 replays all; have>=len replays none", () => {
  const entries = [{ type: "a" }, { type: "b" }, { type: "c" }];
  const { file, cleanup } = withFixture(entries);
  try {
    assert.deepEqual(readSessionEvents(file, 0), entries);
    assert.deepEqual(readSessionEvents(file, 3), []);
    assert.deepEqual(readSessionEvents(file, 99), []);
  } finally {
    cleanup();
  }
});

// Guards: a missing/unreadable file must never throw and never block pi — replay is best-effort.
test("a missing file returns [] and never throws", () => {
  assert.deepEqual(readSessionEvents(join(tmpdir(), "pi-hail-does-not-exist-xyz.jsonl"), 0), []);
});

// Guards: a partially-corrupt session file yields the entries it could parse, not a crash.
test("a corrupt line is skipped, valid entries still returned", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-hail-replay-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, '{"type":"a"}\nnot json {{{\n{"type":"c"}\n', "utf8");
  try {
    const out = readSessionEvents(file, 0);
    assert.deepEqual(out, [{ type: "a" }, { type: "c" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
