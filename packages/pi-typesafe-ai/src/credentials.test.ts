import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore, resolveTypeSafeDir, validateApiKey } from "./credentials.ts";

function tmpDir() { return mkdtempSync(join(tmpdir(), "pi-ts-")); }

test("validateApiKey accepts a printable-ASCII key and trims it", () => {
  assert.deepEqual(validateApiKey("  ts_abc123  "), { ok: true, key: "ts_abc123" });
});

test("validateApiKey rejects empty, whitespace, control, and non-ASCII", () => {
  assert.equal(validateApiKey("").ok, false);
  assert.equal(validateApiKey("ts abc").ok, false);
  assert.equal(validateApiKey("ts\tabc").ok, false);
  assert.equal(validateApiKey("ts\u00e9").ok, false);
});

test("validateApiKey rejects an over-long key", () => {
  assert.equal(validateApiKey("a".repeat(4097)).ok, false);
});

test("resolveTypeSafeDir honors PI_CODING_AGENT_DIR then falls back to ~/.pi/agent", () => {
  assert.equal(resolveTypeSafeDir({ PI_CODING_AGENT_DIR: "/x/agent" }, "/home/u"), "/x/agent/typesafe");
  assert.equal(resolveTypeSafeDir({}, "/home/u"), "/home/u/.pi/agent/typesafe");
});

test("write then read round-trips the key; file is 0600 and dir 0700", async () => {
  const dir = join(tmpDir(), "typesafe");
  const store = new CredentialStore({ dir });
  await store.write("ts_key_1");
  assert.deepEqual(await store.read(), { version: 1, apiKey: "ts_key_1" });
  assert.equal(statSync(store.file).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("read returns undefined when nothing stored; inspect never leaks the key", async () => {
  const dir = join(tmpDir(), "typesafe");
  const store = new CredentialStore({ dir });
  assert.equal(await store.read(), undefined);
  await store.write("ts_secret");
  const status = await store.inspect();
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes("ts_secret"));
});

test("write refuses to overwrite without replaceExisting", async () => {
  const dir = join(tmpDir(), "typesafe");
  const store = new CredentialStore({ dir });
  await store.write("ts_a");
  await assert.rejects(store.write("ts_b"), /replaceExisting/);
  await store.write("ts_b", { replaceExisting: true });
  assert.equal((await store.read())?.apiKey, "ts_b");
});

test("read refuses a symlinked credential file", async () => {
  const base = tmpDir();
  const dir = join(base, "typesafe");
  const store = new CredentialStore({ dir });
  await store.write("ts_a");
  rmSync(store.file);
  writeFileSync(join(base, "elsewhere.json"), '{"version":1,"apiKey":"ts_stolen"}');
  symlinkSync(join(base, "elsewhere.json"), store.file);
  await assert.rejects(store.read(), /symbolic link/);
});

test("clear removes the key and reports whether anything was there", async () => {
  const dir = join(tmpDir(), "typesafe");
  const store = new CredentialStore({ dir });
  assert.equal(await store.clear(), false);
  await store.write("ts_a");
  assert.equal(await store.clear(), true);
  assert.equal(await store.read(), undefined);
});

test("read rejects a corrupt file rather than silently ignoring it", async () => {
  const dir = join(tmpDir(), "typesafe");
  const store = new CredentialStore({ dir });
  await store.write("ts_a");
  writeFileSync(store.file, "not json", { mode: 0o600 });
  await assert.rejects(store.read(), /not valid JSON/);
});
