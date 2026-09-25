// The pure session controller. All effects are injected so every behaviour is
// unit-testable against fakes with no real daemon. This task (4) implements the
// register handshake, event forwarding, turn markers, and exit. The soft-lock
// state machine, presence, replay, and authorizer land in later tasks — the
// state fields below are declared now so those tasks only ADD, not rewrite.

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import type { Phone, RegisterArgs, RegisterReply } from "./protocol.ts";
import { entriesAfter, PERSISTED_ROLES } from "./replay.ts";
import { presenceToStatus } from "./status.ts";
import { EXTENSION_VERSION } from "./version.ts";

/** A phone-originated permission verdict. `defer` yields to pi's own prompt. */
export type PhoneDecision = "allow" | "deny" | "defer";

/** Which side owns the current turn. `idle` at rest. */
export type Phase = "idle" | "local_turn" | "phone_turn";

/** Status-line text while the daemon has this session disconnected from phones. */
export const CONNECTION_STATUS_DISCONNECTED = "hail: disconnected · /hail connect";

/** Status-line presence classification. */
export type PresenceState = "connected" | "driving" | "offline";

export interface SessionDeps {
  /** → daemon */
  send: (obj: unknown) => void;
  /** pi.sendUserMessage */
  sendUserMessage: (text: string) => void;
  ui: {
    setStatus: (text: string | undefined) => void;
    notify: (msg: string, level?: "info" | "warning" | "error") => void;
    holdInput: (held: boolean) => void;
    /**
     * Open a Mac-pane dialog (ctx.ui.select) and return the chosen option, or
     * undefined when dismissed. The AbortSignal lets the Session dismiss it
     * programmatically the moment the phone answers first (spec §A).
     */
    openDialog: (
      title: string,
      options: string[],
      signal: AbortSignal,
    ) => Promise<string | undefined>;
  };
  /**
   * pi's IN-MEMORY entry list (ctx.sessionManager.getEntries(), which excludes
   * the "session" header). The cursor unit is an index into this list; it is the
   * catch-up source (streaming spec §4.3). We never read pi's session FILE:
   * message_end fires before appendMessage persists, and the file is written
   * lazily, so a file-line count is one short and unreliable early.
   */
  getEntries: () => unknown[];
}

export interface RegisterInput {
  sessionId: string;
  project: string;
  work: string;
  dir: string;
  piVersion: string;
  identity?: "hail" | "proj" | "fallback";
  tmux?: { socket?: string; session?: string; pane?: string };
  /** The pane's current session-file position (streaming spec §4.1). */
  cursor?: number;
}

export class Session {
  private readonly deps: SessionDeps;

  // ── Session controller state (defined once; exercised by later tasks) ──
  /** Which side owns the current turn. */
  private phase: Phase = "idle";
  /**
   * Set the moment we call sendUserMessage for a phone prompt, so the next
   * turn_start is attributed to the phone (the stopHookActive pattern).
   */
  private pendingPhonePrompt = false;
  /** Local interactive input captured while phase === "phone_turn". */
  private heldInput: string[] = [];
  /** Last-seen presence, for status-line idempotence. */
  private lastPresence: PresenceState = "offline";
  /** True while the daemon reports this session disconnected from phones. */
  private disconnected = false;
  /** Last presence-derived status text, restored when the session is shown. */
  private presenceText: string | undefined = undefined;

  /**
   * Permission gates the phone is being asked to answer, keyed by requestId.
   * Each resolver is fulfilled by an inbound { answer } (or resolved "defer" by
   * the authorizer's timeout, which then discards its own entry). Resolvers only
   * ever resolve — never reject — so a decision left dangling at session end
   * cannot surface as an unhandled rejection.
   */
  private pendingDecisions = new Map<string, (v: PhoneDecision) => void>();

  /**
   * Asks pi-hail settled with `defer` (Mac "More options…" / dismissed), whose
   * lifecycle the permission system's own dialog now owns. A later
   * `permissions:decision` for one of these closes the phone's card via
   * onDecision (Task P3); a decision for any other requestId is ignored.
   */
  private deferredAsks = new Set<string>();

