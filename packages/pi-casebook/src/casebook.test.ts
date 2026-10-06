import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mentionsGit, recordPayload, childEnv, sessionFacts, sessionInfoArgs, sessionEndedArgs, sessionIdFromFile, type ProcessSessions } from "./casebook.ts";

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

test("sessionFacts: a top-level pi session is named and has no parent", () => {
  const f = sessionFacts(sm({ id: "p", name: "tools-workspace/casebook", file: "/s/p.jsonl" }), "/w/tools-workspace", 92602, new Map());
  assert.deepEqual(f, { id: "p", name: "tools-workspace/casebook", cwd: "/w/tools-workspace", pid: 92602, parent: "" });
});

test("sessionFacts: a pi-subagents worker reports its parent session's id, from the header's parentSession file name", () => {
  const f = sessionFacts(
    sm({ id: "w", name: "worker#40c0f7e1", file: "/s/w.jsonl", parent: "/s/--w--/2026-08-27T03-42-50-805Z_01a04150-35b5-7823-8980-4e03051c0c53.jsonl" }),
    "/w",
    92602,
    new Map(),
  );
  assert.equal(f?.parent, "01a04150-35b5-7823-8980-4e03051c0c53");
  assert.equal(f?.name, "worker#40c0f7e1");
});

test("sessionIdFromFile: pi's <timestamp>_<id>.jsonl, else the file's header id, else nothing", () => {
  assert.equal(sessionIdFromFile("/s/2026-08-27T03-42-50-805Z_01a04150-35b5-7823-8980-4e03051c0c53.jsonl"), "01a04150-35b5-7823-8980-4e03051c0c53");
  assert.equal(sessionIdFromFile("/s/2026-08-27T03-42-50-805Z_my_custom.jsonl"), "my_custom");
  const dir = mkdtempSync(join(tmpdir(), "pi-casebook-file-"));
  const odd = join(dir, "renamed.jsonl");
  writeFileSync(odd, JSON.stringify({ type: "session", version: 3, id: "from-header", cwd: "/w" }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
  assert.equal(sessionIdFromFile(odd), "from-header");
  assert.equal(sessionIdFromFile(join(dir, "missing.jsonl")), "");
  assert.equal(sessionIdFromFile(""), "");
  assert.equal(sessionIdFromFile(undefined), "");
});

test("sessionFacts: an in-memory session with no header parent runs under the process's root session", () => {
  const procs: ProcessSessions = new Map([
    ["main", { root: true }],
    ["w1", { root: false }],
  ]);
  assert.equal(sessionFacts(sm({ id: "m" }), "/w", 1, procs)?.parent, "main");
  // Alone in its process (pi --no-session): no parent.
  assert.equal(sessionFacts(sm({ id: "m" }), "/w", 1, new Map())?.parent, "");
  // Its own entry is not its parent.
  assert.equal(sessionFacts(sm({ id: "main" }), "/w", 1, procs)?.parent, "");
  // A session with a file and no parentSession is a root, whatever else runs.
  assert.equal(sessionFacts(sm({ id: "f", file: "/s/f.jsonl" }), "/w", 1, procs)?.parent, "");
});

test("sessionFacts: no name is empty, and a broken session manager yields nothing", () => {
  assert.equal(sessionFacts(sm({ file: "/s/x.jsonl" }), "/w", 1, new Map())?.name, "");
  assert.equal(sessionFacts(undefined, "/w", 1), undefined);
  assert.equal(sessionFacts({ getSessionId: () => { throw new Error("x"); } } as any, "/w", 1), undefined);
});

test("sessionInfoArgs is the casebook session-info command line", () => {
  assert.deepEqual(sessionInfoArgs({ id: "p", name: "a b", cwd: "/w", pid: 7, parent: "" }),
    ["session-info", "--harness", "pi", "--session", "p", "--name", "a b", "--cwd", "/w", "--pid", "7"]);
  assert.deepEqual(sessionInfoArgs({ id: "w", name: "", cwd: "/w", pid: 7, parent: "p" }),
    ["session-info", "--harness", "pi", "--session", "w", "--name", "", "--cwd", "/w", "--pid", "7", "--parent", "p"]);
});

test("sessionEndedArgs is the command line that says a session ended", () => {
  assert.deepEqual(sessionEndedArgs("p"), ["session-info", "--harness", "pi", "--session", "p", "--ended"]);
});
