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

## Display-only, by construction

The extension re-registers the built-in `bash` tool via pi's own
`createBashToolDefinition` and overrides only the two render slots. Execution
*is* the built-in tool:

- the model receives the full, untruncated-by-us output;
- permission systems, reviewers, and sandboxes that hook execution are
  unaffected;
- session logs store the full result.

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
