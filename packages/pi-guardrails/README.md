# pi-guardrails

A pi extension that keeps pi off the metered `anthropic` provider and appends your own harness policy prose into every turn.

## What it does

- Captures a safe (non-metered) baseline model at `session_start` as the revert target of last resort.
- On `model_select`, reverts an anthropic (metered) selection back to a safe model — the previous model if it was itself safe, otherwise the captured baseline — unless `PI_ALLOW_METERED_ANTHROPIC` is exactly `1` (any other value, `0` included, leaves the guardrail armed). The revert is attempted first and success is only reported once it lands; a failed revert, or a metered selection with no safe target at all, notifies at `error` level instead of leaving the user silently on the metered provider. No path ever calls `setModel` with an anthropic model.
- On `before_agent_start`, appends your harness policy prose (loaded from config, see below) to the system prompt. With no configured prose the system prompt is returned unchanged.

## Install

```sh
pi install npm:pi-guardrails
```

## Policy prose is user-supplied

**This package ships no baked-in policy prose.** The rules you want carried into every turn are read at runtime from your own config file:

```
~/.pi/agent/extensions/pi-guardrails/config.json
```

with a `prose` field that is an array of strings:

```json
{
  "prose": [
    "Your first earned rule.",
    "Your second earned rule."
  ]
}
```

Each string becomes a line under a fixed header (`Harness policy — earned rules from operating this harness, not permission settings:`) appended to the system prompt. A missing, unreadable, or malformed file — or a missing/non-array `prose` field — is treated as no prose: the system prompt is left untouched and turn start never fails.

## Permission policy is separate

The metered-provider guardrail here is independent of pi's file/tool permission system. If you want to allow `read`/`write`/`edit` and deny `*.env`, `~/.ssh/*`, etc., configure that with a permission-system extension (e.g. `@gotgenes/pi-permission-system`) and its own config — this package does not manage permissions.

## Tests

```sh
node --test src/*.test.ts
```

The pure gate/prose logic (`src/gate.ts`, `src/prose.ts`) and the wired extension behavior (`src/index.ts`) are unit-tested with zero mocking against a fake pi.
