import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./credentials.ts";
import { JevClient } from "./client.ts";

function store() { return new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") }); }

test("isConfigured reflects the credential file", async () => {
  const credentials = store();
  const client = new JevClient({ credentials, env: {} });
  assert.equal(await client.isConfigured(), false);
  await credentials.write("ts_key");
  assert.equal(await client.isConfigured(), true);
});

test("isConfigured honors the env fallback when no file exists", async () => {
  const client = new JevClient({ credentials: store(), env: { TYPESAFE_API_KEY: "ts_env" } });
  assert.equal(await client.isConfigured(), true);
});

test("evaluate passes key+state+questions to the SDK and returns answers+latency", async () => {
  const credentials = store();
  await credentials.write("ts_key");
  const seen: any = {};
  const client = new JevClient({
    credentials, env: {}, defaultModel: "jev-latest", defaultTimeoutMs: 8000,
    clientFactory: (cfg) => {
      seen.cfg = cfg;
      return { systemOne: async (req: any) => { seen.req = req; return { answers: { q: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1 } }; } };
    },
  });
  const out = await client.evaluate({ s: 1 }, { q: { type: "noul", instructions: "?" } });
  assert.equal(seen.cfg.apiKey, "ts_key");
  assert.equal(seen.req.model, "jev-latest");
  assert.deepEqual(seen.req.state, { s: 1 });
  assert.equal((out.answers.q as { noul: number }).noul, 0.9);
  assert.ok(out.latencyMs >= 0);
});

test("evaluate throws when no key is resolvable", async () => {
  const client = new JevClient({ credentials: store(), env: {}, clientFactory: () => { throw new Error("should not construct"); } });
  await assert.rejects(client.evaluate({}, { q: { type: "noul", instructions: "?" } }), /key/i);
});
