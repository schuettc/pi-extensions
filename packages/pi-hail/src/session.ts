// The pure session controller. All effects are injected so every behaviour is
// unit-testable against fakes with no real daemon. This task (4) implements the
// register handshake, event forwarding, turn markers, and exit. The soft-lock
// state machine, presence, replay, and authorizer land in later tasks — the
// state fields below are declared now so those tasks only ADD, not rewrite.

import type { Phone, RegisterArgs, RegisterReply } from "./protocol.ts";
import { presenceToStatus } from "./status.ts";
import { EXTENSION_VERSION } from "./version.ts";

/** Which side owns the current turn. `idle` at rest. */
export type Phase = "idle" | "local_turn" | "phone_turn";

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
  /** replay source (Task 7) */
  readSessionEvents: (sinceSeq: number) => unknown[];
}

export interface RegisterInput {
  sessionId: string;
  project: string;
  work: string;
  dir: string;
  piVersion: string;
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

  /** Stamps extensionVersion; passes identity through verbatim. */
  buildRegisterArgs(input: RegisterInput): RegisterArgs {
    return {
      sessionId: input.sessionId,
      project: input.project,
      work: input.work,
      dir: input.dir,
      piVersion: input.piVersion,
      extensionVersion: EXTENSION_VERSION,
    };
  }

  /** Handles the register reply: stores replay cursor; refuses on mismatch. */
  onRegisterReply(reply: RegisterReply): void {
    if (reply.ok) {
      this.have = reply.data.have;
      // A reconnect (not the first register): replay pi's own session-file
      // events after the daemon's `have` cursor so device sequence numbers stay
      // continuous, BEFORE live forwarding resumes. First-connect skips replay.
      if (this.hasRegistered) {
        const events = this.deps.readSessionEvents(this.have ?? 0);
        for (const event of events) {
          // Wrap each entry exactly as live forwarding does: send({ event }).
          this.deps.send({ event });
        }
      }
      this.hasRegistered = true;
      return;
    }
    // ok:false → version mismatch / refusal. Go inert. Task 9 renders the notice.
    this.isActive = false;
  }

  /** Forward a pi event verbatim, wrapped as { event }. */
  forwardEvent(piEvent: unknown): void {
    if (!this.isActive) return;
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
      this.deps.ui.setStatus(presenceToStatus(presence.phones));
      return;
    }
    if ("answer" in m) {
      // Task 8
      return;
    }
    if ("ctl" in m) {
      // Task 5/later
      return;
    }
  }

  /** false after a version-mismatch refusal → inert. */
  active(): boolean {
    return this.isActive;
  }
}
