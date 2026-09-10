import { test } from "node:test";
import assert from "node:assert/strict";
import { bangKeyAction, deliveryMode, nudgeText, parseToggle, shouldNudge } from "./bang.ts";

test("shouldNudge: plain successful ! nudges", () => {
  assert.equal(
    shouldNudge({ enabled: true, excludeFromContext: false, aborted: false, exitCode: 0 }),
    true,
  );
});

test("shouldNudge: non-zero exit still nudges", () => {
  assert.equal(
    shouldNudge({ enabled: true, excludeFromContext: false, aborted: false, exitCode: 2 }),
    true,
  );
});

test("shouldNudge: !! is passive", () => {
  assert.equal(
    shouldNudge({ enabled: true, excludeFromContext: true, aborted: false, exitCode: 0 }),
    false,
  );
});

test("shouldNudge: aborted run is skipped", () => {
  assert.equal(
    shouldNudge({ enabled: true, excludeFromContext: false, aborted: true, exitCode: 0 }),
    false,
  );
});

test("shouldNudge: killed process (null exit) is skipped", () => {
  assert.equal(
    shouldNudge({ enabled: true, excludeFromContext: false, aborted: false, exitCode: null }),
    false,
  );
});

test("shouldNudge: disabled skips everything", () => {
  assert.equal(
    shouldNudge({ enabled: false, excludeFromContext: false, aborted: false, exitCode: 0 }),
    false,
  );
});

test("nudgeText: success mentions the command", () => {
  const text = nudgeText("git status", 0);
  assert.ok(text.includes("`git status`"));
  assert.ok(text.includes("completed"));
});

test("nudgeText: failure carries the exit code", () => {
  const text = nudgeText("npm test", 1);
  assert.ok(text.includes("exited with code 1"));
});

test("nudgeText: long commands are truncated", () => {
  const long = "x".repeat(200);
  const text = nudgeText(long, 0);
  assert.ok(text.includes(`${"x".repeat(77)}...`));
  assert.ok(!text.includes("x".repeat(81)));
});

test("deliveryMode: idle steers, busy follows up", () => {
  assert.equal(deliveryMode(true), "steer");
  assert.equal(deliveryMode(false), "followUp");
});

test("bangKeyAction: ! into empty editor auto-spaces", () => {
  assert.equal(bangKeyAction("!", ""), "autospace");
});

test("bangKeyAction: second ! upgrades the auto-spaced prefix to !!", () => {
  assert.equal(bangKeyAction("!", "! "), "upgrade");
});

test("bangKeyAction: ! mid-text passes through", () => {
  assert.equal(bangKeyAction("!", "echo hi"), "pass");
  assert.equal(bangKeyAction("!", "! ls"), "pass");
  assert.equal(bangKeyAction("!", "!! "), "pass");
});

test("bangKeyAction: multi-char input (paste, escape sequences) passes through", () => {
  assert.equal(bangKeyAction("!ls", ""), "pass");
  assert.equal(bangKeyAction("\u001b[A", ""), "pass");
  assert.equal(bangKeyAction("a", ""), "pass");
});

test("parseToggle: on/off recognized, everything else is status", () => {
  assert.equal(parseToggle("on"), "on");
  assert.equal(parseToggle(" OFF "), "off");
  assert.equal(parseToggle(""), "status");
  assert.equal(parseToggle("banana"), "status");
});