  /** Daemon's last-seen device sequence number, from the register reply. */
  private have: number | undefined = undefined;
  /**
   * Whether we've already completed a successful register. The FIRST register
   * is a fresh connect (no replay); a later one is a reconnect, which must
   * backfill the gap after the daemon's `have` cursor.
   */
  private hasRegistered = false;
  /** false after a version-mismatch refusal → inert. */
  private isActive = true;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  /** Stamps extensionVersion; passes identity through verbatim. Optional
   *  adoption facts are included only when present (older daemons ignore them). */
  buildRegisterArgs(input: RegisterInput): RegisterArgs {
    const args: RegisterArgs = {
      sessionId: input.sessionId,
      project: input.project,
      work: input.work,
      dir: input.dir,
      piVersion: input.piVersion,
      extensionVersion: EXTENSION_VERSION,
    };
    if (input.identity) args.identity = input.identity;
    if (input.tmux) {
      args.tmux = true;
      if (input.tmux.socket) args.tmuxSocket = input.tmux.socket;
      if (input.tmux.session) args.tmuxSession = input.tmux.session;
      if (input.tmux.pane) args.tmuxPane = input.tmux.pane;
    }
    if (input.cursor !== undefined) args.cursor = input.cursor;
    return args;
  }

  /** Handles the register reply: stores replay cursor; refuses on mismatch. */
  onRegisterReply(reply: RegisterReply): void {
    if (reply.ok) {
      // Stored for diagnostics only: the daemon now drives catch-up via a
      // {"resend":{since}} frame (streaming spec §4.3), so registration no
      // longer replays here.
      this.have = reply.data.have;
      this.hasRegistered = true;
      return;
    }
    // ok:false → version mismatch / refusal. Go inert and render the C6 notice
    // exactly once (idempotent even if onRegisterReply is called again).
    if (this.isActive) {
      this.isActive = false;
      this.deps.ui.notify(
        "Your Mac's hail is newer than this pi extension. Run the installer to update pi-hail.",
        "warning",
      );
    }
  }

  /**
   * Forward a pi event verbatim, wrapped as { event }. A completed message that
   * pi WILL persist is tagged with cursor = getEntries().length + 1 — the
   * entry's final 1-based position. This runs at message_end, BEFORE pi's
   * appendMessage, so getEntries() is one short and the +1 lands on the entry's
   * eventual slot. Non-persisted roles, and tool_execution_end, carry NO cursor.
   */
  forwardEvent(piEvent: unknown): void {
    if (!this.isActive) return;
    const e = piEvent as { type?: string; message?: { role?: string } } | null;
    if (e?.type === "message_end") {
      const role = e.message?.role;
      if (role !== undefined && PERSISTED_ROLES.has(role)) {
        this.deps.send({ event: piEvent, cursor: this.deps.getEntries().length + 1 });
        return;
      }
    }
    this.deps.send({ event: piEvent });
  }

  /**
   * Turn boundary the phone needs to gate its composer. Attributes the turn to
   * the phone (locking local input) when a phone prompt was just injected.
   */
  turnStart(): void {
    if (!this.isActive) return;
    if (this.pendingPhonePrompt) {
      this.phase = "phone_turn";
      this.pendingPhonePrompt = false;
      this.deps.send({ lock: "held" });
    } else {
      this.phase = "local_turn";
    }
    this.deps.send({ turn: "start" });
  }

  turnEnd(): void {
    if (!this.isActive) return;
    const wasPhoneTurn = this.phase === "phone_turn";
    this.deps.send({ turn: "end" });
    if (wasPhoneTurn) {
      this.deps.send({ lock: "released" });
      this.deps.ui.holdInput(false);
      // Re-submit any local input captured during the phone turn, in order.
      const held = this.heldInput;
      this.heldInput = [];
      for (const text of held) {
        this.deps.sendUserMessage(text);
      }
    }
    this.phase = "idle";
  }

