// Extension entry (Task 10): wire pi's lifecycle to the pure Session controller
// and the DaemonSocket. This module owns ONLY the pane it starts on
// (ctx.mode === "tui") — subagent sessions and headless `pi -p` runs load this
// extension too and must stay inert (the pi-tmux-bridge ownership gate). Every
// handler is best-effort (`safe()`), so nothing thrown ever escapes into pi and
// a missing/slow daemon never blocks a turn.

import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type { PermissionsService, PromptAnswerer } from "@gotgenes/pi-permission-system";
import { DaemonSocket, realConnect, type Connect } from "./socket.ts";
import {
  Session,
  errorMessage,
  type RegisterInput,
  type SessionDeps,
  type UiPromptFacts,
} from "./session.ts";
import { deriveIdentity, type TmuxFacts } from "./identity.ts";
import { runHailCommand } from "./command.ts";

/** DI surface for tests: a fake socket, a fake permission service, an injected clock/timeout. */
export interface ExtensionDeps {
  connect?: Connect;
  socketPath?: string;
  getPermissionsService?: (sessionId: string) => PermissionsService | undefined;
  getTmuxSessionId?: () => string | undefined;
  /** Test seam: tmux facts for this pane (defaults to one `tmux display-message`). */
  getTmuxFacts?: () => TmuxFacts;
  /** Test seam: clock for the diag rate-limiter (defaults to Date.now). */
  now?: () => number;
}


// One `tmux display-message` for every fact, targeted at this pane when tmux
// exported TMUX_PANE. A bare terminal (no $TMUX) reports inTmux:false. Guarded
// so a test (or a machine without tmux) never throws or hangs.
const FACTS_FORMAT = "#{@hail_session}\t#{session_name}\t#{window_name}\t#{socket_path}\t#{pane_id}";

function readTmuxFacts(): TmuxFacts {
  if (!process.env.TMUX) return { inTmux: false };
  const argv = ["display-message", "-p"];
  if (process.env.TMUX_PANE) argv.push("-t", process.env.TMUX_PANE);
  argv.push(FACTS_FORMAT);
  try {
    const out = execFileSync("tmux", argv, { encoding: "utf8", timeout: 1000 }).replace(/\n$/, "");
    const [hail, session, window, socket, pane] = out.split("\t");
    const opt = (v: string | undefined) => (v && v.length > 0 ? v : undefined);
    return {
      inTmux: true,
      hailSession: opt(hail),
      sessionName: opt(session),
      windowName: opt(window),
      socketPath: opt(socket),
      paneId: opt(pane),
    };
  } catch {
    return { inTmux: true };
  }
}

// Resolve the loaded pi build's version for the C6 handshake. The package.json
// of an ESM-only package is not exposed through its `exports`, so resolve the
// package's node_modules dir directly and read its manifest. Rails names the
// package `@mariozechner/pi-coding-agent`; this monorepo installs
// `@earendil-works/pi-coding-agent` — try whichever is present, then fall back
// to `pi --version` once, then "unknown". Never hardcoded.
let piVersionCache: string | undefined;
function resolvePiVersion(): string {
  if (piVersionCache !== undefined) return piVersionCache;
  piVersionCache = resolvePiVersionUncached();
  return piVersionCache;
}
function resolvePiVersionUncached(): string {
  const require = createRequire(import.meta.url);
  for (const name of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
    try {
      const dirs = require.resolve.paths(name) ?? [];
      for (const d of dirs) {
        const p = join(d, name, "package.json");
        if (!existsSync(p)) continue;
        const pkg = JSON.parse(readFileSync(p, "utf8"));
        if (pkg?.name === name && pkg?.version) return String(pkg.version);
      }
    } catch {
      // try the next name
    }
  }
  try {
    const out = execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 1000 }).trim();
    if (out.length > 0) return out;
  } catch {
    // fall through
  }
  return "unknown";
}

// Only an interactive session owns the pane's identity: the TUI upgrades the
// extension mode to "tui" before extensions initialize, so a real session sees
// "tui" from session_start on. Subagents (in-process) and headless `pi -p`
// stay at the SDK default and are guests, not owners.
const ownsPane = (ctx: unknown): boolean => (ctx as { mode?: string } | null)?.mode === "tui";

