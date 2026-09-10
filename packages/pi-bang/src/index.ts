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

import { bangKeyAction, deliveryMode, nudgeText, parseToggle, shouldNudge } from "./bang.ts";

type BashOps = { exec: (command: string, cwd: string, options: any) => Promise<{ exitCode: number | null }> };

export type Deps = {
  // Injectable so the wiring is testable without pi's real shell backend,
  // real editor base class, or real time passing.
  createOps?: () => Promise<BashOps> | BashOps;
  setTimer?: (fn: () => void, ms: number) => unknown;
  loadEditorBase?: () => Promise<any>;
};

// Lazy: a top-level import of the pi package pulls its entire runtime, which
// only resolves inside a live pi process (and breaks node --test). The real
// backend and editor base are loaded on first use instead.
async function defaultCreateOps(): Promise<BashOps> {
  const mod: any = await import("@earendil-works/pi-coding-agent");
  return mod.createLocalBashOperations();
}

async function defaultLoadEditorBase(): Promise<any> {
  const mod: any = await import("@earendil-works/pi-coding-agent");
  return mod.CustomEditor;
}

export function createBang(pi: any, deps: Deps = {}): void {
  const createOps = deps.createOps ?? defaultCreateOps;
  const loadEditorBase = deps.loadEditorBase ?? defaultLoadEditorBase;
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

  // Auto-space editor nicety: typing `!` into an empty editor expands to
  // `! ` (bash mode announced, command kept readable); a second `!` upgrades
  // to `!! ` so the hidden variant stays typeable. Pi's submit handler trims
  // the command after the prefix, so the padded forms parse identically.
  // Installed only when no other extension has replaced the editor — blindly
  // overriding would silently drop e.g. a vim-mode editor's behavior.
  async function installEditor(sessionCtx: any): Promise<void> {
    try {
      const ui = sessionCtx?.ui;
      if (!ui || typeof ui.setEditorComponent !== "function") return;
      if (typeof ui.getEditorComponent === "function" && ui.getEditorComponent() !== undefined) {
        log("another extension owns the editor; auto-space disabled");
        return;
      }
      const Base = (await loadEditorBase()) as new (
        ...args: any[]
      ) => { getText(): string; setText(text: string): void; handleInput(data: string): void };
      class BangEditor extends Base {
        handleInput(data: string): void {
          const action = bangKeyAction(data, this.getText());
          if (action === "autospace") {
            super.handleInput(data);
            super.handleInput(" ");
            return;
          }
          if (action === "upgrade") {
            this.setText("!! ");
            return;
          }
          super.handleInput(data);
        }
      }
      ui.setEditorComponent(
        (tui: any, theme: any, keybindings: any) => new BangEditor(tui, theme, keybindings),
      );
    } catch (error) {
      // The nudge behavior must survive an editor-install failure.
      log(`auto-space editor not installed: ${String(error)}`);
    }
  }

  pi.on("session_start", async (_event: unknown, sessionCtx: any) => {
    ctx = sessionCtx;
    await installEditor(sessionCtx);
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
