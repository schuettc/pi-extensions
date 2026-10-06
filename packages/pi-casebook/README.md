# pi-casebook

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that connects your pi sessions to [casebook](https://casebook.tools).

## What it does

- **Journals git/gh bash calls** with the pi session id — bash tool calls that invoke `git` or `gh` are sent to `casebook record --harness pi`; casebook stores verbs and targets, never the full command line.
- **Briefs the first turn** — the first agent turn of each session gets the repo briefing (`casebook brief`) as a hidden context message, so the agent knows the state of your repo without you having to ask.
- **Syncs in the background** — `casebook sync --no-github` runs at session start and shutdown; the 30-minute launchd job installed by kempt handles the GitHub refresh.
- **Names the session for the casebook page** — at session start, on every rename (`/name`), and at each turn's end, it runs `casebook session-info` with the session's pi name, pi's process id, and its parent session: the id of the session named by `parentSession` in its header (for a pi-subagents worker kept in memory, the session it runs under). When pi replaces the session in its process (`/fork`, `/new`, `/resume`) or quits, it reports the session ended. The casebook page shows the name, and leaves out workers when it offers sessions: a session is a worker only while its parent is live in the same pi process. So a fork stays a session you can choose, whether it runs in a pi process of its own (its parent is elsewhere) or replaced its parent in-process (its parent ended), and even while it runs subagents of its own; those subagents are workers.
- **Reports settled turns** — when the agent settles, it runs `casebook settled --session <id> --shown <deliveries>`, reporting which casebook channel deliveries the agent was actually shown this run, so casebook never marks a message unanswered before the agent has seen it. Deliveries that arrive mid-run are held and reported in the next run.

## Requirements

The `casebook` binary must be installed. It is distributed via the kempt manifest at `tackle/cmd/casebook/kempt.toml`. Install it with [kempt](https://github.com/schuettc/kempt).

## Inert without the binary

If the casebook binary is not found, this extension registers no hooks and has zero effect on your pi session.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CASEBOOK_BIN` | `~/.local/bin/casebook` | Path to the casebook binary |

## Privacy

casebook stores verb and target metadata (e.g. `git push → origin/main`), never the full command line or its arguments.
