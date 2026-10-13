// pi-wakeup — schedule_wakeup / cancel_wakeup tools.
//
// The pi analog of Claude Code's ScheduleWakeup in dynamic mode: a running
// session can pace itself, asking to be woken after a delay to re-check
// something (a build, a remote queue) without a human poking it. Wakeups are
// session-local — an in-process timer, not a cron job. The pure decisions
// (clamp, delivery mode, message) live in schedule.ts; this file is the thin,
// best-effort pi wiring, in the same split guardrails uses.
//
// Delivery: at fire time we ask pi's authoritative ctx.isIdle() rather than
// tracking a local busy flag (which races the real streaming state), and we
// always pass triggerTurn:true — pi's dispatch routes a triggerTurn:false
// message into a dead branch that neither steers nor queues, so deliverAs is
// only honoured alongside triggerTurn:true. Idle -> steer a fresh turn; busy
// -> followUp after the current turn (never interrupts it).
//
// Persistence: each schedule / fire / cancel / delivery-failure is written with
// pi.appendEntry so the session transcript records the wakeup lifecycle.
// Re-arming a pending wakeup across a session RESUME is a documented follow-up
// (the extension API exposes no entry read-back). Within a live session,
// wakeups fire.

import { execFileSync } from "node:child_process";
import {
  clampDelaySeconds,
  decideDisplayMode,
  deliveryMode,
  formatCountdown,
  wakeupMessage,
} from "./schedule.ts";

// fireAtMs is tracked per pending wakeup so the countdown display can derive
// how long is left; it's the same value persisted in the wakeup_scheduled entry.
type Pending = { prompt: string; reason: string; fireAtMs: number };

// How often the countdown re-renders while anything is pending. The interval is
// unref'd so it never holds the process open on its own.
const REFRESH_MS = 30_000;

export type Deps = {
  // Injectable so the wiring is testable without real time passing. Default to
  // the globals; a test passes controllable stand-ins.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
  // The countdown's periodic refresh, also injectable so tests can drive it.
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  // The tmux runner, mirroring pi-tmux-bridge's `tmux()`: best-effort, returns
  // the trimmed stdout or undefined. Injected so the tmux-bar path is testable.
  runTmux?: (socket: string, args: string[]) => string | undefined;
  // The environment the tmux mode decision reads ($TMUX / $TMUX_PANE).
  env?: NodeJS.ProcessEnv;
};

const SCHEDULE_PARAMS = {
  type: "object",
  properties: {
    delay_seconds: {
      type: "number",
      description: "Seconds from now to wake up. Clamped to [60, 3600].",
    },
    prompt: {
      type: "string",
      description: "The message delivered back into the session when the wakeup fires.",
    },
    reason: {
      type: "string",
      description: "One short line on why you are waking up. Shown with the delivered prompt.",
    },
  },
  required: ["delay_seconds", "prompt"],
};

const CANCEL_PARAMS = {
  type: "object",
  properties: {
    id: {
      type: "string",
      description: "The wakeup id to cancel. Omit to cancel every pending wakeup.",
    },
  },
};

