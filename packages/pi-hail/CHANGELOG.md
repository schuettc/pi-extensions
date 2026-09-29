# Changelog

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
