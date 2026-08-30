import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const MUSTER = join(homedir(), ".local", "bin", "muster");

export type Run = (cmd: string, args: string[], input: string) => string;

export type HookOutcome = { stdout: string; reason?: string };

// The default seam. Deliberately NOT passing `env`: muster's hooks resolve
// the calling pane from $TMUX / $TMUX_PANE, falling back to an ancestry walk
// when that is unset. Inheriting the child's environment for free is what
// makes that resolution work — passing an explicit env here (even one that
// looks like a superset) would break it invisibly. Do not "tidy" this.
function defaultRun(cmd: string, args: string[], input: string): string {
  return execFileSync(cmd, args, {
    input,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "ignore"],
  });
}

// Every hook call is best-effort. A session whose bus call fails is worse off
// than one that succeeded, but it is still a working session — and a handler
// that threw would fail a session start, a settle, or a shutdown outright.
function callHook(event: string, payload: unknown, run: Run): HookOutcome {
  try {
    const stdout = run(MUSTER, ["hook", event, "pi"], JSON.stringify(payload));
    return { stdout };
  } catch {
    // Best-effort: the bus is not worth failing a turn, a start, or a shutdown.
    return { stdout: "" };
  }
}

// hook SessionStart pi replaces register() for the pane path: beyond
// registering, it reclaims this pane's rows on a resume and prints
// reconnection text to stdout. Claude Code injects hook stdout into context
// automatically; pi does not, so the caller must inject `stdout` itself or a
// resumed session silently knows less than it should.
export function sessionStart(
  opts: { sessionId: string; cwd: string; source: "startup" | "resume"; run?: Run },
): HookOutcome {
  const run = opts.run ?? defaultRun;
  return callHook(
    "SessionStart",
    { session_id: opts.sessionId, cwd: opts.cwd, source: opts.source },
    run,
  );
}

// Drain belongs on agent_settled, NOT on agent_end / turn end. Claude Code
// wires its drain to the Stop hook because that is the only boundary it can
// express; pi's agent_end is that same boundary, but after it pi may still
// auto-retry, auto-compact and retry, or continue with queued follow-up
// messages. An earlier phase of this program hit exactly that edge with
// buffered mail: delivering there lands it mid-retry or loses it to
// compaction. This module only provides drain() — Task 5 wires it to
// agent_settled, the point where pi will not continue on its own.
//
// stopHookActive must be true on the settle immediately following a drain
// this module triggered, otherwise every settle re-drains for as long as
// mail is unread — which, with pi-channels also pushing, is a session that
// talks to itself indefinitely.
export function drain(
  opts: { sessionId: string; stopHookActive: boolean; run?: Run },
): HookOutcome {
  const run = opts.run ?? defaultRun;
  const outcome = callHook(
    "Stop",
    { session_id: opts.sessionId, stop_hook_active: opts.stopHookActive },
    run,
  );
  try {
    // The hook may print a warning line before its JSON, so parse the LAST
    // non-empty line that looks like a JSON object rather than the whole
    // stdout — parsing the whole thing would throw on the leading warning and
    // silently drop the mail notice. stdout may still be empty or carry no
    // JSON at all; a malformed decision must not throw into a settle handler.
    const jsonLine = outcome.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{") && l.endsWith("}"))
      .pop();
    if (jsonLine) {
      const parsed = JSON.parse(jsonLine);
      if (parsed && parsed.decision === "block" && typeof parsed.reason === "string") {
        return { stdout: outcome.stdout, reason: parsed.reason };
      }
    }
  } catch {
    // A line that looked like JSON but was not must not throw into a settle
    // handler — the mail is best-effort, not worth failing the settle over.
  }
  return outcome;
}

export function sessionEnd(opts: { sessionId: string; run?: Run }): void {
  const run = opts.run ?? defaultRun;
  // sessionId is sent so muster tombstones only this pane's rows, not every
  // row for the alias.
  callHook("SessionEnd", { session_id: opts.sessionId }, run);
}

// Adapts a plain arg-list call onto the new (cmd, args, input) => stdout
// seam for register/become, which carry no payload and ignore any reply.
function call(args: string[], run: Run): void {
  try {
    run(MUSTER, args, "");
  } catch {
    // Best-effort: the bus is not worth failing a turn, a start, or a shutdown.
  }
}

// --model pi is what puts this session in muster's harness tables. Those
// tables decide, among other things, whether an outside-in rename can reach
// this pane at all. Omitting the alias is deliberate when none is given:
// muster falls back to $MUSTER_ALIAS and then the tmux session name, which is
// the behaviour every other harness gets.
//
// This is no longer the session-start call — `sessionStart` (hook
// SessionStart pi) is. `register` stays for claiming an explicit alias AFTER
// the hook has run.
//
// NOT currently wired: index.ts calls sessionStart, never register. Exported
// and retained deliberately, per the amendment, for a future explicit-alias
// claim after sessionStart — not dead code left by accident.
export function register(opts: { alias?: string; run?: Run } = {}): void {
  const run = opts.run ?? defaultRun;
  const args = opts.alias ? ["register", opts.alias] : ["register"];
  call([...args, "--model", "pi"], run);
}

// --no-inject: become normally types the new name into the agent's pane so
// the harness session name follows. Our caller is a handler already reacting
// to a rename, so typing it back would loop text into the pane that just
// renamed itself. muster's own help names this exact case, and Claude Code's
// statusline passes the same flag for the same reason.
export function become(name: string, deps: { run?: Run } = {}): void {
  if (!name) return;
  const run = deps.run ?? defaultRun;
  call(["become", name, "--no-inject"], run);
}
