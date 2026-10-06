import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import casebook from "./index.ts";
import { renderBatch, type ChannelEvent } from "../../channels.tools/src/envelope.ts";

function fakeCasebook(): { bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-casebook-"));
  const log = join(dir, "log");
  const bin = join(dir, "casebook");
  writeFileSync(bin, `#!/bin/sh
if [ "$1" = brief ]; then echo "casebook: schuettc/hail: 1 item(s) need attention"; exit 0; fi
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
  process.env.CASEBOOK_BIN = "/nonexistent/casebook";
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  assert.deepEqual(Object.keys(handlers), []);
});

test("records git bash calls with the pi session, skips others", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
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
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const first = await handlers.before_agent_start({ type: "before_agent_start", prompt: "hi", systemPrompt: "" });
  assert.equal(first?.message?.customType, "casebook-brief");
  assert.equal(first?.message?.display, false);
  assert.match(String(first?.message?.content), /need attention/);
  assert.equal(await handlers.before_agent_start({ type: "before_agent_start", prompt: "again", systemPrompt: "" }), undefined);
  assert.ok(existsSync(f.bin));
});

// A context whose session manager is a named top-level pi session.
function namedCtx(name: string | undefined, over: { parent?: string; file?: string } = {}) {
  return {
    cwd: "/w/hail",
    sessionManager: {
      getSessionId: () => "pi-7",
      getSessionName: () => name,
      getSessionFile: () => over.file ?? "/s/pi-7.jsonl",
      getHeader: () => ({ type: "session", id: "pi-7", cwd: "/w/hail", parentSession: over.parent }),
    },
  };
}

test("tells casebook the session's name at start, on every rename, and at each turn's end", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  let name: string | undefined = "hail/fix";
  const c = namedCtx(undefined);
  c.sessionManager.getSessionName = () => name;
  await handlers.session_start({ type: "session_start", reason: "startup" }, c);
  await wait(300);
  let log = readFileSync(f.log, "utf8");
  assert.match(log, new RegExp(`ARGS session-info --harness pi --session pi-7 --name hail/fix --cwd /w/hail --pid ${process.pid}\\b`), log);
  assert.doesNotMatch(log, /--parent/);
  // Court renames the session.
  name = "hail/owner";
  await handlers.session_info_changed({ type: "session_info_changed", name }, c);
  await wait(300);
  log = readFileSync(f.log, "utf8");
  assert.match(log, /ARGS session-info --harness pi --session pi-7 --name hail\/owner /, log);
  // A turn ends: the name goes again (serve may have been down at the rename).
  const before = (log.match(/ARGS session-info/g) ?? []).length;
  await handlers.agent_settled({ type: "agent_settled" }, c);
  await wait(300);
  log = readFileSync(f.log, "utf8");
  assert.equal((log.match(/ARGS session-info/g) ?? []).length, before + 1, log);
});

test("reports a pi-subagents worker's parent session", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start(
    { type: "session_start", reason: "startup" },
    namedCtx("worker#40c0f7e1", { parent: "/s/2026-08-27T03-42-50-805Z_01a04150-35b5-7823-8980-4e03051c0c53.jsonl" }),
  );
  await wait(300);
  assert.match(readFileSync(f.log, "utf8"), /ARGS session-info .*--name worker#40c0f7e1 .*--parent 01a04150-35b5-7823-8980-4e03051c0c53\b/);
});

test("a session pi replaces or quits is reported ended; a reload is not", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, namedCtx("hail/fix"));
  await handlers.session_shutdown({ type: "session_shutdown", reason: "reload" }, namedCtx("hail/fix"));
  await wait(300);
  assert.doesNotMatch(readFileSync(f.log, "utf8"), /--ended/);
  // /fork in the same pi process: the old session's runtime shuts down...
  await handlers.session_start({ type: "session_start", reason: "reload" }, namedCtx("hail/fix"));
  await handlers.session_shutdown({ type: "session_shutdown", reason: "fork", targetSessionFile: "/s/2026-10-07T00-00-00-000Z_pi-8.jsonl" }, namedCtx("hail/fix"));
  await wait(300);
  assert.match(readFileSync(f.log, "utf8"), /ARGS session-info --harness pi --session pi-7 --ended\b/);
});

test("the fork's own start reports the session it replaced ended, too", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start(
    { type: "session_start", reason: "fork", previousSessionFile: "/s/2026-10-06T00-00-00-000Z_pi-6.jsonl" },
    namedCtx("hail/fix", { parent: "/s/2026-10-06T00-00-00-000Z_pi-6.jsonl" }),
  );
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /ARGS session-info --harness pi --session pi-6 --ended\b/, log);
  assert.match(log, /ARGS session-info --harness pi --session pi-7 --name hail\/fix .*--parent pi-6\b/, log);
});

test("reports settled turns with the pi session", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  assert.match(readFileSync(f.log, "utf8"), /ARGS settled --session pi-7/);
});

// Helper: build a context event with custom messages each containing one casebook envelope
function casebookContextEvent(deliveryMetas: Array<Record<string, string>>): { type: "context"; messages: unknown[] } {
  const messages = deliveryMetas.map((meta) => {
    const event: ChannelEvent = { source: "casebook", content: `page from casebook delivery ${meta.delivery}`, meta };
    return { role: "custom", customType: "channel-envelope", content: renderBatch("casebook", [event]), display: false, timestamp: Date.now() };
  });
  return { type: "context", messages };
}

test("(a) context with casebook deliveries 7 and 9 → settled --shown 7,9", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  // Fire context event containing envelopes for deliveries 7 and 9
  const ctxEvent = casebookContextEvent([
    { source: "casebook", delivery: "7", messages: "10,11" },
    { source: "casebook", delivery: "9", messages: "12,13" },
  ]);
  await handlers.context(ctxEvent);
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /ARGS settled --session pi-7 --shown 7,9/);
});

test("(b) non-casebook envelope (source galley) is ignored", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  const galleyEvent: ChannelEvent = { source: "galley", content: "some galley message", meta: { delivery: "5" } };
  const envelope = renderBatch("galley", [galleyEvent]);
  await handlers.context({
    type: "context",
    messages: [{ role: "custom", customType: "channel-envelope", content: envelope, display: false, timestamp: Date.now() }],
  });
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  // --shown must NOT appear
  assert.doesNotMatch(log, /--shown/);
  assert.match(log, /ARGS settled --session pi-7/);
});

test("(c) set clears: second agent_settled with no new context logs plain settled", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  // First run: context with delivery 7
  await handlers.context(casebookContextEvent([{ source: "casebook", delivery: "7", messages: "10,11" }]));
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  // Second run: no new context, settled should have no --shown
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  const lines = log.trim().split("\n").filter((l) => l.startsWith("ARGS settled"));
  assert.equal(lines.length, 2, `expected 2 settled lines, got: ${log}`);
  assert.match(lines[0], /--shown 7/);
  assert.doesNotMatch(lines[1], /--shown/);
});

test("(d) malformed message shape does not throw", async () => {
  const f = fakeCasebook();
  process.env.CASEBOOK_BIN = f.bin;
  const { pi, handlers } = fakePi();
  casebook(pi as any);
  await handlers.session_start({ type: "session_start", reason: "startup" }, ctx);
  // Throw various malformed shapes at the context handler
  const result = await handlers.context({
    type: "context",
    messages: [
      null,
      undefined,
      42,
      { role: "user", content: null },
      { role: "custom", content: [null, { type: "text", text: 42 }, { type: "image" }] },
      { role: "custom", content: [{ type: "text", text: "<channel source=\"casebook\" delivery=\"99\">good</channel>" }] },
    ],
  });
  // Must return undefined (not throw) and must not modify messages
  assert.equal(result, undefined);
  // delivery 99 from the valid text block should still be collected (good message is last)
  await handlers.agent_settled({ type: "agent_settled" });
  await wait(300);
  const log = readFileSync(f.log, "utf8");
  assert.match(log, /--shown 99/);
});
