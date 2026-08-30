// Pure decision logic for the wakeup extension. No pi imports, no timers,
// no I/O — so every rule here is exercised by node --test with zero mocking,
// exactly the split the guardrails package uses (gate.ts vs index.ts).

// pi-side clamp matching Claude Code's ScheduleWakeup: a wakeup delay under a
// minute would busy-loop the session, and one over an hour is a scheduler's
// job, not a session's self-pacing tool.
export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;

// Clamp an arbitrary caller-supplied delay into [MIN, MAX]. A non-finite or
// non-numeric value (the model omitted it, or sent a string that slipped the
// schema) falls back to the minimum rather than throwing — a guardrail tool
// must never fail the turn over a bad argument.
export function clampDelaySeconds(seconds: number): number {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return MIN_DELAY_SECONDS;
  const floored = Math.floor(seconds);
  if (floored < MIN_DELAY_SECONDS) return MIN_DELAY_SECONDS;
  if (floored > MAX_DELAY_SECONDS) return MAX_DELAY_SECONDS;
  return floored;
}

// How to deliver a fired wakeup, given the session's authoritative idle state
// (ctx.isIdle()). When idle we steer a fresh turn; when a turn is already
// streaming we queue as a followUp so the wakeup lands after it rather than
// interrupting it. NOTE: the caller always passes triggerTurn:true — pi's
// dispatch only honours deliverAs while streaming, and routes a
// triggerTurn:false message into a dead branch that neither steers nor queues.
export type DeliveryMode = "steer" | "followUp";
export function deliveryMode(idle: boolean): DeliveryMode {
  return idle ? "steer" : "followUp";
}

// The message content a fired wakeup delivers into the session. The reason is
// appended in parentheses so the woken turn can see why it was scheduled,
// mirroring the `reason` field ScheduleWakeup surfaces back to the user.
export function wakeupMessage(prompt: string, reason: string): string {
  const trimmedReason = typeof reason === "string" ? reason.trim() : "";
  const suffix = trimmedReason ? `\n\n(scheduled wakeup — ${trimmedReason})` : "";
  return `${prompt}${suffix}`;
}
