import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ledger from "./index.ts";

function fakeLedger(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-ledger-"));
  const log = join(dir, "log");
  const bin = join(dir, "ledger");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = brief ]; then echo "ledger: schuettc/hail: 1 item(s) need attention"; exit 0; fi
{ echo "ARGS $* SESSION=$AGENT_SESSION_ID"; cat; echo; } >> '${log}'
`, { mode: 0o755 });
  return { bin, log };
}

function fakePi() {
  const handlers: Record<string, Function> = {};
  return { handlers, pi: { on: (name: string, fn: Function) => { handlers[name] = fn; } } };
}

const ctx = { cwd: "/w/hail", sessionManager: { getSessionId: () => "pi-7" } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("inert when the binary is missing", () => {
  process.env.LEDGER_BIN = "/nonexistent/ledger";
  const { pi, handlers } = fakePi();
  ledger(pi as any);
  assert.deepEqual(Object.keys(handlers), []);
});

test("records git bash calls with the pi session, skips others", async () => {
  const f = fakeLedger();
  process.env.LEDGER_BIN = f.bin;
  const { pi, handlers } = fakePi();
  ledger(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  await handlers.tool_result({ type: "tool_result", toolName: "bash", input: { command: "git push origin main" }, content: [], isError: false });
  await handlers.tool_result({ type: "tool_result", toolName: "bash", input: { command: "ls -la" }, content: [], isError: false });
  await handlers.tool_result({ type: "tool_result", toolName: "read", input: { command: "git push" }, content: [], isError: false });
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  assert.equal(log.match(/ARGS record --harness pi SESSION=pi-7/g)?.length, 1, log);
  assert.match(log, /"command":"git push origin main","cwd":"\/w\/hail"/);
  assert.match(log, /ARGS sync --no-github/);
});

test("briefs the first turn only, hidden from the transcript", async () => {
  const f = fakeLedger();
  process.env.LEDGER_BIN = f.bin;
  const { pi, handlers } = fakePi();
  ledger(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const first = await handlers.before_agent_start({ type: "before_agent_start", prompt: "hi", systemPrompt: "" });
  assert.equal(first?.message?.customType, "ledger-brief");
  assert.equal(first?.message?.display, false);
  assert.match(String(first?.message?.content), /need attention/);
  assert.equal(await handlers.before_agent_start({ type: "before_agent_start", prompt: "again", systemPrompt: "" }), undefined);
  assert.ok(existsSync(f.bin));
});
