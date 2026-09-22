import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./credentials.ts";
import { JevClient } from "./client.ts";
import { evaluateBundle, type Bundle } from "./bundle.ts";

test("evaluateBundle runs the client and applies the bundle map", async () => {
  const credentials = new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") });
  await credentials.write("ts_key");
  const client = new JevClient({
    credentials, env: {},
    clientFactory: () => ({ systemOne: async () => ({ answers: { urgent: { type: "noul", noul: 0.8 } }, usage: {} }) }),
  });
  const bundle: Bundle<boolean> = {
    id: "is-urgent",
    questions: { urgent: { type: "noul", instructions: "urgent?" } },
    map: (a) => ((a.urgent as { noul: number }).noul) >= 0.5,
  };
  const out = await evaluateBundle(client, bundle, "help me now");
  assert.equal(out.value, true);
  assert.equal((out.answers.urgent as any).noul, 0.8);
});
