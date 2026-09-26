// The pure session controller. All effects are injected so every behaviour is
// unit-testable against fakes with no real daemon. This task (4) implements the
// register handshake, event forwarding, turn markers, and exit. The soft-lock
// state machine, presence, replay, and authorizer land in later tasks — the
// state fields below are declared now so those tasks only ADD, not rewrite.

import type { Phone, RegisterArgs, RegisterReply } from "./protocol.ts";
import { entriesAfter, PERSISTED_ROLES, trimFrames } from "./replay.ts";
import { presenceToStatus } from "./status.ts";
import { EXTENSION_VERSION } from "./version.ts";

/**
 * Strip the duplicate cumulative snapshot pi carries on a streaming progress
 * event, so forwarding never ships the same bytes twice per delta (muster #502).
 * pi's MessageUpdateEvent carries the full partial message TWICE: once as
 * `message` (the snapshot the phone renders — KEEP it) and once as
 * `assistantMessageEvent.partial` (a cumulative duplicate). encodeLine →
 * JSON.stringify per delta then makes bytes/turn grow as deltas × size
 * (quadratic). This mirrors pi's own `WithoutPartial` (dist/modes/json-event),
 * which strips ONLY message_update's `assistantMessageEvent.partial`.
 *
 * tool_execution_update's `partialResult` is deliberately KEPT: it is the tool's
 * only live output payload and the hail phone renders it (client
 * state/session.ts `toolOutput` reads `partialResult`). Its growth is already
 * bounded by the per-toolCallId newest-wins throttle + socket backpressure, so
 * it never contributes to the quadratic blow-up.
 *
 * Returns a SHALLOW copy (never mutates pi's own event object); `message` and
 * the other kept fields are shared by reference — cheap, and the phone renders
 * from that same snapshot. Non-progress events, and progress events that carry
 * no duplicate, pass through unchanged (same reference — no needless copy).
 */
export function stripProgressPartial(event: unknown): unknown {
  if (event == null || typeof event !== "object") return event;
  const e = event as { type?: string };
  if (e.type === "message_update") {
    const ame = (e as { assistantMessageEvent?: unknown }).assistantMessageEvent;
    if (ame != null && typeof ame === "object" && "partial" in ame) {
      const { partial: _partial, ...restAme } = ame as Record<string, unknown>;
      return { ...(e as Record<string, unknown>), assistantMessageEvent: restAme };
    }
    return event;
  }
  return event;
}

/**
 * The subset of the permission system's `permissions:ui_prompt` event the
 * Session reads to build an { ask } card (spec \u00a7B). Read defensively: the bus
 * contract may add fields, and every field here may be null/absent. `surface`
 * and `value` are the normalized display projection; `request` carries the
 * ask's invariant facts (its gate `surface`, `toolName`, and `value`).
 */
export interface UiPromptFacts {
  requestId: string;
  surface?: string | null;
  value?: string | null;
  request?: {
    surface?: string | null;
    toolName?: string | null;
    value?: string | null;
  } | null;
}

/** Which side owns the current turn. `idle` at rest. */
export type Phase = "idle" | "local_turn" | "phone_turn";

/** Status-line text while the daemon has this session disconnected from phones. */
export const CONNECTION_STATUS_DISCONNECTED = "hail: disconnected · /hail connect";

/**
 * Trailing-flush window for streamed progress (message_update /
 * tool_execution_update): the newest snapshot per kind is delivered at most once
 * per this interval. The daemon coalesces progress newest-wins (~1/s) anyway, so
 * a per-turn burst of thousands of deltas collapses to a bounded trickle.
 */
export const PROGRESS_THROTTLE_MS = 250;

