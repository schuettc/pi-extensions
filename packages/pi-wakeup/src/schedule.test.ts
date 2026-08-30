import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clampDelaySeconds,
  deliveryMode,
  wakeupMessage,
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
