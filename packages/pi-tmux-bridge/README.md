# pi-tmux-bridge

A pi extension that feeds this terminal's tmux state from a running pi session — a status line reflecting model and context usage, an attention bell on the pane's own tty, and session-bus (muster) registration — so a pi session presents in tmux the way a harnessed coding session should.

## What it does

- **Status.** On session start and as context fills, writes per-pane state (`src/state.ts`) that a tmux status line can render (model, context %). Removed again on shutdown.
- **Attention.** Rings the bell (`src/bell.ts`) on *this* pane's tty only — never every same-directory session — lighting tmux's attention banner / window indicator and the terminal's tab bell.
- **Bus.** Registers the session with a lightweight muster bus (`src/muster.ts`) at start, drains queued messages on settle, and deregisters at end.
- **Coordinating with channels.tools.** When [channels.tools](../channels.tools) is holding mail (`channels:pending` with a count above zero) or has delivered since the last `agent_start` (`channels:delivered`), the settle drain is skipped: channels.tools is already starting a turn for that mail, and pi would run the drain's reminder after it, stale. The settle that follows the channel's turn drains against fresh bus state. Announcements for another session id are ignored. Without channels.tools nothing changes.
- **tmux resolution.** `src/tmux.ts` resolves the current socket/pane/session and sanitizes the session id before it reaches tmux (it is later used to build file paths).

Every handler is best-effort: it sits directly on a pi lifecycle event, and a harness that fails a session start, a turn, or a shutdown over a status bar or a bus registration is worse than no harness at all.

## Install

```sh
pi install npm:pi-tmux-bridge
```

## Tests

```sh
node --test src/*.test.ts
```

The pure tmux/state/bell/muster logic is unit-tested against injectable stand-ins for tmux and the shell, and `src/index.test.ts` exercises the wired lifecycle against a fake pi.
