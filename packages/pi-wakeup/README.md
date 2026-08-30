# pi-wakeup

A pi extension giving a running session two tools to pace itself — the pi analog of Claude Code's `ScheduleWakeup` in dynamic mode.

## Tools

- **`schedule_wakeup(delay_seconds, prompt, reason?)`** — ask to be woken after a delay. When the timer fires, `prompt` is delivered back into the session: immediately as a steered turn if the session is idle, or queued as a `followUp` if a turn is already running. `delay_seconds` is clamped to `[60, 3600]`. Returns a wakeup id.
- **`cancel_wakeup(id?)`** — cancel one pending wakeup by id, or every pending wakeup when the id is omitted.

Use it to re-check something without a human poking the session — a build that takes a few minutes, a remote queue, a rate-limit window — rather than busy-waiting.

## Design

- **Session-local.** A wakeup is an in-process `setTimeout`, not a cron job. It lives and dies with the session. This is deliberate: subagents and pacing in pi are in-process (the muster-teammate shape is shelved), and cross-session scheduling is a different product (`cron` + `pi -p`), not this tool.
- **Busy-gated delivery.** `agent_start` / `agent_settled` track whether a turn is running; delivery picks `steer` (idle) or `followUp` (busy) accordingly, so a wakeup never interrupts a turn in flight.
- **Best-effort.** Every handler and the timer callback swallow-and-log on error — a missed wakeup must never take the session process down. The pure decisions (clamp, delivery mode, message shape) live in `src/schedule.ts` and are unit-tested with zero mocking; `src/index.ts` is the thin pi wiring, in the same split the guardrails package uses.
- **Persistence.** Each schedule / fire / cancel is written with `pi.appendEntry` so the session transcript records the wakeup lifecycle.

## Known follow-up

**Re-arming a pending wakeup across a session *resume* is not yet implemented.** The extension API exposes no entry read-back, and reconstructing pending wakeups by parsing the transcript blind is exactly the kind of vacuous code this project avoids. Within a live session, wakeups fire; a session closed with a pending wakeup drops it on resume. When pi exposes a custom-entry reader (or a resume hook carrying prior entries), `SessionStartEvent.reason === "resume"` is the place to re-arm from the persisted `wakeup_scheduled` / `wakeup_fired` / `wakeup_cancelled` records.

## Tests

`node --test src/*.test.ts` — pure clamp/delivery/message logic plus the wired tool behavior (registration, idle-vs-busy delivery, clamp, cancel-one, cancel-all, a throwing `sendMessage` contained, shutdown cleanup) against a fake pi with an injectable timer.

## Install

```sh
pi install npm:pi-wakeup
```
