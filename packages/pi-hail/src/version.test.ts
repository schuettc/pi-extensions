// Fails to publish a truthful C6 handshake if the extension can't read its own version.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EXTENSION_VERSION } from "./version.ts";

test("EXTENSION_VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "pi-hail");
  assert.equal(EXTENSION_VERSION, pkg.version);
  assert.equal(EXTENSION_VERSION, "0.4.0");
  assert.match(EXTENSION_VERSION, /^\d+\.\d+\.\d+/);
});