  /**
   * Local interactive input. Returns false when the input was held behind the
   * phone-turn notice (to be replayed on turn end), true when it passed through.
   */
  submitLocalInput(text: string): boolean {
    if (this.phase === "phone_turn") {
      this.heldInput.push(text);
      this.deps.ui.holdInput(true);
      return false;
    }
    return true;
  }

  /** A clean pi exit tells the phone the session is gone. */
  exit(code: number): void {
    if (!this.isActive) return;
    this.deps.send({ exit: { code } });
  }

  /** Daemon → extension frame dispatch. Cases land in Tasks 5, 6, 8. */
  onInbound(msg: unknown): void {
    if (!this.isActive) return;
    const m = msg as Record<string, unknown>;
    if (m == null || typeof m !== "object") return;
    if ("prompt" in m) {
      const prompt = m.prompt as { text: string; from: string; requestId: string };
      if (this.phase === "local_turn") {
        // The person owns the turn; refuse rather than drop or queue (spec §4).
        this.deps.send({ refused: { requestId: prompt.requestId, reason: "turn_running" } });
        return;
      }
      // Attribute the next turn_start to the phone, then inject the prompt as input.
      this.pendingPhonePrompt = true;
      this.phase = "phone_turn";
      this.deps.sendUserMessage(prompt.text);
      return;
    }
    if ("presence" in m) {
      const presence = m.presence as { phones: Phone[] };
      this.presenceText = presenceToStatus(presence.phones);
      this.renderStatus();
      return;
    }
    if ("connection" in m) {
      const v = m.connection;
      if (v === "connected" || v === "disconnected") {
        this.disconnected = v === "disconnected";
        this.renderStatus();
      } else if (v === "unavailable") {
        this.deps.ui.notify(
          "hail: this session isn't shared with your phone (only proj/tmux sessions can connect).",
          "info",
        );
      }
      return;
    }
    if ("resend" in m) {
      const since = (m.resend as { since?: number }).since ?? 0;
      this.onResend(since);
      return;
    }
    if ("answer" in m) {
      const answer = m.answer as { requestId: string; value: unknown };
      const resolve = this.pendingDecisions.get(answer.requestId);
      if (resolve) {
        this.pendingDecisions.delete(answer.requestId);
        // Map the phone's value to a verdict; anything unknown is a safe defer.
        const value = answer.value;
        resolve(value === "allow" ? "allow" : value === "deny" ? "deny" : "defer");
      }
      return;
    }
    if ("ctl" in m) {
      // Task 5/later
      return;
    }
  }

