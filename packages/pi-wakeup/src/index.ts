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

import {
  clampDelaySeconds,
  deliveryMode,
  wakeupMessage,
} from "./schedule.ts";

type Pending = { prompt: string; reason: string };

export type Deps = {
  // Injectable so the wiring is testable without real time passing. Default to
  // the globals; a test passes controllable stand-ins.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
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

  const pending = new Map<string, Pending>();
  const timers = new Map<string, unknown>();
  // The session context, captured from session_start and refreshed on each
  // tool call; deliver() reads ctx.isIdle() at fire time.
  let ctx: any;
  let counter = 0;

  function log(message: string): void {
    try {
      process.stderr.write(`[wakeup] ${message}\n`);
    } catch {
      // best-effort logging
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
    // leave a half-fired wakeup armed.
    forget(id);
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
  });
  pi.on("session_shutdown", () => {
    for (const handle of timers.values()) clearTimer(handle);
    timers.clear();
    pending.clear();
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
      pending.set(id, { prompt, reason });
      const handle = setTimer(() => deliver(id), delay * 1000);
      timers.set(id, handle);
      try {
        pi.appendEntry?.("wakeup_scheduled", { id, delaySeconds: delay, reason, fireAtMs });
      } catch {
        // best-effort persistence
      }
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
      }
      return { content: [{ type: "text", text: `Cancelled ${count} pending wakeup${count === 1 ? "" : "s"}.` }] };
    },
  });
}

export default function (pi: any) {
  createWakeup(pi);
}
