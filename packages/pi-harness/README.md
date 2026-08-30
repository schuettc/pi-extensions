# pi-harness

A pi extension that feeds this terminal's tmux state from a running pi session — a status line reflecting model and context usage, an attention bell on the pane's own tty, and session-bus (muster) registration — so a pi session presents in tmux the way a harnessed coding session should.

## What it does

- **Status.** On session start and as context fills, writes per-pane state (`src/state.ts`) that a tmux status line can render (model, context %). Removed again on shutdown.
- **Attention.** Rings the bell (`src/bell.ts`) on *this* pane's tty only — never every same-directory session — lighting tmux's attention banner / window indicator and the terminal's tab bell.
- **Bus.** Registers the session with a lightweight muster bus (`src/muster.ts`) at start, drains queued messages on settle, and deregisters at end.
- **tmux resolution.** `src/tmux.ts` resolves the current socket/pane/session and sanitizes the session id before it reaches tmux (it is later used to build file paths).

Every handler is best-effort: it sits directly on a pi lifecycle event, and a harness that fails a session start, a turn, or a shutdown over a status bar or a bus registration is worse than no harness at all.

## Install

```sh
pi install npm:pi-harness
```

## Tests

```sh
node --test src/*.test.ts
```

The pure tmux/state/bell/muster logic is unit-tested against injectable stand-ins for tmux and the shell, and `src/index.test.ts` exercises the wired lifecycle against a fake pi.