/** Opaque timer handle (setTimeout's return, or a test double). */
export type TimerHandle = unknown;

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
  };
  /**
   * Settle a *showing* permission prompt remotely, through the permission
   * system's prompt-answerer seam (spec §A). Wired by the extension to the
   * registered `PromptAnswerer.answer`; the return value (`false` when no such
   * prompt is open, already settled, or the answerer is not opted in) is
   * advisory — the `permissions:decision` event is what closes the phone card.
   * Absent (no permission system, or the seam disabled) means phone answers are
   * inert.
   */
  answerPrompt?: (requestId: string, verdict: "allow" | "deny") => void;
  /**
   * pi's IN-MEMORY entry list (ctx.sessionManager.getEntries(), which excludes
   * the "session" header). The cursor unit is an index into this list; it is the
   * catch-up source (streaming spec §4.3). We never read pi's session FILE:
   * message_end fires before appendMessage persists, and the file is written
   * lazily, so a file-line count is one short and unreliable early.
   */
  getEntries: () => unknown[];
  /**
   * Injectable clock/timer for the progress throttle. Default to real time.
   * `setTimer` should behave like an unref'd setTimeout so a pending flush never
   * keeps pi's process alive.
   */
  now?: () => number;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  /**
   * Backpressure gate from the transport (Task C): false while the socket's
   * write buffer is over the high-water mark, so progress frames are held (the
   * newest kept pending) instead of written. Boundary frames are ALWAYS written.
   * Defaults to always-sendable.
   */
  canSendProgress?: () => boolean;
  /**
   * Register a callback the transport invokes when it drains, so the Session can
   * retry a held progress flush. Called once, lazily, on first backpressure.
   */
  onDrain?: (cb: () => void) => void;
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
  /**
   * True ONLY after the daemon affirms this session is connected to phones
   * ({connection:"connected"}). Defaults NOT connected: until the daemon says
   * so \u2014 and again after any disconnected / unavailable frame or a control-socket
   * drop \u2014 a permission ask defers to pi's normal prompt instead of opening a
   * phone ask. The daemon sends this affirmation on every accepted register.
   */
  private connected = false;
  /**
   * True only when the daemon EXPLICITLY reported "disconnected". Drives the
   * status line: the unknown / no-daemon / socket-drop state keeps the presence
   * text; only an explicit disconnect shows CONNECTION_STATUS_DISCONNECTED.
   */
  private explicitlyDisconnected = false;
  /** Last presence-derived status text, restored when the session is shown. */
  private presenceText: string | undefined = undefined;

  /**
   * Asks announced to the phone (as an { ask } frame), keyed by requestId. The
   * permission system's own dialog owns each ask's lifecycle; a later
   * `permissions:decision` for an announced requestId closes the phone's card
   * via onDecision and forgets it. A decision for any other requestId is
   * ignored. Dropped wholesale on session end / re-register so a torn-down
   * session leaves nothing lingering.
   */
  private announcedAsks = new Set<string>();

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

  // ── Progress throttle (muster #502) ──────────────────────────────────────
  /** Newest held progress frame per kind ('message_update' | 'tool:<id>'). */
  private readonly pendingProgress = new Map<string, unknown>();
  /** The scheduled trailing flush, or undefined when none is pending. */
  private flushTimer: TimerHandle | undefined;
  /** now() of the last flush, so flushes happen at most once per window. */
  private lastFlushAt = Number.NEGATIVE_INFINITY;
  /** Whether we've registered the transport's drain retry (once, lazily). */
  private drainRegistered = false;

  private readonly now: () => number;
  private readonly setTimer: (cb: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer =
      deps.setTimer ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        // A pending flush must never keep pi's process alive.
        if (typeof t === "object" && t && "unref" in t) (t as { unref: () => void }).unref();
        return t;
      });
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * Hold a streamed progress frame newest-wins under `key`, and ensure a
   * trailing flush is scheduled. The frame object is kept as-is and only
   * serialized when (and if) it is actually flushed — a superseded snapshot is
   * never stringified (this is what breaks the quadratic bytes/turn cost).
   */
  private holdProgress(key: string, frame: unknown): void {
    this.pendingProgress.set(key, frame);
    this.scheduleFlush();
  }

  /** Schedule the trailing flush timer if none is pending (at most 1/window). */
  private scheduleFlush(): void {
    if (this.flushTimer !== undefined) return;
    const elapsed = this.now() - this.lastFlushAt;
    const delay = Math.max(0, PROGRESS_THROTTLE_MS - elapsed);
    this.flushTimer = this.setTimer(() => {
      this.flushTimer = undefined;
      this.flushProgress(false);
    }, delay);
  }

  /**
   * Write every held progress frame (one per kind, newest) and clear the buffer.
   * When `force` is false and the transport is over its high-water mark, keep
   * the pending frames and arm a drain retry instead (Task C). `force` (a
   * boundary flush) always writes, to preserve wire order.
   */
  private flushProgress(force: boolean): void {
    if (this.pendingProgress.size === 0) return;
    if (!force && this.deps.canSendProgress && !this.deps.canSendProgress()) {
      this.armDrainRetry();
      return;
    }
    this.lastFlushAt = this.now();
    const frames = [...this.pendingProgress.values()];
    this.pendingProgress.clear();
    for (const frame of frames) this.deps.send(frame);
  }

  /** Register the transport's drain callback once so a held flush is retried. */
  private armDrainRetry(): void {
    if (this.drainRegistered || !this.deps.onDrain) return;
    this.drainRegistered = true;
    this.deps.onDrain(() => {
      // The transport drained: retry the held flush (still gated, in case the
      // buffer is over the mark again by the time this runs).
      this.flushProgress(false);
    });
  }

  /**
   * Every non-progress (boundary) frame: flush pending progress FIRST so the
   * newest snapshot precedes the boundary on the wire (boundaries must never be
   * dropped or reordered), then write the boundary itself. Boundary flushes are
   * forced — written even under backpressure — so order is always preserved.
   */
  private sendBoundary(frame: unknown): void {
    if (this.flushTimer !== undefined) {
      this.clearTimer(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushProgress(true);
    this.deps.send(frame);
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
      // A reconnect re-registers: drop any ask announced across the gap (the
      // daemon re-affirms connection fresh and stale-acks open asks) so nothing
      // lingers.
      if (this.hasRegistered) this.clearAnnouncedAsks();
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
    if (e?.type === "message_update" || e?.type === "tool_execution_update") {
      // A progress delta: strip pi's duplicate cumulative snapshot (muster #502)
      // and hold it newest-wins, keyed per kind (per toolCallId for tool
      // updates) so a burst collapses to one flushed frame per window.
      const key =
        e.type === "tool_execution_update"
          ? `tool:${(piEvent as { toolCallId?: string }).toolCallId ?? ""}`
          : "message_update";
      this.holdProgress(key, { event: stripProgressPartial(piEvent) });
      return;
    }
    if (e?.type === "message_end") {
      const role = e.message?.role;
      if (role !== undefined && PERSISTED_ROLES.has(role)) {
        this.sendBoundary({ event: piEvent, cursor: this.deps.getEntries().length + 1 });
        return;
      }
    }
    this.sendBoundary({ event: piEvent });
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
      this.sendBoundary({ lock: "held" });
    } else {
      this.phase = "local_turn";
    }
    this.sendBoundary({ turn: "start" });
  }

  turnEnd(): void {
    if (!this.isActive) return;
    const wasPhoneTurn = this.phase === "phone_turn";
    this.sendBoundary({ turn: "end" });
    if (wasPhoneTurn) {
      this.sendBoundary({ lock: "released" });
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
    this.sendBoundary({ exit: { code } });
    this.clearAnnouncedAsks();
  }

  /**
   * Drop every announced ask. The permission system's own dialog still owns
   * each ask's lifecycle; the daemon stale-acks any open ask on extension exit
   * / re-register, so pi-hail simply forgets them (no askDone).
   */
  private clearAnnouncedAsks(): void {
    this.announcedAsks.clear();
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
        this.sendBoundary({ refused: { requestId: prompt.requestId, reason: "turn_running" } });
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
      if (v === "connected") {
        this.connected = true;
        this.explicitlyDisconnected = false;
        this.renderStatus();
      } else if (v === "disconnected") {
        this.connected = false;
        this.explicitlyDisconnected = true;
        this.renderStatus();
      } else if (v === "unavailable") {
        this.connected = false;
        this.deps.ui.notify(
          "hail: this session isn't shared with your phone (only proj/tmux sessions can connect).",
          "info",
        );
      }
      return;
    }
    if ("resend" in m) {
      const resend = m.resend as { since?: number; limit?: number };
      this.onResend(resend.since ?? 0, resend.limit ?? 0);
      return;
    }
    if ("answer" in m) {
      const answer = m.answer as { requestId: string; value: unknown };
      // Route the phone's verdict to the permission system's prompt-answerer
      // seam. A `false` return (no such showing prompt, or the seam disabled) is
      // a no-op here \u2014 the permissions:decision event closes the card. Unknown
      // values are ignored (never an implicit allow).
      const value = answer.value;
      if (value === "allow" || value === "deny") {
        this.deps.answerPrompt?.(answer.requestId, value);
      }
      return;
    }
    if ("ctl" in m) {
      // Task 5/later
      return;
    }
  }

  /**
   * Mirror the permission system's own prompt to the phone as an { ask } frame
   * (spec §B). pi-hail draws no dialog of its own: the permission system owns the
   * single dialog, and the phone answers that same prompt through the
   * prompt-answerer seam. An ask is announced ONLY while the daemon has affirmed
   * this session is connected to phones — otherwise there is nowhere to show it
   * and the Mac dialog is the only surface.
   *
   * `title`/`message` are derived from the `permissions:ui_prompt` event's
   * `surface`/`value` and its invariant `request` facts, so the card reads like
   * "Allow bash?" plus the command/path. Each requestId is announced at most once
   * and tracked; a later `permissions:decision` closes it.
   */
  announceAsk(event: UiPromptFacts): void {
    if (!this.isActive || !this.connected) return;
    const requestId = event.requestId;
    if (!requestId || this.announcedAsks.has(requestId)) return;

    const request = event.request ?? undefined;
    const toolName = optString(request?.toolName);
    const surface = optString(event.surface) ?? optString(request?.surface);
    const value = optString(event.value) ?? optString(request?.value) ?? "";
    const label = toolName ?? surface ?? "this";

    const ask: {
      requestId: string;
      title: string;
      message: string;
      toolName?: string;
      surface?: string;
      value?: string;
    } = { requestId, title: `Allow ${label}?`, message: value };
    if (toolName) ask.toolName = toolName;
    if (surface) ask.surface = surface;
    if (value) ask.value = value;

    this.announcedAsks.add(requestId);
    this.sendBoundary({ ask });
  }

  /**
   * The permission system's own dialog settled an announced ask (via
   * `permissions:decision`). Close the phone's card with an askDone carrying the
   * final outcome and who answered: `phone` when the decision came through the
   * prompt-answerer seam (the extension maps `decidedBy`), else `mac` (dialog,
   * auto-confirm, rule, yolo, …). A decision for a requestId pi-hail never
   * announced is ignored, and each ask closes only once.
   */
  onDecision(requestId: string, result: "allow" | "deny", by: "mac" | "phone"): void {
    if (!this.isActive) return;
    if (!this.announcedAsks.has(requestId)) return;
    this.announcedAsks.delete(requestId);
    this.sendBoundary({
      askDone: { requestId, outcome: result === "allow" ? "allowed" : "denied", by },
    });
  }

  /** Ask the daemon to connect/disconnect this session. False when inert. */
  requestConnection(connect: boolean): boolean {
    if (!this.isActive) return false;
    this.sendBoundary({ connection: connect ? "connect" : "disconnect" });
    return true;
  }

  /**
   * Replay completed message entries after `since` at catch-up priority. Each
   * replay frame carries its absolute cursor (since + i + 1) so the daemon
   * records where it left off; the trailing { resend:"done" } flushes its hold.
   *
   * When `limit` > 0 and there are more replayable frames than `limit`, only the
   * LAST `limit` frames are sent (streaming spec \u00a7A). A single
   * hail_history_trimmed marker is sent FIRST, carrying the count skipped and the
   * cursor of the last skipped frame, so the daemon's stored cursor advances
   * past the whole skipped range. `limit` 0 (or absent) is uncapped \u2014 today's
   * behavior, no marker.
   */
  onResend(since: number, limit = 0): void {
    if (!this.isActive) return;
    const { kept, skipped, lastSkippedCursor } = trimFrames(
      entriesAfter(this.deps.getEntries(), since),
      limit,
    );
    if (skipped > 0) {
      this.sendBoundary({
        event: { type: "hail_history_trimmed", skipped },
        replay: true,
        cursor: lastSkippedCursor,
      });
    }
    for (const { event, cursor } of kept) {
      this.sendBoundary({ event, replay: true, cursor });
    }
    this.sendBoundary({ resend: "done" });
  }

  /**
   * The control socket dropped (daemon unreachable). Fall back to NOT connected
   * so a permission ask defers to pi's normal prompt until a re-register is
   * affirmed by the daemon. Deliberately does NOT touch the status line: a
   * transport drop is the unknown state, not an explicit "disconnected".
   */
  onTransportDown(): void {
    this.connected = false;
    // The transport dropped its drain listeners (socket.onDisconnect); forget we
    // armed one so the next held progress flush re-arms against the new socket.
    this.drainRegistered = false;
  }

  private renderStatus(): void {
    if (this.explicitlyDisconnected) {
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

/** A non-empty string, or undefined for null / "" / non-strings. */
function optString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
