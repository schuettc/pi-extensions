# pi-creel

`request_secret` for the pi coding agent — capture an API key into a local
`.env` **without it ever entering the chat/context**.

When the model needs a secret, it calls `request_secret` instead of asking the
user to paste one into the transcript. The tool opens a masked
`tmux display-popup` running the [`creel`](https://tackle.tools) binary; the
user pastes once, and the value goes straight from the popup into the target
`.env`. The pi process — and therefore the model — receives only a status token
(`added` / `updated` / `cancelled` / `error`), never the value.

## Tool

`request_secret(name, dest?)`

- `name` — the environment-variable name, e.g. `OPENAI_API_KEY`.
- `dest` — path to the `.env` (relative to cwd), default `.env`.

## Consuming the secret

The value is written to `.env` mid-session, but the pi process env is frozen at
launch, so the model can't just read `process.env.NAME`. Two supported paths,
both of which keep the value out of the chat/context:

- **`creel exec NAME[,NAME2,...] -- <command>`** runs `<command>` with each
  value in its environment **only** — never printed, never in argv, never in an
  error (a missing key is a hard error naming just the key). This is the
  language-agnostic way to hand a mid-session key to a child process
  (`creel exec OPENAI_API_KEY -- node run.mjs`).
- **`process.env.NAME` after a relaunch**, once the new process inherits the
  updated `.env`.

The model should **not** read the `.env` itself. The `added` / `updated` reply
from `request_secret` states this consumption path directly.

## Requirements

- A tmux session (`$TMUX`). Without one the tool fails fast and asks the user to
  paste manually.
- The `creel` binary on `PATH` (installed via the tackle family download /
  kempt). Without it the tool returns an actionable error.

## How the value stays out of context

`creel` does the masked read, the `.env` upsert (atomic, `chmod 600`), and the
gitignore check inside the popup. It writes only a one-word status token to a
temp file that this extension polls. The seam between the two —
`creel <NAME> --dest <PATH> --status-file <FILE>` — carries a name, a
destination, and a token, and nothing else. The same seam lets other harnesses
(Claude Code / Cursor, via a future `creel mcp`) reuse the identical capture
core.

## Design

Pure pieces (schema, popup command, token→reply mapping) live in `capture.ts`;
`index.ts` is thin, injectable pi/tmux/fs wiring — the same split as `pi-wakeup`.
