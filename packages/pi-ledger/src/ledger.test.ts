import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsGit, recordPayload, childEnv } from "./ledger.ts";

test("mentionsGit spots git and gh invocations only", () => {
  for (const c of ["git push", "cd x && git commit -m 'a'", "gh pr merge 3", "/usr/bin/git fetch", "FOO=1 gh api x", "(git status)"]) {
    assert.equal(mentionsGit(c), true, c);
  }
  for (const c of ["ls -la", "echo digit", "npm run gh-pages", "cat .gitignore", "legit tool"]) {
    assert.equal(mentionsGit(c), false, c);
  }
});

test("recordPayload is the pi record shape", () => {
  assert.deepEqual(JSON.parse(recordPayload("git push", "/w")), { command: "git push", cwd: "/w" });
});

test("childEnv attributes the child to the pi session", () => {
  const env = childEnv({ PATH: "/bin", CLAUDE_CODE_SESSION_ID: "cc", AGENT_SESSION_CHILD: "1", AGENT_SESSION_ID: "old" }, "pi-7");
  assert.equal(env.AGENT_SESSION_ID, "pi-7");
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.AGENT_SESSION_CHILD, undefined);
  assert.equal(env.PATH, "/bin");
  const none = childEnv({ AGENT_SESSION_ID: "old" }, "");
  assert.equal(none.AGENT_SESSION_ID, undefined);
});
