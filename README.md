# pi-extensions

Extensions for the [pi](https://pi.dev) coding agent, developed in one
workspace and published as independent npm packages. Larger tools get their
own `.tools` domain (like galley/muster/hail); Channels lives at
[channels.tools](https://channels.tools).

| Package | Status | What it does |
|---|---|---|
| [`pi-quiet`](packages/pi-quiet) | ready | Collapses each bash call to one line in the TUI; `ctrl+o` restores full built-in rendering. Display-only. |
| [`channels.tools`](packages/channels.tools) ([channels.tools](https://channels.tools)) | ready | Connect channel servers that push events into a live pi session — wake when idle, queue when busy — and proxy their tools. Client for the `claude/channel` convention, with a dependency-free reference server. |

## Publishing standard

- One package per directory under `packages/`, npm workspaces.
- MIT, semver, `pi-package` keyword, `pi` key in `package.json`.
- CI typechecks on every push; publishing happens only from CI on a
  `<package>-v*` tag (e.g. `pi-quiet-v0.1.0`). Manual `npm publish` is not
  part of the workflow.

## Development

```bash
npm install
npm run typecheck
```

Try a package against a live pi session without installing:

```bash
pi -e ./packages/pi-quiet/src/index.ts
```
