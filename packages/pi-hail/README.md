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

### Required: answer approvals from your phone (0.6.0)

Phone approvals ride the permission system's **own** prompt: the permission
system draws the single dialog, and pi-hail mirrors that same prompt to your
phone and answers it through the fork's prompt-answerer seam. pi-hail draws no
dialog of its own and raises no alerts — the tmux bell and 🔐 fire exactly as
they do with pi-hail absent, and `pi-auto-review`'s auto-confirm is untouched.

This needs two things.

**1. Install the fork of the permission system** under its original name, via
npm's alias spec, in `~/.pi/agent/settings.json`. Use the alias pin **instead
of** plain `@gotgenes/pi-permission-system` — never both (they resolve to the
same path on disk, so two gates can never load together):

```json
{
  "extensions": [
    "npm:@gotgenes/pi-permission-system@npm:@schuettc/pi-permission-system@<version>"
  ]
}
```

The fork carries the prompt-answerer seam (`registerPromptAnswerer`) pi-hail
needs. **The requirement is enforced at runtime, visibly.** On startup pi-hail
looks up the permission service:

- fork present (the seam is there) → phone approvals work;
- the plain `@gotgenes` package, or an older fork build without the seam →
  pi-hail warns **once** (`hail: phone approvals need
  @schuettc/pi-permission-system`) through pi's UI and the log, and keeps phone
  approvals disabled; everything else in pi-hail keeps working;
- no permission system installed at all → pi-hail runs quietly and approvals are
  simply absent, as before.

**2. Opt pi-hail in** as a prompt answerer in
`~/.pi/agent/extensions/pi-permission-system/config.json`. Registration alone
grants nothing; authority comes from this config key (mirroring
`authorizerChain`):

```json
{
  "authorizerChain": ["pi-auto-review"],
  "promptAnswerers": ["pi-hail"]
}
```

With `promptAnswerers` empty (or missing), a phone answer does nothing and the
Mac dialog stays the only way to answer.

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

- **extension → daemon:** `{ "event": <pi rpc event verbatim> }` · `{ "turn": "start" | "end" }` · `{ "lock": "held" | "released" }` · `{ "exit": { "code": n } }` · `{ "refused": { "requestId", "reason": "turn_running" } }` · `{ "ask": { "requestId", "title", "message", "toolName"?, "surface"?, "value"? } }` · `{ "askDone": { "requestId", "outcome": "allowed" | "denied", "by": "mac" | "phone" } }`
- **daemon → extension:** `{ "prompt": { "text", "from", "requestId" } }` · `{ "presence": { "phones": [ ... ] } }` · `{ "answer": { "requestId", "value": "allow" | "deny" } }` · `{ "ctl": "stop" }`

An `ask`/`askDone` pair brackets a permission approval: `ask` mirrors the
permission system's own showing prompt to the phone (rendered as a confirm
card); the daemon relays the phone's answer back as `{ answer }`, which pi-hail
feeds to the permission system's prompt-answerer seam; and `askDone` closes the
card once the prompt resolves, carrying `by: "phone"` when the phone answered
and `by: "mac"` otherwise (the Mac dialog, auto-confirm, a rule, or yolo).
pi-hail never draws a dialog of its own.

An ask is mirrored to the phone only while the daemon has affirmed the session
is connected, and only once per `requestId`; the announced set is dropped on
session end and on re-register (the daemon stale-acks any still-open ask).

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
