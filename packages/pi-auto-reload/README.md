# pi-auto-reload

Reloads a [pi](https://github.com/earendil-works/pi) session automatically, when it is idle, after the installed pi packages change on disk. That covers updates from `pi update`, `pi install`, or a tool that manages pi packages for you, such as kempt.

## Why

A running pi session keeps the code it loaded at startup, but it loads anything it needs later from the files on disk. After an in-place package update, a session can run a mix of old and new code until you type `/reload`. That's easy to miss when you have several sessions open.

## How it works

- **At session start** it records a fingerprint: the `packages` list in `settings.json`, plus the version and modification time of each installed npm package.
- **Every 15 seconds, and whenever the agent finishes a run,** it checks the fingerprint again. When it changes, the status bar shows `packages updated · reloading when idle`.
- **It reloads only when the session is idle:** no response streaming, no queued messages, and no permission or other prompt open. A busy session reloads when it finishes.
- **The reload is pi's own `/reload`:** the extension runs a hidden `/auto-reload-now` command that calls `reload()`. Nothing is sent to the model, and a half-typed draft in the editor is kept.

## Install

```bash
pi install npm:pi-auto-reload
```

## Testing it

Set `PI_AUTO_RELOAD_EXTRA` to a comma-separated list of extra files to watch. Touching one of them counts as a package update:

```bash
PI_AUTO_RELOAD_EXTRA=/tmp/pi-auto-reload-probe pi
# in another terminal
touch /tmp/pi-auto-reload-probe
```

`PI_CODING_AGENT_DIR` is honored for the location of `settings.json` and installed packages.

## License

MIT
