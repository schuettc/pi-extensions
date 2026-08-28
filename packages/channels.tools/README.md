# channels.tools

Channels for the [pi](https://pi.dev) coding agent. Connect **channel
servers** — small local processes that push events into a live session — and
the session becomes reachable by your other tools: a push **wakes it when
idle** and **queues, coalesced, when it's mid-turn**. Each server's tools are
registered so the agent can act on what arrived.

Mail buses, code-review servers, CI and file watchers — anything on your
machine that can speak the (simple) protocol below can drive an agent
session. Servers are subprocesses the session itself spawns from your config;
nothing listens on a network.

Site: [channels.tools](https://channels.tools)

## Install

```bash
pi install npm:channels.tools
```

## Configure

`~/.pi/agent/channels.json` (global) or `<project>/.pi/channels.json`
(project wins on name collision). Nothing connects until one of these files
exists:

```json
{ "channelServers": {
    "file":  { "command": "node", "args": ["examples/file-channel.js", "inbox.txt"] },
    "my-bus": { "command": "mybus", "args": ["channel"], "env": {}, "cwd": "." }
} }
```

Real-world servers: [muster](https://muster.tools) (`muster channel`, a
multi-agent mail bus) and galley (`galley channel`, document review) both
speak this protocol.

## Behavior

- An event arriving while the session is idle starts a turn immediately
  (delivered as a steer with the server's event payload).
- Events arriving mid-turn are buffered and delivered coalesced once the turn
  settles (pi's `agent_settled`, not `agent_end`) — a running turn is never
  interrupted.
- Each server's tools are registered under their own names, so instructions a
  server hands the agent stay literally true.
- `AGENT_SESSION_ID` is exported before any server spawns; servers can read
  it at startup to scope themselves to this session.
- A server that crashes is retried with backoff; its tools re-register on
  reconnect. A misbehaving or non-conforming process is killed and logged.

## The protocol

A channel server is a subprocess speaking **newline-delimited JSON-RPC 2.0
over stdio** (no `Content-Length` framing, no network, no ports).

1. **Handshake** — client sends `initialize`; the server's result must
   declare `capabilities.experimental["claude/channel"]` and may include an
   `instructions` string (injected as guidance) and `tools` (see below).
   Servers not declaring the capability are rejected.
2. **Events** — the server pushes `notifications/claude/channel` with a
   `params` payload: freeform text plus optional `meta` attributes
   (`count`, `thread_id`, `from`, …). Multiple notifications may be
   coalesced by the client; servers that pre-coalesce should say how many
   events one push represents in `meta.count`.
3. **Tools** — servers may expose tools (name, description, JSON-schema
   input). The client registers them with pi and proxies invocations via
   `tools/call`.
4. **Shutdown** — SIGTERM on session end (SIGKILL after a grace period).

The reference server in [`examples/file-channel.js`](examples/file-channel.js)
implements the whole convention dependency-free (the server itself is ~60
lines; the rest of the file is the demo): append a line to a watched file and
an idle pi session wakes with it.

```bash
node examples/file-channel.js --demo          # narrated walkthrough, no pi needed
node examples/file-channel.js --demo --wire   # the same exchange as raw wire frames
```

## Test

```bash
npm test                        # unit, no binaries needed
node --test test/live.test.ts   # integration; skips servers not installed
```
