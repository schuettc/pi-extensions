import { test } from "node:test";
import assert from "node:assert/strict";
import { register, sessionStart, drain, sessionEnd, become } from "./muster.ts";
import type { Run } from "./muster.ts";

type Call = { cmd: string; args: string[]; input: string };
function recorder(returns = "") {
  const calls: Call[] = [];
  return {
    calls,
    run: (cmd: string, args: string[], input: string) => {
      calls.push({ cmd, args, input });
      return returns;
    },
  };
}

test("register passes the model as pi and the alias when given", () => {
  const r = recorder();
  register({ alias: "pi-97", run: r.run });
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].cmd, /muster$/);
  assert.deepEqual(r.calls[0].args, ["register", "pi-97", "--model", "pi"]);
});

test("register omits the alias when none is given, letting muster fall back to the tmux session name", () => {
  const r = recorder();
  register({ run: r.run });
  assert.deepEqual(r.calls[0].args, ["register", "--model", "pi"]);
});

test("become passes --no-inject so a rename cannot type back into its own pane", () => {
  const r = recorder();
  become("new-name", { run: r.run });
  assert.deepEqual(r.calls[0].args, ["become", "new-name", "--no-inject"]);
});

test("become with an empty name does nothing rather than claiming an empty alias", () => {
  const r = recorder();
  become("", { run: r.run });
  assert.deepEqual(r.calls, []);
});

test("a failing muster call is swallowed — the bus is not worth failing a turn over", () => {
  const boom: Run = () => { throw new Error("muster is not installed"); };
  assert.doesNotThrow(() => register({ run: boom }));
  assert.doesNotThrow(() => drain({ sessionId: "s", stopHookActive: false, run: boom }));
  assert.doesNotThrow(() => sessionEnd({ sessionId: "s", run: boom }));
  assert.doesNotThrow(() => become("x", { run: boom }));
});

test("sessionStart sends the payload muster expects and returns its stdout", () => {
  const seen: Array<{ args: string[]; input: string }> = [];
  const out = sessionStart({
    sessionId: "sess-1", cwd: "/w", source: "startup",
    run: (_c, args, input) => { seen.push({ args, input }); return "muster: registered as 'pi-97'\n"; },
  });
  assert.deepEqual(seen[0].args, ["hook", "SessionStart", "pi"]);
  assert.deepEqual(JSON.parse(seen[0].input), { session_id: "sess-1", cwd: "/w", source: "startup" });
  assert.match(out.stdout, /registered as/);
});

test("a resume passes source:resume, which is what makes muster reclaim rows", () => {
  let input = "";
  sessionStart({ sessionId: "s", cwd: "/w", source: "resume", run: (_c, _a, i) => { input = i; return ""; } });
  assert.equal(JSON.parse(input).source, "resume");
});

test("drain passes stop_hook_active and surfaces the block reason", () => {
  const seen: string[] = [];
  const out = drain({
    sessionId: "s", stopHookActive: false,
    run: (_c, _a, i) => { seen.push(i); return JSON.stringify({ decision: "block", reason: "You have 2 unread threads" }); },
  });
  assert.equal(JSON.parse(seen[0]).stop_hook_active, false);
  assert.equal(out.reason, "You have 2 unread threads");
});

test("drain with no mail yields no reason rather than an empty one", () => {
  const out = drain({ sessionId: "s", stopHookActive: false, run: () => "" });
  assert.equal(out.reason, undefined);
});

test("drain recovers the reason from JSON that follows a leading warning line", () => {
  // A hook may log a warning before its JSON. Parsing the whole stdout would
  // throw on the warning and silently drop the mail notice; the last JSON-object
  // line is what carries the decision.
  const out = drain({
    sessionId: "s", stopHookActive: false,
    run: () => 'warning: x\n{"decision":"block","reason":"You have 2 unread threads"}',
  });
  assert.equal(out.reason, "You have 2 unread threads");
});

test("drain tolerates stdout that carries no JSON at all", () => {
  // A warning with no JSON behind it must not throw into a settle handler, and
  // yields no reason rather than a fabricated one.
  const out = drain({ sessionId: "s", stopHookActive: false, run: () => "warning: something\n" });
  assert.equal(out.reason, undefined);
});

test("a decision that is not block yields no reason", () => {
  const out = drain({
    sessionId: "s", stopHookActive: false,
    run: () => JSON.stringify({ decision: "approve", reason: "ignored" }),
  });
  assert.equal(out.reason, undefined);
});

test("sessionEnd sends the session id so it tombstones this pane's rows only", () => {
  let input = "";
  sessionEnd({ sessionId: "s", run: (_c, _a, i) => { input = i; return ""; } });
  assert.deepEqual(JSON.parse(input), { session_id: "s" });
});

test("a throwing hook yields an empty outcome rather than propagating", () => {
  const boom: Run = () => { throw new Error("no muster"); };
  assert.doesNotThrow(() => {
    const out = drain({ sessionId: "s", stopHookActive: false, run: boom });
    assert.equal(out.reason, undefined);
    assert.equal(out.stdout, "");
  });
});
