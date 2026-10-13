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

// --- Countdown display -----------------------------------------------------
// The session's pending wakeups, shown with a live countdown so a human can
// see what the session is waiting on and when it restarts. Pure here (text +
// mode decision); the I/O — reading tmux, writing a widget or a tmux option —
// lives in index.ts.

// A pending wakeup, reduced to just what the countdown needs: when it fires and
// why. index.ts carries the full record (prompt, timer handle); this is the
// view the formatter sees.
export type PendingView = { fireAtMs: number; reason: string };

// Reasons are shown inline in a status bar, so a long one is truncated to keep
// the line short; the ellipsis marks the cut.
export const MAX_REASON_LENGTH = 25;

export function truncateReason(reason: string, max = MAX_REASON_LENGTH): string {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  if (trimmed.length <= max) return trimmed;
  // Reserve one char for the ellipsis so the result is exactly `max` wide.
  return `${trimmed.slice(0, max - 1)}…`;
}

// Whole minutes remaining until a fire time. Anything under a minute (including
// a fire time already past, if a refresh races the timer) collapses to `<1m`
// rather than showing `0m`.
export function formatRemaining(remainingMs: number): string {
  if (remainingMs < 60_000) return "<1m";
  return `${Math.floor(remainingMs / 60_000)}m`;
}

// The countdown line for the soonest pending wakeup:
//   `17:34 · 12m · <reason>`  (fire time, minutes remaining, truncated reason)
// A missing reason drops that segment; more than one pending appends ` · +N`.
// Returns undefined when nothing is pending, so the caller clears the display.
// The HH:MM formatter is injected so tests need not depend on the machine's TZ.
export function formatCountdown(
  pending: PendingView[],
  nowMs: number,
  formatHHMM: (ms: number) => string,
): string | undefined {
  if (pending.length === 0) return undefined;
  // Soonest fire time first — that's the one we count down to.
  const sorted = [...pending].sort((a, b) => a.fireAtMs - b.fireAtMs);
  const soonest = sorted[0];
  const parts = [formatHHMM(soonest.fireAtMs), formatRemaining(soonest.fireAtMs - nowMs)];
  const reason = truncateReason(soonest.reason ?? "");
  if (reason) parts.push(reason);
  let text = parts.join(" · ");
  if (sorted.length > 1) text += ` · +${sorted.length - 1}`;
  return text;
}

// Where the countdown shows, decided ONCE at session_start. The tmux bar is
// used only when this pane is inside tmux AND the server's global status line
// actually renders `@wakeup` (otherwise the option we set would go nowhere);
// everything else falls back to a widget above the pi editor.
export type DisplayMode = "tmux" | "widget";

export function decideDisplayMode(
  env: { TMUX?: string; TMUX_PANE?: string },
  statusLeft: string | undefined,
  statusRight: string | undefined,
): DisplayMode {
  if (!env.TMUX || !env.TMUX_PANE) return "widget";
  const left = statusLeft ?? "";
  const right = statusRight ?? "";
  if (left.includes("@wakeup") || right.includes("@wakeup")) return "tmux";
  return "widget";
}