export function createWakeup(pi: any, deps: Deps = {}): void {
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      // Don't let a pending wakeup hold the event loop open on an exit path
      // that skips session_shutdown. Interactive sessions keep other handles
      // alive, so the timer still fires.
      const unrefable = handle as { unref?: () => void };
      if (typeof unrefable.unref === "function") unrefable.unref();
      return handle;
    });
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());
  const setIntervalFn =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const handle = setInterval(fn, ms);
      // Unref'd like the per-wakeup timer: the refresh loop is cosmetic and must
      // never be the reason the process stays alive.
      const unrefable = handle as { unref?: () => void };
      if (typeof unrefable.unref === "function") unrefable.unref();
      return handle;
    });
  const clearIntervalFn =
    deps.clearInterval ??
    ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
  const runTmux =
    deps.runTmux ??
    ((socket: string, args: string[]) => {
      // Best-effort, mirroring pi-tmux-bridge's tmux(): a display call must never
      // fail a tool call, a timer callback, or a shutdown.
      try {
        return execFileSync("tmux", ["-L", socket, ...args], {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        return undefined;
      }
    });
  const env = deps.env ?? process.env;

  const pending = new Map<string, Pending>();
  const timers = new Map<string, unknown>();
  // The session context, captured from session_start and refreshed on each
  // tool call; deliver() reads ctx.isIdle() at fire time.
  let ctx: any;
  let counter = 0;

  // Countdown display state, decided ONCE at session_start. In tmux mode we set
  // a pane-session option the status line renders; otherwise we draw a widget
  // above the pi editor. intervalHandle re-renders the minutes ticking down.
  let displayTarget: "tmux" | "widget" = "widget";
  let tmuxSocket: string | undefined;
  let tmuxPane: string | undefined;
  let intervalHandle: unknown;

  function log(message: string): void {
    try {
      process.stderr.write(`[wakeup] ${message}\n`);
    } catch {
      // best-effort logging
    }
  }

  // Local HH:MM in the machine's timezone — the fire time a human reads off
  // the bar. Kept here (not in schedule.ts) so the pure formatter stays TZ-free.
  function formatClock(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  // $TMUX is "<socket-path>,<pid>,<session>"; the socket NAME is the basename of
  // the first field, exactly as pi-tmux-bridge resolves it. undefined unless
  // both $TMUX and $TMUX_PANE are set.
  function resolveTmuxCtx(): { socket: string; pane: string } | undefined {
    const tmuxEnv = env.TMUX;
    const pane = env.TMUX_PANE;
    if (!tmuxEnv || !pane) return undefined;
    const socketPath = tmuxEnv.split(",")[0];
    if (!socketPath) return undefined;
    const socket = socketPath.slice(socketPath.lastIndexOf("/") + 1);
    if (!socket) return undefined;
    return { socket, pane };
  }

  // Decide where the countdown shows, ONCE, from the env and the tmux server's
  // global status strings. Best-effort: any failure falls back to the widget.
  function decideDisplay(): void {
    try {
      const t = resolveTmuxCtx();
      if (!t) {
        displayTarget = "widget";
        return;
      }
      const left = runTmux(t.socket, ["show", "-gv", "status-left"]);
      const right = runTmux(t.socket, ["show", "-gv", "status-right"]);
      displayTarget = decideDisplayMode(env, left, right);
      if (displayTarget === "tmux") {
        tmuxSocket = t.socket;
        tmuxPane = t.pane;
      }
    } catch (error) {
      displayTarget = "widget";
      log(`display mode decision failed: ${String(error)}`);
    }
  }

  // Render the current pending list to the chosen target, or clear it when
  // nothing is pending. Runs inside timer/interval callbacks, so every tmux and
  // ctx.ui call is guarded — a throw here must never escape (best-effort).
  function refresh(): void {
    const view = [...pending.values()].map((p) => ({ fireAtMs: p.fireAtMs, reason: p.reason }));
    const text = formatCountdown(view, now(), formatClock);
    try {
      if (displayTarget === "tmux" && tmuxSocket && tmuxPane) {
        // Follows muster's @muster_inbox pattern: set the user option on THIS
        // pane's session; `-u` unsets it so the status segment collapses.
        if (text === undefined) {
          runTmux(tmuxSocket, ["set-option", "-u", "-t", tmuxPane, "@wakeup"]);
        } else {
          runTmux(tmuxSocket, ["set-option", "-t", tmuxPane, "@wakeup", text]);
        }
        return;
      }
      // Widget mode. Guard ctx.ui: a ctx captured at session_start goes stale
      // after /reload or a session switch, and setWidget would then throw.
      if (ctx?.ui?.setWidget) {
        ctx.ui.setWidget("wakeup", text === undefined ? undefined : [text]);
      }
    } catch (error) {
      log(`display refresh failed: ${String(error)}`);
    }
  }

  // Re-render now and keep the refresh interval in step with the pending set:
  // start it when something is pending, stop it (and clear the display implied
  // by an empty set) when nothing is.
  function syncDisplay(): void {
    refresh();
    if (pending.size === 0) {
      stopInterval();
    } else if (intervalHandle === undefined) {
      intervalHandle = setIntervalFn(() => {
        try {
          refresh();
        } catch {
          // refresh is already guarded; this is belt-and-braces for the callback.
        }
        if (pending.size === 0) stopInterval();
      }, REFRESH_MS);
    }
  }

  function stopInterval(): void {
    if (intervalHandle !== undefined) {
      clearIntervalFn(intervalHandle);
      intervalHandle = undefined;
    }
  }

  function forget(id: string): void {
    const handle = timers.get(id);
    if (handle !== undefined) clearTimer(handle);
    timers.delete(id);
    pending.delete(id);
  }

  function deliver(id: string): void {
    const w = pending.get(id);
    if (!w) return;
    // Remove BEFORE delivering: one-shot, and a throw in sendMessage must not
    // leave a half-fired wakeup armed. Refresh the countdown off the firing.
    forget(id);
    syncDisplay();
    // Reading ctx.isIdle() can THROW: a ctx captured at session_start goes
    // stale after /reload, fork, or a session switch (assertActive() throws),
    // and this runs up to an hour later inside a setTimeout callback where an
    // escaped throw would kill the pi process. Guard it, and default idle=false
    // on any failure — with triggerTurn:true, "followUp" is safe whether or not
    // a turn is streaming (it queues when busy and still starts a turn when
    // idle), whereas "steer" would interrupt a live turn.
    let idle = false;
    try {
      idle = ctx && typeof ctx.isIdle === "function" ? Boolean(ctx.isIdle()) : false;
    } catch {
      idle = false;
    }
    try {
      pi.sendMessage(
        { content: wakeupMessage(w.prompt, w.reason), customType: "wakeup", display: true },
        { triggerTurn: true, deliverAs: deliveryMode(idle) },
      );
    } catch (error) {
      // A throw here runs inside the timer callback; uncaught it would kill the
      // pi process. Contain it, and make the loss OBSERVABLE — a silently
      // vanished wakeup is the worst outcome for a self-pacing tool.
      log(`delivery of ${id} failed: ${String(error)}`);
      try {
        pi.appendEntry?.("wakeup_delivery_failed", { id, error: String(error) });
      } catch {
        // best-effort persistence
      }
      try {
        ctx?.ui?.notify?.(`wakeup ${id} could not be delivered: ${String(error)}`, "error");
      } catch {
        // best-effort surface
      }
      return;
    }
    try {
      pi.appendEntry?.("wakeup_fired", { id, reason: w.reason });
    } catch {
      // best-effort persistence
    }
  }

  pi.on("session_start", (_event: unknown, sessionCtx: any) => {
    ctx = sessionCtx;
    // Decide the display target once, now, from the env + tmux status strings.
    decideDisplay();
    // Nothing is pending at a fresh start, so this just clears any stale display.
    refresh();
  });
  pi.on("session_shutdown", () => {
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
    pending.clear();
    stopInterval();
    // Clear the display: with pending now empty, refresh() unsets the option /
    // removes the widget.
    refresh();
  });

  pi.registerTool({
    name: "schedule_wakeup",
    label: "Schedule Wakeup",
    description:
      "Ask to be woken after a delay to re-check something without a human prompting you. The prompt is delivered back into this session when the timer fires (steered immediately if idle, queued after the current turn if busy). Session-local; delay clamped to [60, 3600] seconds.",
    promptSnippet: "schedule_wakeup(delay_seconds, prompt, reason?) — self-pace: wake this session after a delay",
    parameters: SCHEDULE_PARAMS,
    async execute(
      _id: string,
      params: { delay_seconds: number; prompt: string; reason?: string },
      _signal: unknown,
      _onUpdate: unknown,
      execCtx: any,
    ) {
      if (execCtx) ctx = execCtx;
      const delay = clampDelaySeconds(params.delay_seconds);
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      const reason = typeof params.reason === "string" ? params.reason : "";
      counter += 1;
      const id = `wake-${counter}`;
      const fireAtMs = now() + delay * 1000;
      pending.set(id, { prompt, reason, fireAtMs });
      const handle = setTimer(() => deliver(id), delay * 1000);
      timers.set(id, handle);
      try {
        pi.appendEntry?.("wakeup_scheduled", { id, delaySeconds: delay, reason, fireAtMs });
      } catch {
        // best-effort persistence
      }
      // Show the new wakeup and arm the refresh loop.
      syncDisplay();
      const reasonText = reason ? ` (${reason})` : "";
      return {
        content: [{ type: "text", text: `Scheduled ${id}: waking in ${delay}s${reasonText}.` }],
        details: { id, delaySeconds: delay },
      };
    },
  });

  pi.registerTool({
    name: "cancel_wakeup",
    label: "Cancel Wakeup",
    description:
      "Cancel a pending wakeup by id, or omit the id to cancel every pending wakeup in this session.",
    promptSnippet: "cancel_wakeup(id?) — cancel a pending wakeup, or all of them",
    parameters: CANCEL_PARAMS,
    async execute(_id: string, params: { id?: string }) {
      if (params && typeof params.id === "string" && params.id) {
        const existed = pending.has(params.id);
        forget(params.id);
        if (existed) {
          try {
            pi.appendEntry?.("wakeup_cancelled", { id: params.id });
          } catch {
            // best-effort persistence
          }
          // Update (or clear) the countdown now that one is gone.
          syncDisplay();
        }
        return {
          content: [
            { type: "text", text: existed ? `Cancelled ${params.id}.` : `No pending wakeup ${params.id}.` },
          ],
        };
      }
      const count = pending.size;
      for (const id of [...pending.keys()]) forget(id);
      if (count > 0) {
        try {
          pi.appendEntry?.("wakeup_cancelled", { all: true, count });
        } catch {
          // best-effort persistence
        }
        // Everything's gone: clear the display and stop the refresh loop.
        syncDisplay();
      }
      return { content: [{ type: "text", text: `Cancelled ${count} pending wakeup${count === 1 ? "" : "s"}.` }] };
    },
  });
}

export default function (pi: any) {
  createWakeup(pi);
}
