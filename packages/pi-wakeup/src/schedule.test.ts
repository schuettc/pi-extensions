import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampDelaySeconds,
  decideDisplayMode,
  deliveryMode,
  formatCountdown,
  formatRemaining,
  truncateReason,
  wakeupMessage,
  MAX_REASON_LENGTH,
  MIN_DELAY_SECONDS,
  MAX_DELAY_SECONDS,
} from "./schedule.ts";

test("clampDelaySeconds: below the floor clamps up to the minimum", () => {
  assert.equal(clampDelaySeconds(1), MIN_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(0), MIN_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(-100), MIN_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(59), MIN_DELAY_SECONDS);
});

test("clampDelaySeconds: above the ceiling clamps down to the maximum", () => {
  assert.equal(clampDelaySeconds(3601), MAX_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(999999), MAX_DELAY_SECONDS);
});

test("clampDelaySeconds: an in-range value is floored, not rounded", () => {
  assert.equal(clampDelaySeconds(120), 120);
  assert.equal(clampDelaySeconds(120.9), 120);
  assert.equal(clampDelaySeconds(MIN_DELAY_SECONDS), MIN_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(MAX_DELAY_SECONDS), MAX_DELAY_SECONDS);
});

test("clampDelaySeconds: a non-finite or non-numeric delay falls back to the minimum, never throws", () => {
  assert.equal(clampDelaySeconds(Number.NaN), MIN_DELAY_SECONDS);
  assert.equal(clampDelaySeconds(Number.POSITIVE_INFINITY), MIN_DELAY_SECONDS);
  // @ts-expect-error — deliberately passing a bad type the schema might miss
  assert.equal(clampDelaySeconds("120"), MIN_DELAY_SECONDS);
  // @ts-expect-error
  assert.equal(clampDelaySeconds(undefined), MIN_DELAY_SECONDS);
});

test("deliveryMode: idle steers a fresh turn, busy queues as followUp", () => {
  assert.equal(deliveryMode(true), "steer"); // idle
  assert.equal(deliveryMode(false), "followUp"); // busy/streaming
});

test("wakeupMessage: a reason is appended in parentheses", () => {
  assert.equal(
    wakeupMessage("check the build", "waiting on CI"),
    "check the build\n\n(scheduled wakeup — waiting on CI)",
  );
});

test("wakeupMessage: an empty or whitespace reason leaves the prompt bare", () => {
  assert.equal(wakeupMessage("check the build", ""), "check the build");
  assert.equal(wakeupMessage("check the build", "   "), "check the build");
});

// A fixed HH:MM formatter so these assertions never depend on the machine's TZ.
const clock = (ms: number) => (ms === 0 ? "17:34" : `t+${ms}`);

test("formatRemaining: whole minutes, and under a minute collapses to <1m", () => {
  assert.equal(formatRemaining(12 * 60_000), "12m");
  assert.equal(formatRemaining(12 * 60_000 + 59_000), "12m"); // floored
  assert.equal(formatRemaining(59_000), "<1m");
  assert.equal(formatRemaining(0), "<1m");
  assert.equal(formatRemaining(-5000), "<1m"); // a refresh racing the fire
});

test("truncateReason: long reasons are cut with an ellipsis, short ones pass through", () => {
  assert.equal(truncateReason("waiting on CI"), "waiting on CI");
  assert.equal(truncateReason("   waiting on CI   "), "waiting on CI"); // trimmed
  const long = "a".repeat(40);
  const out = truncateReason(long);
  assert.equal(out.length, MAX_REASON_LENGTH);
  assert.ok(out.endsWith("\u2026"));
});

test("formatCountdown: nothing pending clears the display", () => {
  assert.equal(formatCountdown([], 0, clock), undefined);
});

test("formatCountdown: soonest wakeup as time \u00b7 minutes \u00b7 reason", () => {
  const text = formatCountdown([{ fireAtMs: 0, reason: "waiting on CI" }], -12 * 60_000, clock);
  assert.equal(text, "17:34 \u00b7 12m \u00b7 waiting on CI");
});

test("formatCountdown: no reason omits that segment", () => {
  const text = formatCountdown([{ fireAtMs: 0, reason: "" }], -12 * 60_000, clock);
  assert.equal(text, "17:34 \u00b7 12m");
});

test("formatCountdown: more pending appends +N, counted off the soonest", () => {
  const pending = [
    { fireAtMs: 300_000, reason: "later" },
    { fireAtMs: 0, reason: "soon" },
    { fireAtMs: 600_000, reason: "latest" },
  ];
  const text = formatCountdown(pending, -60_000, clock);
  // Soonest (fireAtMs 0) drives the line; two others become +2.
  assert.ok(text!.startsWith("17:34 \u00b7 1m \u00b7 soon"));
  assert.ok(text!.endsWith("\u00b7 +2"));
});

test("formatCountdown: a long reason is truncated in the line", () => {
  const text = formatCountdown(
    [{ fireAtMs: 0, reason: "x".repeat(40) }],
    -5 * 60_000,
    clock,
  );
  assert.ok(text!.includes("\u2026"));
});

test("decideDisplayMode: tmux only when in a pane AND the status renders @wakeup", () => {
  const inPane = { TMUX: "/tmp/sock,1,0", TMUX_PANE: "%3" };
  assert.equal(decideDisplayMode(inPane, "", "#{?@wakeup,x,}"), "tmux"); // status-right
  assert.equal(decideDisplayMode(inPane, "@wakeup", ""), "tmux"); // status-left
  assert.equal(decideDisplayMode(inPane, "", ""), "widget"); // config doesn't render it
  assert.equal(decideDisplayMode(inPane, undefined, undefined), "widget");
});

test("decideDisplayMode: no tmux env is always the widget", () => {
  assert.equal(decideDisplayMode({}, "@wakeup", "@wakeup"), "widget");
  assert.equal(decideDisplayMode({ TMUX: "/tmp/sock,1,0" }, "@wakeup", "@wakeup"), "widget");
  assert.equal(decideDisplayMode({ TMUX_PANE: "%3" }, "@wakeup", "@wakeup"), "widget");
});
