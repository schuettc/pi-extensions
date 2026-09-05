import { resolveTmux, tmux as runTmuxDefault } from "./tmux.ts";
import type { TmuxContext } from "./tmux.ts";
import { writeState as writeStateDefault, removeState as removeStateDefault } from "./state.ts";
import {
  ringBell as ringBellDefault,
  raiseAttention as raiseAttentionDefault,
  raisePermissionAttention as raisePermissionAttentionDefault,
  clearPermissionAttention as clearPermissionAttentionDefault,
} from "./bell.ts";
import { sessionStart, drain, sessionEnd, become } from "./muster.ts";
import type { Run } from "./muster.ts";

type Deps = {
  tmux?: () => TmuxContext | undefined;
  runTmux?: (socket: string, args: string[]) => string | undefined;
  runMuster?: Run;
  writeState?: (opts: { ctx: TmuxContext; contextPct: number; model: string }) => void;
  removeState?: (ctx: TmuxContext) => void;
  ringBell?: (ctx: TmuxContext) => void;
  raiseAttention?: (ctx: TmuxContext) => void;
  raisePermissionAttention?: (ctx: TmuxContext) => void;
  clearPermissionAttention?: (ctx: TmuxContext) => void;
};

// The session id reaches tmux as a session option value; sanitize before it
// gets there. Same character class the Claude Code hook this replaces used,
// and for the same reason: the id is later used by consumers to build file
// paths. Only the tmux-bound copy is sanitized — muster's hooks take the raw
// id in a JSON payload, not a tmux target or a filesystem path.
function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_");
}

// Every handler is best-effort: it sits directly on a pi lifecycle event, and
// a harness that fails a session start, a turn, or a shutdown over a status
// bar or a bus registration is worse than no harness at all.
function safe(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Best-effort: nothing here may escape into pi.
  }
}

