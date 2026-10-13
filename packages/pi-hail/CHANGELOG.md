# Changelog

## 0.8.0

- **The daemon's opaque resend `claim` is echoed on catch-up (decided
  2026-10-13).** The daemon's `{ resend: { since, limit } }` now carries an
  opaque `claim` (a string). pi-hail echoes it unchanged as a sibling on every
  frame it replays for that request (`{ event, cursor, claim }` — the daemon
  reads the claim and forwards only `event`) and on the terminal
  `{ resend: "done", claim }` / `{ resend: "done", error, claim }`. The claim is
  never inspected or mutated; two concurrent resends keep their own claims on
  their own frames and dones. A `resend` without a claim is a protocol error:
  pi-hail logs a `{ diag }` and still answers `{ resend: "done" }` (without a
  claim) so the daemon never waits forever — the daemon requires 0.8.0, so this
  never happens in the release.
- **Busy prompts are refused via pi's idle check.** Before injecting a phone
  prompt, pi-hail now calls pi's `isIdle()` (a method of the `ExtensionContext`).
  If pi is not idle (still streaming), the prompt is refused on the existing
  `turn_running` path instead of being injected. pi's `sendUserMessage` returns
  void and swallows its own busy rejection, so without this check an
  `{ accepted }` reply could be a false positive.

  **Exact guarantee:** a prompt is refused when pi is busy *at the moment of
  injection*. pi's own preflight has a residual window that pi-hail cannot
  close: `prompt()` awaits the `input` extension handlers *before* its own
  busy check (agent-session.js), so a local turn can begin in that window after
  pi-hail has already replied `{ accepted }`. When that happens pi throws
  "Agent is already processing", and the throw is swallowed by
  `sendUserMessage(...).catch(emitError)`. That `emitError` is delivered only to
  the host's single error listener (the TUI error display) and is **not**
  observable by an extension — there is no `error` event on the
  ExtensionAPI, and it is not published on the `pi.events` bus. So this window
  remains a gap in which a swallowed rejection is invisible: the phone can keep
  an optimistic row for a prompt that never ran. No echo tag.

## 0.7.0

Pane lifecycle and single ownership (spec `2026-09-28-pane-lifecycle-and-single-owner-design`).

- **Lifecycle (A1/A2).** `session_shutdown` now disposes the instance for **every**
  reason (quit, reload, new, resume, fork): announced asks are settled with an
  `askDone`, the prompt-answerer is disposed, the session goes inert, and the
  socket is closed and never reconnects. Only `quit` also sends `exit`. Dispose is
  idempotent, and every handler is a no-op afterwards. The "first owning start
  only" guard is gone — each pi instance binds the context from its own
  `session_start`, so exactly one live connection serves one pi session.
- **Registration facts (A3/A4).** The register `cursor` is recomputed at every
  `register()` call (including reconnect), so a pane reports where it *is*, not
  where it started. Registration now carries `piSessionId` (the pi session id,
  always) and a random `instanceId` per instance.
- **Nothing fails silently (D1'/D2'/D3').** `onResend` attaches `{ error }` to
  `{ resend:"done" }` when reading entries throws. An injected phone prompt
  replies `{ accepted:{requestId} }`, or `{ refused:{requestId,reason:"error",
  error} }` when injection throws. Swallowed errors in `safe()` and the socket are
  reported to the daemon as `{ diag:{where,message} }` frames, rate-limited to 1/s
  and de-duplicated per message for 60 s — never thrown into pi, never printed to
  the TUI.
- **Superseded (B2).** A `{ superseded:true }` frame is terminal: the socket
  closes permanently (no reconnect), the instance goes inert, and a one-line
  notice is shown when the context is still valid.

Requires a hail daemon with `minExtensionVersion = "0.7.0"`.

## 0.6.0

- Phone prompt-answerer seam: mirror the permission system's own prompt to the
  phone and close it on `permissions:decision`.
