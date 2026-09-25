# pi-ledger

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that connects your pi sessions to [ledger](https://tackle.tools).

## What it does

- **Journals git/gh bash calls** with the pi session id — bash tool calls that invoke `git` or `gh` are sent to `ledger record --harness pi`; ledger stores verbs and targets, never the full command line.
- **Briefs the first turn** — the first agent turn of each session gets the repo briefing (`ledger brief`) as a hidden context message, so the agent knows the state of your repo without you having to ask.
- **Syncs in the background** — `ledger sync --no-github` runs at session start and shutdown; the 30-minute launchd job installed by kempt handles the GitHub refresh.

## Requirements

The `ledger` binary must be installed. It is distributed via the kempt manifest at `tackle/cmd/ledger/kempt.toml`. Install it with [kempt](https://github.com/schuettc/kempt).

## Inert without the binary

If the ledger binary is not found, this extension registers no hooks and has zero effect on your pi session.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `LEDGER_BIN` | `~/.local/bin/ledger` | Path to the ledger binary |

## Privacy

ledger stores verb and target metadata (e.g. `git push → origin/main`), never the full command line or its arguments.