export function createHarness(pi: any, deps: Deps = {}): void {
  const getTmux = deps.tmux ?? resolveTmux;
  const runTmux = deps.runTmux ?? runTmuxDefault;
  const musterDeps = deps.runMuster ? { run: deps.runMuster } : {};
  const writeState = deps.writeState ?? ((opts) => writeStateDefault({ ...opts }));
  const removeState = deps.removeState ?? ((ctx) => removeStateDefault(ctx));
  const ringBell = deps.ringBell ?? ((ctx) => ringBellDefault(ctx));
  const raiseAttention = deps.raiseAttention ?? ((ctx) => raiseAttentionDefault(ctx));
  const raisePermissionAttention =
    deps.raisePermissionAttention ?? ((ctx) => raisePermissionAttentionDefault(ctx));
  const clearPermissionAttention =
    deps.clearPermissionAttention ?? ((ctx) => clearPermissionAttentionDefault(ctx));

  // Loop guard for the drain on agent_settled: injecting a block reason
  // starts a turn, which produces another settle. Without tracking whether
  // WE triggered the settle we are currently handling, that settle re-drains,
  // sees the same unread mail, and injects again — forever, for as long as
  // mail stays unread. Scoped to this createHarness call so each session
  // (and each test) starts clean.
  let stopHookActive = false;

  // Guard for session_info_changed: the alias muster last confirmed for this
  // pane, whether from our own become() or simply the last name we acted on.
  // Comparing against it (rather than the raw previous event) is what
  // collapses the outside-in loop: `muster label X` types `/name X` into our
  // pane, firing this event with a name muster already has — becoming it
  // again would be a pointless round-trip.
  let lastAlias: string | undefined;

  // A permission prompt pauses mid-turn, so neither turn_end nor agent_settled
  // fires while it waits — the two events that normally light the pane. The
  // permission system announces that exact moment on pi.events; we ring and
  // raise the 🔐 flag on the prompt, and drop it on the matching decision.
  // pi.events handlers get no ctx, so ownership is captured here from the one
  // session_start that owns the pane (a subagent node's stays false).
  let ownsThisPane = false;
  // Clear only on the decision that resolves the prompt we lit: one tool call
  // runs several gates, and an unrelated auto-allow decision must not drop a
  // flag a still-pending prompt is holding.
  let pendingPromptRequestId: string | undefined;

  // Only an interactive session owns the pane's identity. Subagent sessions
  // (pi-subagents' createAgentSession) run IN-PROCESS: they load this
  // extension too, inherit $TMUX/$TMUX_PANE, and their extension mode stays
  // at the SDK default "print" — only the TUI upgrades it, before extensions
  // initialize, so a real session always sees "tui" from session_start on.
  // Without this gate a subagent's auto-name hijacked the host session's
  // tmux name and bus alias, and its quit tombstoned the pane's row (caught
  // live 2026-08-27, twice). Headless `pi -p` runs in a pane are excluded
  // for the same reason — they are guests, not the pane's owner.
  const ownsPane = (ctx: any): boolean => ctx?.mode === "tui";

  pi.events?.on?.("permissions:ui_prompt", (data: any) => safe(() => {
    if (!ownsThisPane) return;
    const t = getTmux();
    if (!t) return;
    pendingPromptRequestId = data?.requestId;
    ringBell(t);
    raisePermissionAttention(t);
  }));

  pi.events?.on?.("permissions:decision", (data: any) => safe(() => {
    if (!ownsThisPane) return;
    if (!pendingPromptRequestId || data?.requestId !== pendingPromptRequestId) return;
    pendingPromptRequestId = undefined;
    const t = getTmux();
    if (!t) return;
    clearPermissionAttention(t);
  }));

  pi.on("session_start", (event: any, ctx: any) => safe(() => {
    if (!ownsPane(ctx)) return;
    ownsThisPane = true;
    const t = getTmux();
    if (!t) return;
    const rawSessionId = String(ctx.sessionManager.getSessionId());
    const sanitizedSessionId = sanitize(rawSessionId);
    runTmux(t.socket, ["set-option", "-t", t.pane, "@harness_session", sanitizedSessionId]);

    const source = event?.reason === "resume" || event?.reason === "fork" ? "resume" : "startup";
    const out = sessionStart({ sessionId: rawSessionId, cwd: ctx.cwd, source, ...musterDeps });
    if (out.stdout) {
      // Require a positive unread count: `/unread/i` also matched a
      // "— 0 unread thread(s)" line, triggering a turn on every resume with
      // nothing to do.
      const triggerTurn = /[1-9]\d* unread/.test(out.stdout);
      if (triggerTurn) {
        // The turn we start here ends in agent_settled, which drains and would
        // get this same unread mail as a block reason and inject it AGAIN —
        // two prompts for one resume. Arming the loop guard now makes that
        // following settle skip the re-inject, collapsing it to one.
        stopHookActive = true;
      }
      pi.sendMessage(
        { customType: "harness", content: out.stdout, display: false },
        { triggerTurn },
      );
    }
  }));

  pi.on("turn_end", (_event: unknown, ctx: any) => safe(() => {
    if (!ownsPane(ctx)) return;
    const t = getTmux();
    if (!t) return;
    // The state write and the bell are independent notifications that
    // happen to share this event: a throw from getContextUsage/writeState
    // (or a missing ctx.model) must not suppress the bell for this turn.
    try {
      const usage = ctx.getContextUsage?.();
      if (usage != null && usage.percent != null) {
        writeState({ ctx: t, contextPct: usage.percent, model: ctx.model.id });
      }
    } catch {
      // Best-effort: the meter is not worth losing the bell over.
    }
    ringBell(t);
  }));

  pi.on("agent_settled", (_event: unknown, ctx: any) => safe(() => {
    if (!ownsPane(ctx)) return;
    const t = getTmux();
    if (!t) return;
    // A settled agent with no queued continuation is a pane waiting on input:
    // raise the SwiftBar attention item (Acceptance #4). pi has no event
    // literally named "input waiting"; agent_settled is that boundary. Its own
    // try/catch keeps it best-effort, and the enclosing safe() is a backstop —
    // a failed attention flag must not lose this settle's drain.
    raiseAttention(t);
    const sessionId = String(ctx.sessionManager.getSessionId());
    const wasStopHookActive = stopHookActive;
    const out = drain({ sessionId, stopHookActive: wasStopHookActive, ...musterDeps });
    if (out.reason && !wasStopHookActive) {
      pi.sendMessage(
        { customType: "harness", content: out.reason, display: false },
        { triggerTurn: true },
      );
      stopHookActive = true;
    } else {
      stopHookActive = false;
    }
  }));

  pi.on("session_info_changed", (event: any, ctx: any) => safe(() => {
    if (!ownsPane(ctx)) return;
    const t = getTmux();
    if (!t) return;
    const name = event?.name;
    if (!name) return;
    if (name === lastAlias) return;
    // Prefix-T's contract (dotfiles tmux-session-rename.sh): the operator
    // names the WORK; the <project>/ prefix is a property of where the
    // session lives. A bare /name gets the current first segment re-attached
    // so the session never renames out of its project grouping (and the bus
    // alias — which IS the tmux name — stays grouped too); a name already
    // carrying '/' is taken verbatim, the same re-homing escape hatch the
    // script offers. For a home-base session (no '/' in #S) the whole
    // current name is the project.
    const cur = runTmux(t.socket, ["display-message", "-p", "-t", t.pane, "#{session_name}"]);
    const full = name.includes("/") || !cur ? name : `${cur.split("/")[0]}/${name}`;
    if (full === lastAlias) return;
    // tmux rejects session names containing `.` or `:`, so the tmux-bound name
    // is sanitized to `-`; muster's alias takes the raw name. Without this the
    // rename would fail while become() succeeded and lastAlias recorded the
    // name as done, leaving the two divergent with no retry. Sanitizing here
    // keeps both renames landing for any name pi allows.
    const tmuxName = full.replace(/[.:]/g, "-");
    runTmux(t.socket, ["rename-session", "-t", t.pane, tmuxName]);
    become(full, musterDeps);
    // Record the COMPOSED name: muster label confirms a become by typing
    // /name <full> back into the pane, so the echo arrives prefixed and must
    // match what we stored to collapse the loop. The raw-name guard above
    // still catches a repeat of the operator's own bare /name before the
    // tmux round-trip.
    lastAlias = full;
  }));

  pi.on("session_shutdown", (event: any, ctx: any) => safe(() => {
    if (!ownsPane(ctx)) return;
    // Fires on every session SWITCH, not only quit: reason ∈
    // quit|reload|new|resume|fork. Only a REAL end (quit) may tombstone this
    // session's bus row and drop its state file; every other reason is a
    // continuation whose paired session_start re-registers, and tombstoning
    // there races other events on the same tuple. Live repro (galley
    // trial): a rename fires become() → the new alias goes live, then a reload
    // or switch fired session_shutdown → sessionEnd tombstoned it, leaving BOTH
    // the old and new aliases departed. muster's SessionEnd is "the
    // conversation ended" (Claude Code fires it once, at the real end); pi's
    // broader session_shutdown must be filtered to match that contract.
    if (event?.reason && event.reason !== "quit") return;
    const t = getTmux();
    if (!t) return;
    // Remove the state file FIRST, before touching ctx. A torn-down ctx during
    // a quit — plausible exactly at shutdown — would otherwise throw on the
    // session-id read and leak the state file, so the bar shows a dead session
    // until the reader's 7-day backstop. The state file is the liveness signal;
    // dropping it must not depend on the bus call succeeding.
    removeState(t);
    try {
      const sessionId = String(ctx.sessionManager.getSessionId());
      sessionEnd({ sessionId, ...musterDeps });
    } catch {
      // Best-effort: a torn-down ctx must not resurrect the state file we just
      // removed. The tombstone is muster's to miss, not ours to block on.
    }
  }));
}

export default function (pi: any) {
  createHarness(pi);
}
