import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthorizerLog } from "@gotgenes/pi-permission-system";
import { Session } from "./session.ts";
import { createPhoneAuthorizer } from "./authorizer.ts";
import { fakeDeps } from "./test-helpers.ts";

/** A no-op AuthorizerLog stub — a link records a trail; the test ignores it. */
function fakeLog(): AuthorizerLog {
  return { review: () => {}, debug: () => {} };
}

// Guards: the link is a thin delegator — the phone's allow becomes an allow verdict.
test("authorize returns allow when the session decides allow", async () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  const auth = createPhoneAuthorizer({ session: s });
  const p = auth.authorize({ requestId: "r9", toolName: "bash" } as never, {} as never, fakeLog());
  s.onInbound({ answer: { requestId: "r9", value: "allow" } });
  assert.deepEqual(await p, { kind: "allow" });
});

// Guards: a deny carries the teaching reason the invoking model sees.
test("authorize returns deny with a teaching reason", async () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  const auth = createPhoneAuthorizer({ session: s });
  const p = auth.authorize({ requestId: "r9", toolName: "bash" } as never, {} as never, fakeLog());
  deps.ui.openDialog.resolve("Deny");
  assert.deepEqual(await p, { kind: "deny", reason: "denied on phone" });
});

// Guards: a disconnected session yields to pi's own prompt (defer) — the link
// never intercepts an ask it cannot render on a phone.
test("authorize defers when the session is disconnected", async () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.onInbound({ connection: "disconnected" });
  const auth = createPhoneAuthorizer({ session: s });
  assert.deepEqual(
    await auth.authorize({ requestId: "r" } as never, {} as never, fakeLog()),
    { kind: "defer" },
  );
});

// Guards: Mac "More options…" defers so the permission system's full dialog runs.
test("authorize defers when the Mac dialog chooses More options…", async () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  const auth = createPhoneAuthorizer({ session: s });
  const p = auth.authorize({ requestId: "r9", toolName: "bash" } as never, {} as never, fakeLog());
  deps.ui.openDialog.resolve("More options…");
  assert.deepEqual(await p, { kind: "defer" });
});
