import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateKey, writeState, removeState } from "./state.ts";

const ctx = { socket: "proj-pi", pane: "%47" };

test("the key is socket plus pane without the percent", () => {
  assert.equal(stateKey(ctx), "proj-pi_47");
});

test("characters outside the safe set become underscores", () => {
  // The key becomes a filename, and a socket name is whatever the operator
  // called their project.
  assert.equal(stateKey({ socket: "proj/weird name", pane: "%3" }), "proj_weird_name_3");
});

test("writeState emits exactly the five keys the reader parses, in order", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-state-"));
  writeState({ ctx, contextPct: 42, model: "Qwen3.8-27B", dir });
  const body = readFileSync(join(dir, "proj-pi_47"), "utf-8");
  const keys = body.trim().split("\n").map((l) => l.split("=")[0]);
  assert.deepEqual(keys, ["context_pct", "model", "updated", "pane", "socket"]);
  assert.match(body, /^context_pct=42$/m);
  assert.match(body, /^model=Qwen3\.8-27B$/m);
  assert.match(body, /^pane=%47$/m);
  assert.match(body, /^socket=proj-pi$/m);
  assert.match(body, /^updated=\d{10}$/m);
});

test("context_pct is written as an integer, never a float", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-state-"));
  writeState({ ctx, contextPct: 42.7, model: "m", dir });
  assert.match(readFileSync(join(dir, "proj-pi_47"), "utf-8"), /^context_pct=42$/m);
});

test("a newline in the model name cannot forge a second key", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-state-"));
  writeState({ ctx, contextPct: 1, model: "evil\nupdated=0", dir });
  const body = readFileSync(join(dir, "proj-pi_47"), "utf-8");
  assert.equal(body.match(/^updated=/gm)?.length, 1);
});

test("removeState deletes the file, and is safe when it is already gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "harness-state-"));
  writeState({ ctx, contextPct: 1, model: "m", dir });
  const path = join(dir, "proj-pi_47");
  assert.ok(existsSync(path));
  removeState(ctx, dir);
  assert.ok(!existsSync(path));
  removeState(ctx, dir); // must not throw
});