  /**
   * A permission gate reaching pi-hail's chain link. When inert, or when the
   * daemon reports this session disconnected from phones, resolve "defer"
   * immediately so the permission system's own Mac dialog runs unchanged. Only
   * asks auto-review already deferred reach here.
   *
   * Otherwise open the ask on BOTH surfaces at once and let the first answer
   * win (spec §A):
   *   - phone: an { ask } frame the daemon renders as a confirm card;
   *   - Mac:   a select dialog (Allow / Deny / More options…) we can dismiss
   *            programmatically the moment the phone answers.
   * There is NO timeout — a human on either device is awaited. Whichever way it
   * settles, an { askDone } frame tells the daemon who answered and how. Never
   * throws (a dangling decision at session end only ever resolves).
   */
  requestPhoneDecision(details: PromptPermissionDetails): Promise<PhoneDecision> {
    if (!this.isActive || this.disconnected) {
      return Promise.resolve("defer");
    }
    const requestId = details.requestId;
    const label = details.toolName ?? details.surface ?? "this";
    const title = `Allow ${label}?`;
    const message = firstPreview(details);

    const ask: {
      requestId: string;
      title: string;
      message: string;
      toolName?: string;
      surface?: string;
      value?: string;
    } = { requestId, title, message };
    if (details.toolName) ask.toolName = details.toolName;
    if (details.surface) ask.surface = details.surface;
    if (details.value != null) ask.value = details.value;
    this.deps.send({ ask });

    const phoneP = new Promise<PhoneDecision>((resolve) => {
      // pi serializes asks, so a live duplicate should never happen; if it does,
      // resolve defer rather than clobbering the in-flight resolver.
      if (this.pendingDecisions.has(requestId)) {
        resolve("defer");
        return;
      }
      this.pendingDecisions.set(requestId, resolve);
    });

    const ac = new AbortController();
    const macP = this.deps.ui
      .openDialog(`${title}\n${message}`, ["Allow", "Deny", "More options…"], ac.signal)
      .then((choice) => macChoiceToDecision(choice));

    return (async () => {
      const winner = await Promise.race([
        phoneP.then((decision) => ({ by: "phone" as const, decision })),
        macP.then((decision) => ({ by: "mac" as const, decision })),
      ]);
      // First answer wins: stop the other surface from also settling.
      this.pendingDecisions.delete(requestId);
      if (winner.by === "phone") ac.abort();
      const outcome =
        winner.decision === "allow"
          ? "allowed"
          : winner.decision === "deny"
            ? "denied"
            : "deferred";
      // A deferred ask is now the permission system's to close (Task P3);
      // anything else is terminal here.
      if (outcome === "deferred") this.deferredAsks.add(requestId);
      this.deps.send({ askDone: { requestId, outcome, by: winner.by } });
      return winner.decision;
    })();
  }

  /**
   * The permission system settled an ask pi-hail had deferred to its own Mac
   * dialog (via `permissions:decision`). Close the phone's card with an askDone
   * carrying the final outcome, attributed to the Mac. A decision for a
   * requestId pi-hail never deferred (answered here, or never announced) is
   * ignored, and each deferred ask closes only once.
   */
  onDecision(requestId: string, result: "allow" | "deny"): void {
    if (!this.isActive) return;
    if (!this.deferredAsks.has(requestId)) return;
    this.deferredAsks.delete(requestId);
    this.deps.send({
      askDone: { requestId, outcome: result === "allow" ? "allowed" : "denied", by: "mac" },
    });
  }

  /** Ask the daemon to connect/disconnect this session. False when inert. */
  requestConnection(connect: boolean): boolean {
    if (!this.isActive) return false;
    this.deps.send({ connection: connect ? "connect" : "disconnect" });
    return true;
  }

  /**
   * Replay completed message entries after `since` at catch-up priority. Each
   * replay frame carries its absolute cursor (since + i + 1) so the daemon
   * records where it left off; the trailing { resend:"done" } flushes its hold.
   */
  onResend(since: number): void {
    if (!this.isActive) return;
    for (const { event, cursor } of entriesAfter(this.deps.getEntries(), since)) {
      this.deps.send({ event, replay: true, cursor });
    }
    this.deps.send({ resend: "done" });
  }

  private renderStatus(): void {
    if (this.disconnected) {
      this.deps.ui.setStatus(CONNECTION_STATUS_DISCONNECTED);
      return;
    }
    if (this.presenceText !== undefined) this.deps.ui.setStatus(this.presenceText);
  }

  /** false after a version-mismatch refusal → inert. */
  active(): boolean {
    return this.isActive;
  }
}

/**
 * The command/path/value preview an ask carries, in priority order: the first
 * present, non-empty string among command, path, toolInputPreview, value. The
 * phone renders this as the card's message so it is never blank.
 */
function firstPreview(details: PromptPermissionDetails): string {
  const candidates = [
    details.command,
    details.path,
    details.toolInputPreview,
    details.value ?? undefined,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/** Map the Mac select choice to a verdict; dismissed (undefined) is a defer. */
function macChoiceToDecision(choice: string | undefined): PhoneDecision {
  if (choice === "Allow") return "allow";
  if (choice === "Deny") return "deny";
  return "defer"; // "More options…" or Esc/dismissed — never an implicit allow.
}
