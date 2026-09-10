// Pure decision logic for pi-bang. No pi imports, no timers, no I/O — every
// rule here is exercised by node --test with zero mocking, the same split
// pi-wakeup uses (schedule.ts vs index.ts).

// Whether a completed user `!` command should trigger a turn.
//
// - `!!` (excludeFromContext) stays passive by definition: its output never
//   reaches the model, so a nudge would point at nothing.
// - An aborted run (Esc) or a killed process (exitCode null) was ended by the
//   user or the system, not finished — reacting to it would be noise.
// - Non-zero exit codes DO nudge: a failing command is exactly the output the
//   user most wants the model to look at.
export function shouldNudge(input: {
  enabled: boolean;
  excludeFromContext: boolean;
  aborted: boolean;
  exitCode: number | null;
}): boolean {
  if (!input.enabled) return false;
  if (input.excludeFromContext) return false;
  if (input.aborted) return false;
  if (input.exitCode === null) return false;
  return true;
}

// The nudge is a pointer, not a payload: pi already converts the recorded
// bashExecution entry into a user message at request time, so the full output
// is in context. Repeating it here would double its token cost.
export function nudgeText(command: string, exitCode: number): string {
  const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command;
  const status = exitCode === 0 ? "completed" : `exited with code ${exitCode}`;
  return `The \`!\` shell command \`${shown}\` just ${status}. Its output is in the conversation context — review it and respond.`;
}

// How to deliver the nudge, given the session's authoritative idle state
// (ctx.isIdle()). Idle -> steer a fresh turn; a turn already streaming ->
// followUp so the nudge lands after it (and after pi flushes the deferred
// bashExecution entry at agent_end). The caller always passes
// triggerTurn:true — pi routes triggerTurn:false into a branch that neither
// steers nor queues.
export type DeliveryMode = "steer" | "followUp";
export function deliveryMode(idle: boolean): DeliveryMode {
  return idle ? "steer" : "followUp";
}

// Keystroke rule for the auto-space editor nicety. `data` is one editor
// input event: a single typed character for real keystrokes, multi-char for
// pastes and escape sequences — only the exact single "!" participates, so
// pasting a script containing ! is never rewritten.
//
// - "!" into an EMPTY editor -> "! " (autospace): the space marks bash mode
//   visibly and keeps the command readable.
// - "!" when the editor holds exactly "! " -> "!! " (upgrade): the second
//   bang would otherwise land after the auto-space and break pi's `!!`
//   detection, which requires the bangs adjacent at position 0.
// - anything else -> pass to the editor untouched. A "!" mid-sentence is
//   never touched because the editor is not empty.
export type KeyAction = "autospace" | "upgrade" | "pass";
export function bangKeyAction(data: string, currentText: string): KeyAction {
  if (data !== "!") return "pass";
  if (currentText === "") return "autospace";
  if (currentText === "! ") return "upgrade";
  return "pass";
}

// /bang command argument parsing. Anything unrecognized reads as a status
// request rather than an error — a toggle command should never scold.
export type ToggleAction = "on" | "off" | "status";
export function parseToggle(args: string): ToggleAction {
  const word = (args ?? "").trim().toLowerCase();
  if (word === "on") return "on";
  if (word === "off") return "off";
  return "status";
}
