import { test } from "node:test";
import assert from "node:assert/strict";
import { createWakeup } from "./index.ts";
import type { Deps } from "./index.ts";

type Timer = { fn: () => void; ms: number; cancelled: boolean };

function harness(opts: { idle?: boolean; sendThrows?: boolean; idleThrows?: boolean } = {}) {
  const idle = opts.idle ?? true;
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event?: unknown, ctx?: unknown) => void>();
  const sent: Array<{ msg: any; opts: any }> = [];
  const entries: Array<{ type: string; data: any }> = [];
  const notifies: Array<{ text: string; level: string }> = [];
  const timers: Timer[] = [];

  const ctx = {
    isIdle: () => {
      if (opts.idleThrows) throw new Error("stale ctx");
      return idle;
    },
    ui: { notify: (text: string, level: string) => notifies.push({ text, level }) },
  };

  const pi = {
    registerTool(t: any) {
      tools.set(t.name, t);
    },
    on(ev: string, h: (event?: unknown, c?: unknown) => void) {
      handlers.set(ev, h);
    },
    sendMessage(msg: any, o: any) {
      if (opts.sendThrows) throw new Error("boom");
      sent.push({ msg, opts: o });
    },
    appendEntry(type: string, data: any) {
      entries.push({ type, data });
    },
  };

  const deps: Deps = {
    setTimer: (fn: () => void, ms: number) => {
      const t: Timer = { fn, ms, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (handle: unknown) => {
      (handle as Timer).cancelled = true;
    },
    now: () => 1000,
  };

  createWakeup(pi, deps);
  // Prime the captured ctx as a real session would via session_start.
  handlers.get("session_start")?.(undefined, ctx);

  const schedule = (params: any) =>
    tools.get("schedule_wakeup").execute("call", params, undefined, undefined, ctx);
  const cancel = (params: any) => tools.get("cancel_wakeup").execute("call", params);
  const fire = (t: Timer) => {
    if (!t.cancelled) t.fn();
  };
  return { tools, handlers, sent, entries, notifies, timers, schedule, cancel, fire };
}

test("registers both tools", () => {
  const h = harness();
  assert.ok(h.tools.has("schedule_wakeup"));
  assert.ok(h.tools.has("cancel_wakeup"));
});

test("scheduling arms a timer, persists, and firing while idle steers a fresh turn", async () => {
  const h = harness({ idle: true });
  const res = await h.schedule({ delay_seconds: 120, prompt: "check the build", reason: "CI" });
  assert.match(res.content[0].text, /waking in 120s/);
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].ms, 120000);
  assert.ok(h.entries.some((e) => e.type === "wakeup_scheduled" && e.data.delaySeconds === 120));

  h.fire(h.timers[0]);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].opts.triggerTurn, true); // ALWAYS true — see the dispatch note
  assert.equal(h.sent[0].opts.deliverAs, "steer");
  assert.match(h.sent[0].msg.content, /check the build/);
  assert.match(h.sent[0].msg.content, /CI/);
  assert.equal(h.sent[0].msg.customType, "wakeup");
  assert.ok(h.entries.some((e) => e.type === "wakeup_fired"));
});

test("firing while a turn is streaming keeps triggerTurn:true and queues as followUp", async () => {
  const h = harness({ idle: false });
  await h.schedule({ delay_seconds: 300, prompt: "ping" });
  h.fire(h.timers[0]);
  assert.equal(h.sent[0].opts.triggerTurn, true); // NOT false — false lands in pi's dead branch
  assert.equal(h.sent[0].opts.deliverAs, "followUp");
});

test("delay is clamped up to the floor", async () => {
  const h = harness();
  const res = await h.schedule({ delay_seconds: 1, prompt: "x" });
  assert.match(res.content[0].text, /waking in 60s/);
  assert.equal(h.timers[0].ms, 60000);
});

test("delay is clamped down to the ceiling", async () => {
  const h = harness();
  const res = await h.schedule({ delay_seconds: 999999, prompt: "x" });
  assert.match(res.content[0].text, /waking in 3600s/);
  assert.equal(h.timers[0].ms, 3600000);
});

test("cancel_wakeup by id prevents delivery and records the cancel", async () => {
  const h = harness();
  const res = await h.schedule({ delay_seconds: 120, prompt: "x" });
  const id = res.details.id;
  const c = await h.cancel({ id });
  assert.match(c.content[0].text, new RegExp(`Cancelled ${id}`));
  assert.equal(h.timers[0].cancelled, true);
  h.fire(h.timers[0]);
  assert.equal(h.sent.length, 0);
  assert.ok(h.entries.some((e) => e.type === "wakeup_cancelled" && e.data.id === id));
});

test("cancel_wakeup of an unknown id records NO cancel entry", async () => {
  const h = harness();
  const c = await h.cancel({ id: "wake-999" });
  assert.match(c.content[0].text, /No pending wakeup wake-999/);
  assert.equal(h.entries.filter((e) => e.type === "wakeup_cancelled").length, 0);
});

test("cancel_wakeup with no id cancels all pending", async () => {
  const h = harness();
  await h.schedule({ delay_seconds: 120, prompt: "a" });
  await h.schedule({ delay_seconds: 200, prompt: "b" });
  const res = await h.cancel({});
  assert.match(res.content[0].text, /Cancelled 2 pending wakeups/);
  h.timers.forEach(h.fire);
  assert.equal(h.sent.length, 0);
});

test("cancel-all with nothing pending reports zero and records no entry", async () => {
  const h = harness();
  const res = await h.cancel({});
  assert.match(res.content[0].text, /Cancelled 0 pending wakeups/);
  assert.equal(h.entries.filter((e) => e.type === "wakeup_cancelled").length, 0);
});

test("a throwing sendMessage is contained, recorded as a failure, and the wakeup is not left armed", async () => {
  const h = harness({ sendThrows: true });
  await h.schedule({ delay_seconds: 120, prompt: "x" });
  assert.doesNotThrow(() => h.fire(h.timers[0]));
  // Observable: a delivery-failed entry (NOT a silent vanish), and no fired entry.
  assert.equal(h.entries.filter((e) => e.type === "wakeup_delivery_failed").length, 1);
  assert.equal(h.entries.filter((e) => e.type === "wakeup_fired").length, 0);
  assert.equal(h.notifies.length, 1);
  // Removed on the first fire: firing the same handle again does nothing new.
  h.fire(h.timers[0]);
  assert.equal(h.entries.filter((e) => e.type === "wakeup_delivery_failed").length, 1);
});

test("a stale ctx whose isIdle() throws (after /reload) does not crash the timer callback; delivers as followUp", async () => {
  const h = harness({ idleThrows: true });
  await h.schedule({ delay_seconds: 120, prompt: "x" });
  assert.doesNotThrow(() => h.fire(h.timers[0]));
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].opts.triggerTurn, true);
  assert.equal(h.sent[0].opts.deliverAs, "followUp"); // safe fallback: never "steer"
});

test("session_shutdown clears every timer and no wakeup can still deliver", async () => {
  const h = harness();
  await h.schedule({ delay_seconds: 120, prompt: "a" });
  await h.schedule({ delay_seconds: 200, prompt: "b" });
  h.handlers.get("session_shutdown")!();
  assert.ok(h.timers.every((t) => t.cancelled));
  // Even if a stray timer callback still ran, pending was cleared, so nothing delivers.
  h.timers.forEach((t) => t.fn());
  assert.equal(h.sent.length, 0);
});
