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
