# pi-bang

A pi extension that makes `!` shell commands **active**: when a user-run `!command` completes, the session triggers a model turn to react to the output, instead of the output sitting passively in context until your next prompt.

Pi's built-in behavior records a `!` command's output as a `bashExecution` entry that is converted into a user message at the *next* LLM request — so the model only sees (and reacts to) the output once you type something else. With pi-bang loaded, the completion itself starts the turn.

## Behavior

- `!command` — runs as normal; on completion a short nudge message (`customType: "bang"`) is sent with `triggerTurn: true`. The nudge is a pointer, not a payload: the output is already in context via pi's own `bashExecution` → user-message conversion, so it is never duplicated.
- `!!command` — untouched. Its output is excluded from context by pi, so there is nothing to react to.
- Cancelled (Esc) or signal-killed commands don't nudge.
- Non-zero exit codes **do** nudge — a failing command is exactly what you want the model to look at — and the exit code is named in the nudge.
- `/bang on | off | status` — toggle the turn-trigger at runtime. Default: on (installing the package is the opt-in).
- **Auto-space**: typing `!` into an empty editor expands to `! ` — you see bash mode engage and the command stays readable. Typing `!` again immediately upgrades the prefix to `!! `, so the hidden variant stays two keystrokes. Pi trims the command after the prefix, so `! ls` and `!ls` parse identically. A `!` typed mid-text, pasted, or arriving in an escape sequence is never touched.

## Design

- **Execution stays pi's own.** The `user_bash` handler wraps `createLocalBashOperations()` — pi's built-in local shell backend — and only observes completion. Command semantics, streaming, truncation (2000 lines / 50KB tail), and full-output temp files are all unchanged.
- **Ordering is load-bearing.** Pi records the `bashExecution` entry *after* the wrapped `exec` resolves, in the same promise chain. The nudge is deferred with a macrotask timer so the entry exists before the turn starts. This ordering is an internal pi detail; a first-class `user_bash_done` event upstream would make it contractual (planned ask).
- **Busy-gated delivery.** At nudge time we read the authoritative `ctx.isIdle()`: idle → `steer` a fresh turn; a turn already streaming → `followUp`, which lands after pi flushes the deferred bash entry at `agent_end`. A stale-ctx throw falls back to `followUp`, the safe mode either way.
- **Editor politeness.** Auto-space is a `CustomEditor` subclass installed via `ctx.ui.setEditorComponent` — only when no other extension has replaced the editor (a vim-mode editor, say, keeps priority and pi-bang just logs). An install failure never affects the turn-trigger behavior.
- **Best-effort.** The nudge runs in a timer callback; every failure is contained and surfaced via notify/stderr rather than taking the session down. The pure decisions (skip rules, nudge text, delivery mode, toggle parsing) live in `src/bang.ts` and are unit-tested with zero mocking; `src/index.ts` is the thin pi wiring — the same split pi-wakeup uses.

## Known limitations

- **One `user_bash` interceptor wins.** Like any extension returning `operations` from `user_bash`, pi-bang replaces the execution backend for `!` commands. If you also load an execution-routing extension (SSH, sandbox/VM), the two will conflict — pi-bang always executes locally.
- The enabled/disabled state is session-local and resets to **on** at each session start.
- `/bang off` silences the turn-trigger but leaves auto-space active; the two are independent behaviors.

## Tests

`node --test src/*.test.ts` — pure skip/text/delivery/toggle/keystroke rules, plus the wired behavior against a fake pi with a manual timer queue and a fake editor base: nudge-after-timer ordering, steer-vs-followUp, `!!`/abort/disabled skips, exec passthrough, contained `sendMessage` throw, stale-ctx fallback, auto-space/upgrade typing flows, and editor-ownership politeness.

## Install

```sh
pi install npm:pi-bang
```

Or try it against a live session without installing:

```sh
pi -e ./packages/pi-bang/src/index.ts
```
