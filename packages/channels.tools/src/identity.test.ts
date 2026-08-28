import { test } from "node:test";
import assert from "node:assert/strict";
import { applyIdentity } from "./identity.ts";

test("sets AGENT_SESSION_ID on the given environment", () => {
  const env: NodeJS.ProcessEnv = {};
  applyIdentity("session-abc", env);
  assert.equal(env.AGENT_SESSION_ID, "session-abc");
});

test("never sets CLAUDE_CODE_SESSION_ID — a pi session must not claim to be Claude Code", () => {
  const env: NodeJS.ProcessEnv = {};
  applyIdentity("session-abc", env);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
});

test("an inherited CLAUDE_CODE_SESSION_ID is left untouched", () => {
  const env: NodeJS.ProcessEnv = { CLAUDE_CODE_SESSION_ID: "outer" };
  applyIdentity("session-abc", env);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, "outer");
});

test("a later session id replaces an earlier one, as resume and fork require", () => {
  const env: NodeJS.ProcessEnv = {};
  applyIdentity("first", env);
  applyIdentity("second", env);
  assert.equal(env.AGENT_SESSION_ID, "second");
});

test("an undefined session id clears the variable rather than writing 'undefined'", () => {
  const env: NodeJS.ProcessEnv = { AGENT_SESSION_ID: "stale" };
  applyIdentity(undefined, env);
  assert.equal(env.AGENT_SESSION_ID, undefined);
});
