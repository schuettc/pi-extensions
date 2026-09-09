import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBashOptions, identitySpawnHook } from "./bash-options.ts";

test("the spawn hook copies PI_SESSION_ID into AGENT_SESSION_ID per command", () => {
  const out = identitySpawnHook({ command: "true", cwd: "/tmp", env: { PI_SESSION_ID: "sess-1", PATH: "/bin" } });
  assert.equal(out.env.AGENT_SESSION_ID, "sess-1");
  assert.equal(out.env.PI_SESSION_ID, "sess-1");
  assert.equal(out.env.PATH, "/bin");
  assert.equal(out.command, "true");
  assert.equal(out.cwd, "/tmp");
});

test("an inherited AGENT_SESSION_ID is replaced by this session's, not passed through", () => {
  const out = identitySpawnHook({ command: "true", cwd: "/", env: { PI_SESSION_ID: "inner", AGENT_SESSION_ID: "polluted" } });
  assert.equal(out.env.AGENT_SESSION_ID, "inner");
});

test("without PI_SESSION_ID the hook removes AGENT_SESSION_ID rather than let an inherited value through", () => {
  const out = identitySpawnHook({ command: "true", cwd: "/", env: { AGENT_SESSION_ID: "polluted" } });
  assert.equal(out.env.AGENT_SESSION_ID, undefined);
});

test("the hook does not mutate the context it was given", () => {
  const env: NodeJS.ProcessEnv = { PI_SESSION_ID: "sess-1" };
  const ctx = { command: "true", cwd: "/", env };
  identitySpawnHook(ctx);
  assert.equal(env.AGENT_SESSION_ID, undefined);
});

test("the hook never sets CLAUDE_CODE_SESSION_ID", () => {
  const out = identitySpawnHook({ command: "true", cwd: "/", env: { PI_SESSION_ID: "sess-1" } });
  assert.equal(out.env.CLAUDE_CODE_SESSION_ID, undefined);
});

test("buildBashOptions forwards pi's shell settings and installs the hook", () => {
  const opts = buildBashOptions({
    getShellCommandPrefix: () => "shopt -s expand_aliases",
    getShellPath: () => "/opt/homebrew/bin/bash",
  });
  assert.equal(opts.commandPrefix, "shopt -s expand_aliases");
  assert.equal(opts.shellPath, "/opt/homebrew/bin/bash");
  assert.equal(opts.spawnHook, identitySpawnHook);
});

test("buildBashOptions omits unset settings so pi's defaults apply", () => {
  const opts = buildBashOptions({ getShellCommandPrefix: () => undefined, getShellPath: () => undefined });
  assert.ok(!("commandPrefix" in opts));
  assert.ok(!("shellPath" in opts));
  assert.equal(opts.spawnHook, identitySpawnHook);
});
