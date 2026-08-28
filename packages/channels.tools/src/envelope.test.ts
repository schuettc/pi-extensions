import { test } from "node:test";
import assert from "node:assert/strict";
import { splitGuidance, renderBatch, renderSummary, strictestIntent } from "./envelope.ts";

test("splitGuidance separates on the first --- sentinel", () => {
  const r = splitGuidance("line one\n\n---\nGUIDANCE HERE");
  assert.equal(r.body, "line one");
  assert.equal(r.guidance, "GUIDANCE HERE");
});

test("splitGuidance leaves content without a sentinel untouched", () => {
  const r = splitGuidance("just an envelope line");
  assert.equal(r.body, "just an envelope line");
  assert.equal(r.guidance, undefined);
});

test("splitGuidance splits only on the first sentinel so guidance may contain one", () => {
  const r = splitGuidance("body\n\n---\nfirst\n\n---\nsecond");
  assert.equal(r.body, "body");
  assert.equal(r.guidance, "first\n\n---\nsecond");
});

test("a single event renders as a channel block with meta as attributes", () => {
  const out = renderBatch("muster-channel", [{
    source: "muster-channel",
    content: 'muster: reply from pi/pi-setup on thread #305 "x" — call get_thread 305.',
    meta: { kind: "reply", from: "pi/pi-setup", thread_id: "305", intent: "action-requested", count: "1" },
  }]);
  assert.match(out, /^<channel source="muster-channel" /);
  assert.match(out, /kind="reply"/);
  assert.match(out, /from="pi\/pi-setup"/);
  assert.match(out, /thread_id="305"/);
  assert.match(out, /intent="action-requested"/);
  assert.match(out, /call get_thread 305\./);
  assert.match(out, /<\/channel>$/);
});

test("identical guidance across a batch is emitted once", () => {
  const ev = (id: string) => ({
    source: "galley",
    content: `galley: revise on doc-${id}\n\n---\nNEVER REWRITE THE WHOLE FILE`,
    meta: { reason: "revise", doc: `doc-${id}` },
  });
  const out = renderBatch("galley", [ev("a"), ev("b")]);
  assert.equal(out.match(/NEVER REWRITE THE WHOLE FILE/g)?.length, 1);
  assert.match(out, /doc-a/);
  assert.match(out, /doc-b/);
});

test("distinct guidance blocks are all kept, in first-appearance order", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "a\n\n---\nFYI GUIDANCE", meta: { intent: "fyi" } },
    { source: "muster-channel", content: "b\n\n---\nACTION GUIDANCE", meta: { intent: "action-requested" } },
  ]);
  assert.match(out, /FYI GUIDANCE/);
  assert.match(out, /ACTION GUIDANCE/);
  assert.ok(out.indexOf("FYI GUIDANCE") < out.indexOf("ACTION GUIDANCE"));
});

test("a batch attributes count and the strictest intent present", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "a", meta: { intent: "fyi" } },
    { source: "muster-channel", content: "b", meta: { intent: "action-requested" } },
    { source: "muster-channel", content: "c", meta: { intent: "reply-requested" } },
  ]);
  assert.match(out, /count="3"/);
  assert.match(out, /intent="action-requested"/);
});

test("attribute values with quotes and angle brackets are escaped", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "x", meta: { subject: 'he said "hi" <b>' } },
  ]);
  assert.match(out, /subject="he said &quot;hi&quot; &lt;b&gt;"/);
  assert.doesNotMatch(out.split("\n")[0], /<b>/);
});

test("a multi-event batch drops per-event identity attributes, keeping only count and intent (F9)", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "a", meta: { thread_id: "305", from: "x", kind: "reply", intent: "fyi" } },
    { source: "muster-channel", content: "b", meta: { thread_id: "999", from: "y", kind: "reply", intent: "action-requested" } },
  ]);
  assert.doesNotMatch(out, /thread_id=/);
  assert.doesNotMatch(out, /from=/);
  assert.doesNotMatch(out, /kind=/);
  assert.match(out, /count="2"/);
  assert.match(out, /intent="action-requested"/);
});

test("a meta key literally named 'source' does not produce a duplicate attribute (F10)", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "x", meta: { source: "evil" } },
  ]);
  const matches = out.match(/source="/g) ?? [];
  assert.equal(matches.length, 1);
  assert.match(out, /source="muster-channel"/);
});

test("strictestIntent orders action-requested over reply-requested over fyi", () => {
  assert.equal(strictestIntent(["fyi", "action-requested", "reply-requested"]), "action-requested");
  assert.equal(strictestIntent(["fyi", "reply-requested"]), "reply-requested");
  assert.equal(strictestIntent(["fyi"]), "fyi");
  assert.equal(strictestIntent([]), undefined);
  assert.equal(strictestIntent(["unknown-thing"]), "unknown-thing");
});

test("a server's own count is preserved, not overwritten by the notification count", () => {
  // muster coalesces server-side: one push can represent many threads, and it
  // says so in meta.count. Ours counts notifications. Overwriting theirs tells
  // the agent one thing arrived when three did.
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "muster: 3 new — …", meta: { count: "3", intent: "action-requested" } },
  ]);
  assert.match(out, /count="3"/);
});

test("coalescing sums the servers' counts rather than counting notifications", () => {
  const out = renderBatch("muster-channel", [
    { source: "muster-channel", content: "a", meta: { count: "3", intent: "fyi" } },
    { source: "muster-channel", content: "b", meta: { count: "2", intent: "action-requested" } },
  ]);
  assert.match(out, /count="5"/);
  assert.match(out, /intent="action-requested"/);
});

test("events without a server count fall back to counting notifications", () => {
  const out = renderBatch("galley", [
    { source: "galley", content: "a", meta: { reason: "revise" } },
    { source: "galley", content: "b", meta: { reason: "revise" } },
  ]);
  assert.match(out, /count="2"/);
});

test("renderSummary takes each event's first body line and drops the guidance", () => {
  const out = renderSummary("muster-channel", [
    { source: "muster-channel", content: 'muster: reply on thread #1 "x"\n\n---\ncall get_thread 1', meta: {} },
    { source: "muster-channel", content: 'muster: fyi on thread #2 "y"\n\n---\nread only', meta: {} },
  ]);
  assert.equal(out, 'muster: reply on thread #1 "x"\nmuster: fyi on thread #2 "y"');
});

test("renderSummary dedupes identical lines and caps at five with a remainder", () => {
  const events = Array.from({ length: 8 }, (_, i) => ({
    source: "s",
    content: `line ${i}`,
    meta: {},
  }));
  events.push({ source: "s", content: "line 0", meta: {} });
  const out = renderSummary("s", events);
  const lines = out.split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[5], "…and 3 more");
});

test("renderSummary falls back to naming the source when no event has a body", () => {
  const out = renderSummary("galley", [{ source: "galley", content: "\n\n---\nguidance only", meta: {} }]);
  assert.equal(out, "[galley] new channel activity");
});
