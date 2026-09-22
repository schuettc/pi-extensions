import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CredentialStore } from "./credentials.ts";
import { createTypeSafeExtension } from "./index.ts";

function harness() {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const notes: string[] = [];
  const pi = { registerCommand: (n: string, c: any) => commands.set(n, c) };
  const ctx = {
    ui: {
      notify: (m: string) => notes.push(m),
      input: async () => "ts_typed_key",
      confirm: async () => true,
    },
  };
  return { commands, notes, pi, ctx };
}

test("status reports not-configured without leaking, then configured after setup", async () => {
  const { commands, notes, pi, ctx } = harness();
  const store = new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") });
  createTypeSafeExtension(pi as any, { store });

  await commands.get("typesafe")!.handler("status", ctx);
  assert.match(notes.at(-1)!, /not configured|no key/i);

  await commands.get("typesafe")!.handler("setup", ctx);
  assert.equal((await store.read())?.apiKey, "ts_typed_key");
  assert.ok(!notes.some((n) => n.includes("ts_typed_key")));

  await commands.get("typesafe")!.handler("status", ctx);
  assert.match(notes.at(-1)!, /configured/i);
});

test("logout clears the stored key", async () => {
  const { commands, pi, ctx } = harness();
  const store = new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") });
  await store.write("ts_key");
  createTypeSafeExtension(pi as any, { store });
  await commands.get("typesafe")!.handler("logout", ctx);
  assert.equal(await store.read(), undefined);
});
