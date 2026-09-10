// pi-hail's live-authority chain link. During a phone-driven turn it holds the
// permission ask open until the phone (or the local user) answers, falling back
// to pi's own prompt (`defer`) on timeout — so a gate never hangs and, outside a
// phone turn, pi/pi-auto-review decide normally. Registered into
// @gotgenes/pi-permission-system's authorizer chain by the extension entry
// (Task 10); this module is the pure link + factory, unit-tested with no real
// permission system.

import type {
  Authorizer,
  AuthorizerLog,
  AuthorizerVerdict,
  PermissionQuery,
  PromptPermissionDetails,
} from "@gotgenes/pi-permission-system";
import type { Session } from "./session.ts";

export interface PhoneAuthorizerDeps {
  session: Session;
  /** How long to hold a gate open for the phone before deferring to pi's prompt. */
  timeoutMs: number;
  /** Injectable clock (defaults to Date.now); present for deterministic tests. */
  now?: () => number;
}

/**
 * Build the phone authorizer link. Its `authorize` asks the session for a phone
 * decision and maps it to a verdict: allow→allow, deny→deny (with a teaching
 * reason the model sees), everything else / timeout→defer (the safe,
 * non-interfering default that passes the ask to the next chain link).
 */
export function createPhoneAuthorizer(deps: PhoneAuthorizerDeps): {
  authorize: Authorizer["authorize"];
} {
  const { session, timeoutMs } = deps;
  return {
    async authorize(
      details: PromptPermissionDetails,
      _query: PermissionQuery,
      _log: AuthorizerLog,
    ): Promise<AuthorizerVerdict> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutP = new Promise<"defer">((resolve) => {
        timer = setTimeout(() => resolve("defer"), timeoutMs);
        // Our timeout must never keep pi's event loop alive on its own.
        if (typeof timer?.unref === "function") timer.unref();
      });
      let decision: "allow" | "deny" | "defer";
      try {
        decision = await Promise.race([session.requestPhoneDecision(details), timeoutP]);
      } catch {
        // requestPhoneDecision never throws, but stay safe: a thrown decision
        // becomes a defer so pi's own prompt still runs.
        decision = "defer";
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (decision === "allow") return { kind: "allow" };
      if (decision === "deny") return { kind: "deny", reason: "denied on phone" };
      return { kind: "defer" };
    },
  };
}
