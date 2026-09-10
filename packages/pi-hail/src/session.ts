// The pure session controller. All effects are injected so every behaviour is
// unit-testable against fakes with no real daemon. This task (4) implements the
// register handshake, event forwarding, turn markers, and exit. The soft-lock
// state machine, presence, replay, and authorizer land in later tasks — the
// state fields below are declared now so those tasks only ADD, not rewrite.

import type { PromptPermissionDetails } from "@gotgenes/pi-permission-system";
import type { Phone, RegisterArgs, RegisterReply } from "./protocol.ts";
import { presenceToStatus } from "./status.ts";
import { EXTENSION_VERSION } from "./version.ts";

/** A phone-originated permission verdict. `defer` yields to pi's own prompt. */
export type PhoneDecision = "allow" | "deny" | "defer";

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

  /**
   * Permission gates the phone is being asked to answer, keyed by requestId.
   * Each resolver is fulfilled by an inbound { answer } (or resolved "defer" by
   * the authorizer's timeout, which then discards its own entry). Resolvers only
   * ever resolve — never reject — so a decision left dangling at session end
   * cannot surface as an unhandled rejection.
   */
  private pendingDecisions = new Map<string, (v: PhoneDecision) => void>();

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
   * A permission gate hit during a phone-driven turn. Outside a phone turn (or
   * when inert) resolve "defer" immediately so pi's normal prompt / pi-auto-review
   * decide. Otherwise announce the gate to the phone and hold the decision open,
   * keyed by requestId, until an inbound { answer } resolves it. Never throws.
   */
  requestPhoneDecision(details: PromptPermissionDetails): Promise<PhoneDecision> {
    if (!this.isActive || this.phase !== "phone_turn") {
      return Promise.resolve("defer");
    }
    const requestId = details.requestId;
    // Announce the ask to the phone as an event frame so it can render + answer.
    this.deps.send({ event: { type: "permission_prompt", requestId, details } });
    return new Promise<PhoneDecision>((resolve) => {
      this.pendingDecisions.set(requestId, resolve);
    });
  }

  /** false after a version-mismatch refusal → inert. */
  active(): boolean {
    return this.isActive;
  }
}
