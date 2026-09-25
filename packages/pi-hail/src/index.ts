// Extension entry (Task 10): wire pi's lifecycle to the pure Session controller
// and the DaemonSocket. This module owns ONLY the pane it starts on
// (ctx.mode === "tui") — subagent sessions and headless `pi -p` runs load this
// extension too and must stay inert (the pi-tmux-bridge ownership gate). Every
// handler is best-effort (`safe()`), so nothing thrown ever escapes into pi and
// a missing/slow daemon never blocks a turn.

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import type { PermissionsService } from "@gotgenes/pi-permission-system";
import { DaemonSocket, realConnect, type Connect } from "./socket.ts";
import { Session, type RegisterInput, type SessionDeps } from "./session.ts";
import { deriveIdentity, type TmuxFacts } from "./identity.ts";
import { createPhoneAuthorizer } from "./authorizer.ts";
import { runHailCommand } from "./command.ts";

/** DI surface for tests: a fake socket, a fake permission service, an injected clock/timeout. */
export interface ExtensionDeps {
  connect?: Connect;
  socketPath?: string;
  getPermissionsService?: (sessionId: string) => PermissionsService | undefined;
  getTmuxSessionId?: () => string | undefined;
  /** Test seam: tmux facts for this pane (defaults to one `tmux display-message`). */
  getTmuxFacts?: () => TmuxFacts;
}

// Every handler is best-effort: it sits directly on a pi lifecycle event, and a
// harness that fails a session start, a turn, or a shutdown is worse than no
// harness at all. NOTHING here may escape into pi.
function safe(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Best-effort: swallow.
  }
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

  // Ownership is captured at the one session_start that owns the pane; a
  // subagent node's stays false, so its events and bus registrations are inert.
  let ownsThisPane = false;
  let session: Session | undefined;
  let socket: DaemonSocket | undefined;
  let registerInput: RegisterInput | undefined;
  // The input handler reads this flag; the Session sets it via ui.holdInput
  // while a phone turn runs, so local terminal input is held (not dropped).
  let heldFlag = false;
  let authorizerDispose: (() => void) | undefined;
  let warnedNoPerms = false;

  // Register (and, on a reconnect, replay). Both the first call and every
  // reconnect must swallow a rejected promise: a dead daemon rejects, and pi
  // must still start / keep running with no unhandled rejection.
  const register = (): void => {
    if (!socket || !session || !registerInput) return;
    socket
      .register(session.buildRegisterArgs(registerInput))
      .then((reply) => safe(() => session?.onRegisterReply(reply)))
      .catch(() => {});
  };

  pi.on("session_start", (_event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsPane(ctx)) return;
      if (ownsThisPane) return; // capture identity from the first owning start only
      ownsThisPane = true;

      const c = ctx as {
        cwd: string;
        sessionManager: { getSessionId: () => unknown; getEntries?: () => unknown[] };
        ui: {
          setStatus: (key: string, text: string | undefined) => void;
          notify: (msg: string, level: "info" | "warning" | "error") => void;
          select: (
            title: string,
            options: string[],
            opts?: { signal?: AbortSignal },
          ) => Promise<string | undefined>;
        };
      };

      // pi's in-memory entry list is the cursor unit (streaming spec \u00a74.1/\u00a74.3);
      // never the lazily-written session file. Bound so handlers outside this
      // closure (the forwarded-event loop) read the pane's current position.
      const getEntries = (): unknown[] => c.sessionManager.getEntries?.() ?? [];
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
        sendUserMessage: (text) => pi.sendUserMessage(text),
        ui: {
          setStatus: (text) => c.ui.setStatus("pi-hail", text),
          notify: (msg, level) => c.ui.notify(msg, level ?? "info"),
          holdInput: (held) => {
            heldFlag = held;
          },
          // The Mac side of an ask: a select dialog we can dismiss the moment
          // the phone answers first (spec \u00a7A). Never throws into the Session.
          openDialog: (title, options, signal) => c.ui.select(title, options, { signal }),
        },
        getEntries,
      };

      session = new Session(sessionDeps);
      socket = new DaemonSocket({
        connect,
        path: socketPath,
        onLine: (msg) => safe(() => session?.onInbound(msg)),
        // A control-socket drop means the daemon is unreachable: fall back to
        // NOT connected so permission asks defer to pi's normal prompt until a
        // reconnect + re-register is re-affirmed by the daemon.
        onDown: () => safe(() => session?.onTransportDown()),
        // The session knows the register args + replay cursor; re-register on
        // reconnect (which triggers replay after the daemon's `have` cursor).
        onReconnect: () => register(),
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
      }),
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

  pi.on("session_shutdown", (event: unknown, ctx: unknown) =>
    safe(() => {
      if (!ownsThisPane || !ownsPane(ctx)) return;
      // Fires on every session SWITCH, not only quit: reason ∈
      // quit|reload|new|resume|fork. Only a REAL end (quit) emits exit + closes
      // the socket; every other reason is a continuation whose paired
      // session_start re-registers — do nothing (mirror pi-tmux-bridge).
      const reason = (event as { reason?: string } | null)?.reason;
      if (reason && reason !== "quit") return;
      if (authorizerDispose) {
        try {
          authorizerDispose();
        } catch {
          // best-effort
        }
        authorizerDispose = undefined;
      }
      session?.exit(0);
      socket?.close();
    }),
  );

  // Permissions: register the phone-answering authorizer link on
  // permissions:ready (robust to load order / survives /reload). Gated on
  // ownership. If the permission system is unavailable (older pi), skip
  // registration, log once, and continue — phone answers degrade gracefully.
  pi.events?.on?.("permissions:ready", (data: unknown) =>
    safe(async () => {
      if (!ownsThisPane || !session) return;
      const currentSession = session;
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
      if (!service) {
        if (!warnedNoPerms) {
          warnedNoPerms = true;
          console.error(
            "[pi-hail] permission system unavailable; phone cannot answer gates (answer on your Mac)",
          );
        }
        return;
      }
      const authorizer = createPhoneAuthorizer({ session: currentSession });
      authorizerDispose = service.registerAuthorizer("pi-hail", authorizer.authorize);
    }),
  );

  // Close a deferred ask when the permission system's own dialog decides it
  // (permissions:decision). pi-hail no longer forwards permissions:ui_prompt:
  // the daemon renders the ask from pi-hail's { ask } frame instead, so that
  // announcement would only produce a blank phantom card.
  pi.events?.on?.("permissions:decision", (data: unknown) =>
    safe(() => {
      if (!ownsThisPane || !session) return;
      const d = data as { requestId?: string; result?: string } | null;
      if (!d?.requestId || (d.result !== "allow" && d.result !== "deny")) return;
      session.onDecision(d.requestId, d.result);
    }),
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function (pi: any): void {
  createExtension(pi);
}
