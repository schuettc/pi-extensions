import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsGit, recordPayload, childEnv, sessionFacts, sessionInfoArgs } from "./casebook.ts";

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

// A session manager as pi hands one to an extension (ReadonlySessionManager).
function sm(over: { id?: string; name?: string; file?: string; parent?: string; cwd?: string }) {
  return {
    getSessionId: () => over.id ?? "s-1",
    getSessionName: () => over.name,
    getSessionFile: () => over.file,
    getHeader: () => ({ type: "session", id: over.id ?? "s-1", cwd: over.cwd ?? "/w", parentSession: over.parent }),
    getCwd: () => over.cwd ?? "/w",
  };
}

test("sessionFacts: a top-level pi session is named and not a child", () => {
  const f = sessionFacts(sm({ id: "p", name: "tools-workspace/casebook", file: "/s/p.jsonl" }), "/w/tools-workspace", 92602);
  assert.deepEqual(f, { id: "p", name: "tools-workspace/casebook", cwd: "/w/tools-workspace", pid: 92602, child: false });
});

test("sessionFacts: a pi-subagents worker (parentSession in its header) is a child", () => {
  const f = sessionFacts(sm({ id: "w", name: "worker#40c0f7e1", file: "/s/w.jsonl", parent: "/s/p.jsonl" }), "/w", 92602);
  assert.equal(f?.child, true);
  assert.equal(f?.name, "worker#40c0f7e1");
});

test("sessionFacts: an in-memory session (no file) is a child; serve decides worker by the shared process", () => {
  assert.equal(sessionFacts(sm({ id: "m" }), "/w", 1)?.child, true);
});

test("sessionFacts: no name is empty, and a broken session manager yields nothing", () => {
  assert.equal(sessionFacts(sm({ file: "/s/x.jsonl" }), "/w", 1)?.name, "");
  assert.equal(sessionFacts(undefined, "/w", 1), undefined);
  assert.equal(sessionFacts({ getSessionId: () => { throw new Error("x"); } } as any, "/w", 1), undefined);
});

test("sessionInfoArgs is the casebook session-info command line", () => {
  assert.deepEqual(sessionInfoArgs({ id: "p", name: "a b", cwd: "/w", pid: 7, child: false }),
    ["session-info", "--harness", "pi", "--session", "p", "--name", "a b", "--cwd", "/w", "--pid", "7"]);
  assert.deepEqual(sessionInfoArgs({ id: "w", name: "", cwd: "/w", pid: 7, child: true }),
    ["session-info", "--harness", "pi", "--session", "w", "--name", "", "--cwd", "/w", "--pid", "7", "--child"]);
});
