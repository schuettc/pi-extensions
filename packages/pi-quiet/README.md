# pi-quiet

Calm tool rendering for the [pi](https://pi.dev) coding agent.

pi renders every bash call with the full command text, a multi-line output
preview, and timing — useful when you're debugging a command, noisy when the
agent is doing routine work. `pi-quiet` collapses each bash call to two lines:

```
$ ls -la /tmp | head -20
  → ok · 15 lines · … -rw-r--r--  1 user  staff  5742 Aug 26 22:17 README.md
```

Multi-line commands show `(+N lines)`. Failures show a red `error`. Streaming
shows `… running`.

Press **ctrl+o** (pi's `app.tools.expand` binding) and the stock built-in
rendering returns in full — complete commands, full output, truncation
warnings. Press it again to re-collapse. It's a live toggle over the whole
transcript: work collapsed, expand when something looks off.

## What it owns, by construction

The extension re-registers the built-in `bash` tool via pi's own `createBashToolDefinition`. It is the one package on a rig that registers `bash`, and it owns three things about it:

- **Rendering.** The two render slots above. Execution *is* the built-in tool: the model receives the full output, permission systems, reviewers, and sandboxes that hook execution are unaffected, and session logs store the full result.
- **pi's shell settings.** The built-in is constructed with `shellCommandPrefix` and `shellPath` from your global settings, exactly as pi does. Project-level `.pi/settings.json` is not read for these two, because pi's project-trust decision is not visible to extensions and a shell prefix must never come from an untrusted repo.
- **Session identity.** Every command's environment carries `AGENT_SESSION_ID`, set from pi's per-command `PI_SESSION_ID`. Tools that scope themselves to the session that ran them (muster, galley, tackle) read that neutral name. It is set per command from pi's live session, never from the extension's process environment, so an in-process subagent can never leave the parent's commands carrying a child's id.

## Install

```bash
pi install npm:pi-quiet
```

Or try it for one session:

```bash
pi -e npm:pi-quiet
```

pi shows a one-time notice that the built-in `bash` tool was overridden —
that's this extension, and it's expected.

## Caveats

- Covers `bash` only (the dominant chatter source). `read`/`grep`/`find`/`ls`
  may follow.
- The expanded path delegates to pi's built-in renderer, so a pi upgrade that
  reshapes renderer internals can require a patch release here.
