# pi-hail

A pi coding-agent extension that connects each interactive pi session to the local **hail** daemon — so a pi you start on your Mac appears on your paired phone, streams its events there, and can take a prompt typed from the phone as if you'd typed it yourself. The extension owns only the pane it starts on, stays silent when no daemon is listening, and soft-locks each side against the other so the person and the phone never fight over the same turn.

## Install

Add the extension to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["npm:pi-hail"]
}
```

The extension loads on every pi session but is inert unless it owns an interactive TUI pane and the hail daemon is running. A missing or slow daemon never blocks pi.

### Required: answer approvals from your phone (0.4.0)

To let a paired phone answer a permission ask (allow/deny) as well as your Mac,
add `"pi-hail"` **after** `"pi-auto-review"` in the permission system's authorizer
chain, in `~/.pi/agent/extensions/pi-permission-system/config.json`:

```json
{
  "authorizerChain": ["pi-auto-review", "pi-hail"]
}
```

Order matters: `pi-auto-review` decides first, and only the asks it defers (the
ones that would otherwise prompt you) reach `pi-hail`, which opens the ask on
your phone and your Mac at once — the first answer on either device wins, with
no timeout. Choosing **More options…** on the Mac hands the ask back to the
permission system's full dialog (session-scope grants, etc.).

The permission system exposes no reader for its chain, so pi-hail cannot detect a
missing entry: **this README is the only guard.** Without the entry, asks are
answered on your Mac exactly as before — phone approvals simply do nothing.

## Connect / Disconnect (0.3.0)

Sessions running inside tmux under proj's `project/work` naming stream to your
phone automatically and stay openable even with the Mac asleep. The status line
shows `hail: disconnected · /hail connect` while disconnected.

- `/hail disconnect` — stop streaming this session to your phone (pi keeps running).
- `/hail connect` — resume streaming; the phone catches up on what it missed.

## Wire protocol (C4 summary)

One long-lived newline-delimited JSON (NDJSON) connection per pi process, to the daemon's Unix control socket at `$XDG_RUNTIME_DIR/hail/daemon.sock` (falling back to `$TMPDIR/hail/daemon.sock` on macOS). One JSON object per line.

**Register (first line, extension → daemon):**

```json
{ "cmd": "session.register", "args": { "sessionId": "...", "project": "...", "work": "...", "dir": "/abs/dir", "piVersion": "...", "extensionVersion": "0.1.0" } }
```

Daemon replies with `{ "ok": true, "data": { "hostId", "daemonVersion", "accepted", "have" } }` on success, or `{ "ok": false, "error": "version_mismatch: ..." }` on a version mismatch (C6) — in which case the extension shows one notice and goes inert.

**Then, one object per line, both directions:**

- **extension → daemon:** `{ "event": <pi rpc event verbatim> }` · `{ "turn": "start" | "end" }` · `{ "lock": "held" | "released" }` · `{ "exit": { "code": n } }` · `{ "refused": { "requestId", "reason": "turn_running" } }` · `{ "ask": { "requestId", "title", "message", "toolName"?, "surface"?, "value"? } }` · `{ "askDone": { "requestId", "outcome": "allowed" | "denied" | "deferred", "by": "mac" | "phone" } }`
- **daemon → extension:** `{ "prompt": { "text", "from", "requestId" } }` · `{ "presence": { "phones": [ ... ] } }` · `{ "answer": { "requestId", "value": "allow" | "deny" } }` · `{ "ctl": "stop" }`

An `ask`/`askDone` pair brackets a permission approval: `ask` opens the request
on the phone (rendered as a confirm card) while pi-hail also opens a Mac dialog;
the daemon relays the phone's answer back as `{ answer }`, and `askDone` closes
the request on whichever device did not answer first.

The extension refuses a phone `prompt` while the local turn runs; while a phone-originated turn runs, it holds local terminal input behind a visible notice and replays it when the phone's turn ends.

## Tests

```sh
node --test src/*.test.ts
```

## Integration test (real daemon)

`src/integration.test.ts` runs pi-hail's socket client against the **real** hail
daemon binary over the C4 control socket. It is **opt-in** and skipped by the
default `npm test`, because it boots the actual `hail` binary and writes a host
identity into the macOS login Keychain.

It stays off the live identity by using hail's disposable-service override
(`HAIL_KEYCHAIN_SERVICE`, default `tools.hail.itest` — never the production
`tools.hail`, which it refuses), deletes those items in teardown, and isolates
the socket/state/config under a temp `XDG_*` (it does **not** override `HOME`,
which on darwin breaks the `security` CLI). Run it on a clean host or a scratch
account.

```sh
# 1. Build the daemon from a hail checkout on main:
(cd /path/to/hail && go build -o /tmp/hail ./cmd/hail)
# 2. Run the opt-in integration test (HAIL_KEYCHAIN_SERVICE defaults to a scratch service):
HAIL_INTEGRATION=1 HAIL_BIN=/tmp/hail npm --workspace packages/pi-hail run test:integration
```

It asserts the extension→daemon direction: the `session.register` handshake and
the turn/event/exit stream. The phone→extension `{prompt}` round-trip is covered
by the unit tests against a fake socket (a real one needs a sealed inbound relay
frame from a paired peer).