// The real `getPermissionsService` lives in an ESM-only package whose runtime
// entry is a `.ts` file. Statically importing that VALUE would make node's
// test runner strip-and-load node_modules TS (which it refuses). Load it lazily
// and only when no service factory was injected — so tests, which always inject
// one, never touch node_modules at all. Under pi the package is already loaded.
let realGetPermissionsServiceCache: ((sessionId: string) => PermissionsService | undefined) | null =
  null;
async function loadRealGetPermissionsService(): Promise<
  (sessionId: string) => PermissionsService | undefined
> {
  if (realGetPermissionsServiceCache) return realGetPermissionsServiceCache;
  const mod = await import("@gotgenes/pi-permission-system");
  realGetPermissionsServiceCache = mod.getPermissionsService;
  return realGetPermissionsServiceCache;
}

// The lifecycle events the phone renders. turn_start/turn_end are handled
// separately: turn lifecycle is emitted ONLY via {turn:"start"|"end"} frames
// (Session.turnStart/turnEnd), NEVER as a forwarded {event} carrying a pi turn
// rpc — otherwise the daemon rotates and issues that session's turn key twice
// per turn (C4). We deliberately do NOT forward before_provider_request /
// before_provider_headers — they may carry secrets (security default).
const FORWARDED_EVENTS = [
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createExtension(pi: any, deps: ExtensionDeps = {}): void {
  const connect = deps.connect ?? realConnect;
  const socketPath = deps.socketPath;
  const now = deps.now ?? (() => Date.now());

  // Diagnostics (spec D3'): report a swallowed error to the daemon as a { diag }
  // frame, rate-limited to 1/s per instance and de-duplicated per message for
  // 60 s. Never throws into pi, never prints to the TUI. A reentrancy guard keeps
  // a diag send (which may itself fail) from spawning more diags.
  let lastDiagAt = Number.NEGATIVE_INFINITY;
  const diagSeen = new Map<string, number>();
  let inDiag = false;
  const reportDiag = (where: string, message: string): void => {
    if (inDiag) return;
    const t = now();
    const seenUntil = diagSeen.get(message);
    if (seenUntil !== undefined && seenUntil > t) return; // de-duplicated (60 s)
    if (t - lastDiagAt < 1000) return; // rate-limited (1/s)
    lastDiagAt = t;
    diagSeen.set(message, t + 60_000);
    inDiag = true;
    try {
      socket?.send({ diag: { where, message } });
    } catch {
      // best-effort: a diag must never throw into pi
    } finally {
      inDiag = false;
    }
  };

  // Every handler is best-effort: it sits directly on a pi lifecycle event, and a
  // harness that fails a session start, a turn, or a shutdown is worse than no
  // harness at all. NOTHING here may escape into pi \u2014 a throw is reported through
  // a { diag } frame (spec D3'), never printed to the TUI.
  const safe = (fn: () => void | Promise<void>, where = "handler"): void => {
    try {
      const result = fn();
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => reportDiag(where, errorMessage(err)));
      }
    } catch (err) {
      reportDiag(where, errorMessage(err));
    }
  };

  // Ownership is captured at the session_start that owns the pane; a subagent
  // node's stays false, so its events and bus registrations are inert. With the
  // A1 lifecycle each pi instance re-runs this factory, so one createExtension
  // serves exactly one pi session: ownership is bound from THIS instance's own
  // session_start (no "first start only" guard).
  let ownsThisPane = false;
  // A random id for THIS pi-hail instance (spec A4), stable for its lifetime so
  // the daemon can tell one instance from another across a slot's history.
  const instanceId = randomUUID();
  // Computes the pane's CURRENT in-memory cursor at each register call (spec A3);
  // bound in session_start from the owning context's getEntries.
  let computeCursor: (() => number) | undefined;
  // Set once this instance has been disposed (session_shutdown for any reason,
  // or {"superseded":true}). After dispose every handler is a no-op.
  let disposed = false;
  let session: Session | undefined;
  let socket: DaemonSocket | undefined;
  let registerInput: RegisterInput | undefined;
  // The input handler reads this flag; the Session sets it via ui.holdInput
  // while a phone turn runs, so local terminal input is held (not dropped).
  let heldFlag = false;
  // The prompt-answerer capability registered on permissions:ready, its
  // disposer, and a once-per-process guard for the missing-seam warning. The
  // phone answers a showing prompt through `answerer.answer`; `answerer` is
  // undefined until (and unless) the fork's seam is present.
  let answerer: PromptAnswerer | undefined;
  let answererDispose: (() => void) | undefined;
  let answererRegistered = false;
  let warnedMissingSeam = false;
  // pi's UI notify for this pane, captured at session_start so the
  // permissions:ready bus handler (which gets no ctx) can surface the
  // missing-seam warning through pi's UI.
  let uiNotify: ((msg: string, level: "info" | "warning" | "error") => void) | undefined;

  // Register (and, on a reconnect, replay). Both the first call and every
  // reconnect must swallow a rejected promise: a dead daemon rejects, and pi
  // must still start / keep running with no unhandled rejection.
  const register = (): void => {
    if (!socket || !session || !registerInput) return;
    // The cursor is recomputed at EACH register (spec A3): a reconnect after a
    // daemon outage must report where the pane IS now, not where it started.
    if (computeCursor) {
      try {
        registerInput.cursor = computeCursor();
      } catch (err) {
        reportDiag("register.cursor", errorMessage(err));
      }
    }
    socket
      .register(session.buildRegisterArgs(registerInput))
      .then((reply) => safe(() => session?.onRegisterReply(reply)))
      .catch(() => {});
  };

  pi.on("session_start", (_event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsPane(ctx)) return;
      if (disposed) return; // a disposed instance never re-binds
      if (ownsThisPane) return; // this instance already bound its one session
      ownsThisPane = true;

      const c = ctx as {
        cwd: string;
        sessionManager: { getSessionId: () => unknown; getEntries?: () => unknown[] };
        ui: {
          setStatus: (key: string, text: string | undefined) => void;
          notify: (msg: string, level: "info" | "warning" | "error") => void;
        };
      };

      uiNotify = (msg, level) => c.ui.notify(msg, level);

      // pi's in-memory entry list is the cursor unit (streaming spec \u00a74.1/\u00a74.3);
      // never the lazily-written session file. Bound so handlers outside this
      // closure (the forwarded-event loop) read the pane's current position.
      const getEntries = (): unknown[] => c.sessionManager.getEntries?.() ?? [];
      computeCursor = () => getEntries().length;
      // The pi session id (spec A4), always reported. Distinct from the slot
      // identity below, which for a hail-identity pane is the @hail_session id.
      const piSessionId = String(c.sessionManager.getSessionId());
      const facts = deps.getTmuxFacts ? deps.getTmuxFacts() : readTmuxFacts();
      // Back-compat test seam: an injected @hail_session id overrides the facts.
      if (deps.getTmuxSessionId) facts.hailSession = deps.getTmuxSessionId();
      const dir = c.cwd;
      const id = deriveIdentity(facts, String(c.sessionManager.getSessionId()), dir);
      const piVersion = resolvePiVersion();
      registerInput = {
        sessionId: id.sessionId,
        project: id.project,
        work: id.work,
        dir,
        piVersion,
        piSessionId,
        instanceId,
        identity: id.identity,
        ...(facts.inTmux
          ? { tmux: { socket: facts.socketPath, session: facts.sessionName, pane: facts.paneId } }
          : {}),
        // Report the pane's current in-memory entry count so the daemon seeds a
        // brand-new slot's cursor to it and never replays pre-existing history
        // (streaming spec \u00a74.1).
        cursor: getEntries().length,
      };

      const sessionDeps: SessionDeps = {
        send: (obj) => socket?.send(obj),
        // Progress backpressure (muster #502): the Session holds the newest
        // progress frame while the socket's write buffer is over its high-water
        // mark, and retries when the socket drains. Boundary frames ignore this.
        canSendProgress: () => socket?.canSendProgress() ?? false,
        onDrain: (cb) => socket?.onDrain(cb),
        sendUserMessage: (text) => pi.sendUserMessage(text),
        ui: {
          setStatus: (text) => c.ui.setStatus("pi-hail", text),
          notify: (msg, level) => c.ui.notify(msg, level ?? "info"),
          holdInput: (held) => {
            heldFlag = held;
          },
        },
        // The phone answers the permission system's OWN showing prompt through
        // the prompt-answerer seam (spec \u00a7B). Closes over `answerer`, which is
        // set on permissions:ready only when the fork's seam is present; absent,
        // a phone answer is inert (the Mac dialog stays the only surface).
        answerPrompt: (requestId, verdict) => {
          answerer?.answer(requestId, verdict);
        },
        getEntries,
      };

      session = new Session(sessionDeps);
      socket = new DaemonSocket({
        connect,
        path: socketPath,
        onLine: (msg) =>
          safe(() => {
            // {"superseded":true} is terminal (spec B2): a genuine duplicate lost
            // the slot. Close the socket permanently (no reconnect), go inert, and
            // show a one-line notice if the context is still valid.
            if (msg != null && typeof msg === "object" && (msg as { superseded?: unknown }).superseded === true) {
              dispose({
                notice:
                  "hail: this pane is now controlled by a newer pi-hail instance; this one is inactive.",
              });
              return;
            }
            session?.onInbound(msg);
          }, "onLine"),
        // A control-socket drop means the daemon is unreachable: fall back to
        // NOT connected so permission asks defer to pi's normal prompt until a
        // reconnect + re-register is re-affirmed by the daemon.
        onDown: () => safe(() => session?.onTransportDown()),
        // The session knows the register args + replay cursor; re-register on
        // reconnect (which triggers replay after the daemon's `have` cursor).
        onReconnect: () => register(),
        // Report the socket's swallowed errors through the same rate-limited path.
        onDiag: (where, message) => reportDiag(where, message),
      });
      register();
    }),
  );

  pi.registerCommand("hail", {
    description: "Connect or disconnect this session on your phone (connect | disconnect)",
    handler: async (args: string, cmdCtx: unknown) => {
      try {
        const c = cmdCtx as { ui?: { notify?: (m: string, l: string) => void } } | undefined;
        runHailCommand(args ?? "", ownsThisPane ? session : undefined, (m) => c?.ui?.notify?.(m, "info"));
      } catch {
        // Never let a command handler throw into pi.
      }
    },
  });

  // Turn lifecycle is emitted ONLY as a {turn} frame (never also as a forwarded
  // {event}); a duplicate {event} turn rpc would make the daemon rotate the
  // session's turn key twice per turn (C4).
  pi.on("turn_start", (_event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsThisPane || !session || !ownsPane(ctx)) return;
      session.turnStart();
    }),
  );

  pi.on("turn_end", (_event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsThisPane || !session || !ownsPane(ctx)) return;
      session.turnEnd();
    }),
  );

  for (const name of FORWARDED_EVENTS) {
    pi.on(name, (event: unknown, ctx: unknown) =>
      safe(() => {
        if (!ownsThisPane || !session || !ownsPane(ctx)) return;
        // The Session tags a persisted message_end with its cursor from the
        // in-memory entry list (spec \u00a74.3); everything else forwards verbatim.
        session.forwardEvent(event);
      }, `event:${name}`),
    );
  }

  // input must RETURN a result, so it cannot use safe() (which returns void):
  // hold interactive input behind the phone-turn notice, else let it continue.
  pi.on("input", (event: unknown, _ctx: unknown) => {
    try {
      if (!ownsThisPane || !session) return { action: "continue" };
      const e = event as { source?: string; text?: string } | null;
      if (e?.source === "interactive") {
        const passthrough = session.submitLocalInput(e.text ?? "");
        if (!passthrough) return { action: "handled" };
      }
    } catch {
      // Never let an input handler throw into pi.
    }
    return { action: "continue" };
  });

  // Dispose this instance's session-scoped resources (spec A1). Idempotent:
  // reload, session replacement, superseded, and process exit converge here.
  // `sendExit` (quit only) additionally sends an { exit } frame; a `notice`
  // (superseded) surfaces a one-line message through pi's UI when the captured
  // context is still valid. After this runs every handler is a no-op.
  const dispose = (opts: { sendExit?: boolean; notice?: string } = {}): void => {
    if (disposed) return;
    disposed = true;
    // A quit is a real end: tell the phone the session is gone BEFORE going inert.
    if (opts.sendExit) safe(() => session?.exit(0), "dispose.exit");
    // Settle announced asks (askDone) and go inert.
    safe(() => session?.dispose(), "dispose.session");
    if (answererDispose) {
      try {
        answererDispose();
      } catch {
        // best-effort
      }
      answererDispose = undefined;
    }
    answerer = undefined;
    answererRegistered = false;
    if (opts.notice) {
      try {
        uiNotify?.(opts.notice, "info");
      } catch {
        // The context may already be invalid; the notice is best-effort.
      }
    }
    socket?.close();
  };

  pi.on("session_shutdown", (event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsThisPane || !ownsPane(ctx)) return;
      // Fires on every session SWITCH, not only quit: reason ∈
      // quit|reload|new|resume|fork. EVERY reason disposes the instance so no
      // stale DaemonSocket survives; only a REAL end (quit) also sends exit.
      const reason = (event as { reason?: string } | null)?.reason;
      dispose({ sendExit: reason === "quit" });
    }, "session_shutdown"),
  );

  // Permissions: on permissions:ready (robust to load order / survives /reload,
  // gated on ownership), resolve this session's service and register the phone
  // prompt-answerer through the fork's seam. The requirement is enforced at
  // runtime, visibly — never a silent no-op (spec E.3):
  //   - service present AND registerPromptAnswerer is a function → register;
  //   - service present but NO registerPromptAnswerer (plain @gotgenes upstream,
  //     or an older fork build) → warn ONCE per process through pi's UI + the
  //     console, and keep phone approvals disabled (no asks, no answers);
  //   - no permission system at all (import fails / service undefined) → quiet,
  //     approvals simply absent, as before.
  pi.events?.on?.("permissions:ready", (data: unknown) =>
    safe(async () => {
      if (!ownsThisPane || !session) return;
      if (answererRegistered) return; // idempotent across repeat readies
      const sessionId = (data as { sessionId?: string | null } | null)?.sessionId;
      if (!sessionId) return;
      let service: PermissionsService | undefined;
      try {
        const getPermissionsService =
          deps.getPermissionsService ?? (await loadRealGetPermissionsService());
        service = getPermissionsService(sessionId);
      } catch {
        service = undefined;
      }
      // No permission system installed at all: pi has no permission prompts, so
      // there is nothing to show or answer. Stay quiet.
      if (!service) return;
      // Service present but the fork's seam is missing: the requirement is not
      // met. Warn once, visibly, and leave approvals disabled.
      if (typeof service.registerPromptAnswerer !== "function") {
        if (!warnedMissingSeam) {
          warnedMissingSeam = true;
          const msg = "hail: phone approvals need @schuettc/pi-permission-system";
          try {
            uiNotify?.(msg, "warning");
          } catch {
            // best-effort
          }
          console.error(msg);
        }
        return;
      }
      answerer = service.registerPromptAnswerer("pi-hail");
      answererDispose = answerer.dispose.bind(answerer);
      answererRegistered = true;
    }),
  );

  // Mirror the permission system's OWN prompt to the phone (spec §B). On
  // permissions:ui_prompt the Session sends an { ask } frame — but only while
  // the daemon has affirmed this session is connected to phones, and only once
  // per requestId (tracked in the Session's announced set). pi-hail draws no
  // dialog: the permission system owns the single Mac dialog.
  pi.events?.on?.("permissions:ui_prompt", (data: unknown) =>
    safe(() => {
      if (!ownsThisPane || !session) return;
      const d = data as UiPromptFacts | null;
      if (!d?.requestId) return;
      session.announceAsk(d);
    }),
  );

  // Close an announced ask when the permission system's own dialog decides it
  // (permissions:decision) → { askDone }. `by` is `phone` when the decision came
  // through the prompt-answerer seam (decidedBy.kind === "answerer" && name ===
  // "pi-hail"), else `mac` (dialog, auto-confirm, rule, yolo, …).
  pi.events?.on?.("permissions:decision", (data: unknown) =>
    safe(() => {
      if (!ownsThisPane || !session) return;
      const d = data as {
        requestId?: string;
        result?: string;
        decidedBy?: { kind?: string; name?: string } | null;
      } | null;
      if (!d?.requestId || (d.result !== "allow" && d.result !== "deny")) return;
      const by =
        d.decidedBy?.kind === "answerer" && d.decidedBy?.name === "pi-hail" ? "phone" : "mac";
      session.onDecision(d.requestId, d.result, by);
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function (pi: any): void {
  createExtension(pi);
}
