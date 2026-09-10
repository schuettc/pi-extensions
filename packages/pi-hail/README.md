# pi-hail

A pi coding-agent extension that connects each interactive pi session to the local **hail** daemon — so a pi you start on your Mac appears on your paired phone, streams its events there, and can take a prompt typed from the phone as if you'd typed it yourself. The extension owns only the pane it starts on, stays silent when no daemon is listening, and soft-locks each side against the other so the person and the phone never fight over the same turn.

## Install

Add the extension to `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["npm:@schuettc/pi-hail"]
}
```

The extension loads on every pi session but is inert unless it owns an interactive TUI pane and the hail daemon is running. A missing or slow daemon never blocks pi.

## Wire protocol (C4 summary)

One long-lived newline-delimited JSON (NDJSON) connection per pi process, to the daemon's Unix control socket at `$XDG_RUNTIME_DIR/hail/daemon.sock` (falling back to `$TMPDIR/hail/daemon.sock` on macOS). One JSON object per line.

**Register (first line, extension → daemon):**

```json
{ "cmd": "session.register", "args": { "sessionId": "...", "project": "...", "work": "...", "dir": "/abs/dir", "piVersion": "...", "extensionVersion": "0.1.0" } }
```

Daemon replies with `{ "ok": true, "data": { "hostId", "daemonVersion", "accepted", "have" } }` on success, or `{ "ok": false, "error": "version_mismatch: ..." }` on a version mismatch (C6) — in which case the extension shows one notice and goes inert.

**Then, one object per line, both directions:**

- **extension → daemon:** `{ "event": <pi rpc event verbatim> }` · `{ "turn": "start" | "end" }` · `{ "lock": "held" | "released" }` · `{ "exit": { "code": n } }` · `{ "refused": { "requestId", "reason": "turn_running" } }`
- **daemon → extension:** `{ "prompt": { "text", "from", "requestId" } }` · `{ "presence": { "phones": [ ... ] } }` · `{ "answer": { "requestId", "value" } }` · `{ "ctl": "stop" }`

The extension refuses a phone `prompt` while the local turn runs; while a phone-originated turn runs, it holds local terminal input behind a visible notice and replays it when the phone's turn ends.

## Tests

```sh
node --test src/*.test.ts
```
