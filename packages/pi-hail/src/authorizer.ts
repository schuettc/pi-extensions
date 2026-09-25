// pi-hail's live-authority chain link. It is a thin delegator: `authorize`
// asks the session to open the ask on both surfaces (phone + Mac dialog) and
// awaits the first answer, then maps the session's verdict to a chain verdict —
// allow→allow, deny→deny (with a teaching reason the model sees), defer→defer
// (the safe, non-interfering default that passes the ask to the next link, e.g.
// the permission system's own dialog). There is no timeout: the session awaits
// a human on either device. Registered into @gotgenes/pi-permission-system's
// authorizer chain by the extension entry; this module is the pure link +
// factory, unit-tested with no real permission system.

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
}

/**
 * Build the phone authorizer link. Its `authorize` delegates to the session's
 * first-answer-wins decision and maps it to a verdict. `requestPhoneDecision`
 * never throws, but a thrown decision still becomes a defer so pi's own prompt
 * runs.
 */
export function createPhoneAuthorizer(deps: PhoneAuthorizerDeps): {
  authorize: Authorizer["authorize"];
} {
  const { session } = deps;
  return {
    async authorize(
      details: PromptPermissionDetails,
      _query: PermissionQuery,
      _log: AuthorizerLog,
    ): Promise<AuthorizerVerdict> {
      let decision: "allow" | "deny" | "defer";
      try {
        decision = await session.requestPhoneDecision(details);
      } catch {
        decision = "defer";
      }
      if (decision === "allow") return { kind: "allow" };
      if (decision === "deny") return { kind: "deny", reason: "denied on phone" };
      return { kind: "defer" };
    },
  };
}
