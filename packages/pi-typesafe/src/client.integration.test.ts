import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./credentials.ts";
import { JevClient } from "./client.ts";

test("JevClient round-trips through the real SDK against a loopback server", async () => {
  const captured: any = {};
  const server = http.createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      captured.auth = req.headers.authorization; captured.path = req.url; captured.body = JSON.parse(raw || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ model: "jev-latest", answers: { q: { type: "noul", noul: 0.42 } }, usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const credentials = new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") });
    await credentials.write("ts_key_it");
    const client = new JevClient({ credentials, env: {}, baseURL: `http://127.0.0.1:${port}` });
    const out = await client.evaluate({ text: "hi" }, { q: { type: "noul", instructions: "?" } });
    assert.equal(captured.auth, "Bearer ts_key_it");
    assert.match(captured.path, /\/v1\/systemone/);
    assert.deepEqual(captured.body.state, { text: "hi" });
    assert.equal((out.answers.q as any).noul, 0.42);
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});
