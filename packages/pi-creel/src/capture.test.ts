import { test } from "node:test";
import assert from "node:assert/strict";

import { validName, creelCommand, tokenToText } from "./capture.ts";

test("validName accepts env identifiers and rejects the rest", () => {
  for (const s of ["A", "OPENAI_API_KEY", "_x", "a1_b2"]) {
    assert.equal(validName(s), true, s);
  }
  for (const s of ["", "1ABC", "A-B", "A B", "A.B", "$X"]) {
    assert.equal(validName(s), false, s);
  }
});

test("creelCommand single-quotes its arguments", () => {
  assert.equal(
    creelCommand("OPENAI_API_KEY", ".env", "/tmp/creel-status-abc"),
    "creel 'OPENAI_API_KEY' --dest '.env' --status-file '/tmp/creel-status-abc'",
  );
});

test("creelCommand neutralizes a quote in the destination", () => {
  const cmd = creelCommand("K", "a'b/.env", "/tmp/s");
  assert.equal(cmd, "creel 'K' --dest 'a'\\''b/.env' --status-file '/tmp/s'");
});

test("tokenToText maps every outcome and never echoes a value", () => {
  assert.match(tokenToText("added", "OPENAI_API_KEY", ".env"), /Added OPENAI_API_KEY to \.env/);
  assert.match(tokenToText("updated", "OPENAI_API_KEY", ".env"), /Updated OPENAI_API_KEY in \.env/);
  assert.match(tokenToText("cancelled", "K", ".env"), /cancelled/i);
  assert.match(tokenToText("error:dest-outside-cwd", "K", ".env"), /Could not store K: dest-outside-cwd/);
  assert.match(tokenToText(undefined, "K", ".env"), /Timed out/);
  assert.match(tokenToText("", "K", ".env"), /Timed out/);
  assert.match(tokenToText("weird", "K", ".env"), /unexpected status \(weird\)/);
});

test("a successful capture tells the model how to consume the secret", () => {
  for (const token of ["added", "updated"]) {
    const text = tokenToText(token, "TYPESAFE_API_KEY", ".env");
    // Points at the containment path (creel exec) with the real var name...
    assert.match(text, /creel exec TYPESAFE_API_KEY -- /);
    // ...and the relaunch fallback...
    assert.match(text, /process\.env\.TYPESAFE_API_KEY/);
    // ...and steers the model away from reading the .env itself.
    assert.match(text, /do not read|don't read/i);
  }
});
