import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnEnv, SESSION_ID_VAR } from "./identity.ts";

test("spawnEnv sets AGENT_SESSION_ID on a copy, leaving the base untouched", () => {
  const base: NodeJS.ProcessEnv = { PATH: "/bin" };
  const env = spawnEnv(base, "session-abc");
  assert.equal(env.AGENT_SESSION_ID, "session-abc");
  assert.equal(env.PATH, "/bin");
  assert.equal(base.AGENT_SESSION_ID, undefined, "the base environment must never be written");
  assert.notEqual(env, base);
});

test("spawnEnv with no session id removes an inherited AGENT_SESSION_ID rather than passing it through", () => {
  const base: NodeJS.ProcessEnv = { AGENT_SESSION_ID: "outer-agent" };
  const env = spawnEnv(base, undefined);
  assert.equal(env.AGENT_SESSION_ID, undefined);
  assert.equal(base.AGENT_SESSION_ID, "outer-agent");
});

test("spawnEnv treats an empty session id like none", () => {
  const env = spawnEnv({ AGENT_SESSION_ID: "stale" }, "");
  assert.equal(env.AGENT_SESSION_ID, undefined);
});

test("spawnEnv replaces an inherited AGENT_SESSION_ID with this session's", () => {
  const env = spawnEnv({ AGENT_SESSION_ID: "outer-agent" }, "inner");
  assert.equal(env.AGENT_SESSION_ID, "inner");
});

test("a server definition's own env wins over the injected id", () => {
  const env = spawnEnv({}, "session-abc", { AGENT_SESSION_ID: "pinned", FOO: "bar" });
  assert.equal(env.AGENT_SESSION_ID, "pinned");
  assert.equal(env.FOO, "bar");
});

test("spawnEnv never sets CLAUDE_CODE_SESSION_ID and leaves an inherited one alone", () => {
  assert.equal(spawnEnv({}, "session-abc").CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(spawnEnv({ CLAUDE_CODE_SESSION_ID: "outer" }, "session-abc").CLAUDE_CODE_SESSION_ID, "outer");
});

test("SESSION_ID_VAR names the wire variable", () => {
  assert.equal(SESSION_ID_VAR, "AGENT_SESSION_ID");
});
