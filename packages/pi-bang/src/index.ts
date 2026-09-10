// pi-bang — trigger a model turn when a user `!` shell command completes.
//
// Pi's built-in behavior: `!cmd` records a bashExecution entry whose output is
// converted into a user message at the NEXT request, so the model only reacts
// once the user prompts again. This extension makes `!` active: it intercepts
// user_bash, wraps pi's own local shell backend, and after the command
// finishes sends a small nudge message with triggerTurn:true so the session
// responds to the output immediately. `!!` stays passive, as does a cancelled
// or killed command. Toggle at runtime with /bang on|off.
//
// ORDERING (load-bearing): pi records the bashExecution entry only after our
// wrapped exec resolves, inside the same promise chain. The nudge is therefore
// deferred with a macrotask timer so the entry — the content the turn is meant
// to react to — is in the session before the turn starts. When a turn is
// already streaming, pi defers the entry to agent_end and our followUp nudge
// queues behind the same boundary.
//
// The pure decisions (skip rules, nudge text, delivery mode, toggle parsing)
// live in bang.ts; this file is the thin, best-effort pi wiring in the same
// split pi-wakeup uses.

import { deliveryMode, nudgeText, parseToggle, shouldNudge } from "./bang.ts";

type BashOps = { exec: (command: string, cwd: string, options: any) => Promise<{ exitCode: number | null }> };

export type Deps = {
  // Injectable so the wiring is testable without pi's real shell backend or
  // real time passing.
  createOps?: () => Promise<BashOps> | BashOps;
  setTimer?: (fn: () => void, ms: number) => unknown;
};

// Lazy: a top-level import of the pi package pulls its entire runtime, which
// only resolves inside a live pi process (and breaks node --test). The real
// backend is loaded on the first `!` command instead.
async function defaultCreateOps(): Promise<BashOps> {
  const mod: any = await import("@earendil-works/pi-coding-agent");
  return mod.createLocalBashOperations();
}

export function createBang(pi: any, deps: Deps = {}): void {
  const createOps = deps.createOps ?? defaultCreateOps;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));

  let enabled = true;
  // The session context, captured from session_start; the nudge reads
  // ctx.isIdle() at delivery time.
  let ctx: any;

  function log(message: string): void {
    try {
      process.stderr.write(`[bang] ${message}\n`);
    } catch {
      // best-effort logging
    }
  }

  function nudge(command: string, exitCode: number): void {
    // Reading ctx.isIdle() can throw on a stale ctx (after /reload or a
    // session switch); default idle=false — with triggerTurn:true, followUp is
    // safe either way (queues when busy, still starts a turn when idle),
    // whereas steer would interrupt a live turn.
    let idle = false;
    try {
      idle = ctx && typeof ctx.isIdle === "function" ? Boolean(ctx.isIdle()) : false;
    } catch {
      idle = false;
    }
    try {
      pi.sendMessage(
        { content: nudgeText(command, exitCode), customType: "bang", display: true },
        { triggerTurn: true, deliverAs: deliveryMode(idle) },
      );
    } catch (error) {
      // This runs inside a timer callback; an escaped throw would kill the pi
      // process. Contain it and make the loss observable.
      log(`nudge for \`${command}\` failed: ${String(error)}`);
      try {
        ctx?.ui?.notify?.(`pi-bang: could not trigger a turn: ${String(error)}`, "error");
      } catch {
        // best-effort surface
      }
    }
  }

  pi.on("session_start", (_event: unknown, sessionCtx: any) => {
    ctx = sessionCtx;
  });

  pi.on("user_bash", (event: any, eventCtx: any) => {
    if (eventCtx) ctx = eventCtx;
    return {
      operations: {
        async exec(command: string, cwd: string, options: any) {
          const local = await createOps();
          const result = await local.exec(command, cwd, options);
          const aborted = Boolean(options?.signal?.aborted);
          if (
            shouldNudge({
              enabled,
              excludeFromContext: Boolean(event.excludeFromContext),
              aborted,
              exitCode: result.exitCode,
            })
          ) {
            // Macrotask defer: pi's recordBashResult runs in the promise
            // continuation after this resolve, and the nudge turn must not
            // start before the output entry exists.
            setTimer(() => nudge(event.command, result.exitCode as number), 0);
          }
          return result;
        },
      },
    };
  });

  pi.registerCommand("bang", {
    description: "Toggle reacting to `!` command completions (on | off | status)",
    handler: async (args: string, cmdCtx: any) => {
      if (cmdCtx) ctx = cmdCtx;
      const action = parseToggle(args);
      if (action === "on") enabled = true;
      if (action === "off") enabled = false;
      try {
        cmdCtx?.ui?.notify?.(
          `pi-bang is ${enabled ? "on" : "off"}: \`!\` completions ${enabled ? "trigger a turn" : "stay passive"}.`,
          "info",
        );
      } catch {
        // best-effort surface
      }
    },
  });
}

export default function (pi: any) {
  createBang(pi);
}
