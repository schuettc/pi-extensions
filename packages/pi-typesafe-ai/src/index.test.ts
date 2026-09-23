import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CredentialStore } from "./credentials.ts";
import { createTypeSafeExtension, typesafeArgumentCompletions, TYPESAFE_SUBCOMMANDS } from "./index.ts";

type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];
type NotifyType = Parameters<ExtensionUIContext["notify"]>[1];

function harness(opts: { secret?: string | undefined; confirm?: boolean } = {}) {
  const secret = "secret" in opts ? opts.secret : "ts_typed_key";
  const commands = new Map<string, CommandOptions>();
  const notes: string[] = [];
  const types: NotifyType[] = [];
  const prompts: string[] = [];
  const pi = {
    registerCommand: (name: string, options: CommandOptions) => { commands.set(name, options); },
  } satisfies Pick<ExtensionAPI, "registerCommand">;
  // Typed against the real UI API so a wrong call shape in index.ts fails tsc.
  const ui: Pick<ExtensionUIContext, "notify" | "confirm"> = {
    notify: (message: string, type?: "info" | "warning" | "error") => { notes.push(message); types.push(type); },
    confirm: async (_title: string, _message: string) => opts.confirm ?? true,
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionCommandContext;
  const promptSecret = async (_ctx: ExtensionCommandContext, title: string) => { prompts.push(title); return secret; };
  const run = (args: string) => commands.get("typesafe")!.handler(args, ctx);
  return { commands, notes, types, prompts, pi: pi as unknown as ExtensionAPI, promptSecret, run };
}

function tempStore() {
  return new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-")), "typesafe") });
}

test("status reports not-configured, setup stores the key, status reports configured; key never notified", async () => {
  const h = harness();
  const store = tempStore();
  createTypeSafeExtension(h.pi, { store, promptSecret: h.promptSecret });

  await h.run("status");
  assert.match(h.notes.at(-1)!, /not configured/i);

  await h.run("setup");
  assert.equal((await store.read())?.apiKey, "ts_typed_key");
  assert.deepEqual(h.prompts, ["Paste your TypeSafe API key"]);
  assert.equal(h.notes.at(-1), "TypeSafe key stored.");

  await h.run("status");
  assert.match(h.notes.at(-1)!, /^TypeSafe key configured/);
  assert.ok(!h.notes.some((n) => n.includes("ts_typed_key")));
});

test("setup cancelled leaves the key unchanged", async () => {
  const h = harness({ secret: undefined });
  const store = tempStore();
  await store.write("ts_original");
  createTypeSafeExtension(h.pi, { store, promptSecret: h.promptSecret });

  await h.run("setup");
  assert.equal((await store.read())?.apiKey, "ts_original");
  assert.match(h.notes.at(-1)!, /Cancelled/);
});

test("logout clears the stored key", async () => {
  const h = harness();
  const store = tempStore();
  await store.write("ts_key");
  createTypeSafeExtension(h.pi, { store, promptSecret: h.promptSecret });
  await h.run("logout");
  assert.equal(await store.read(), undefined);
});

test("notify is only called with pi's real notification types", async () => {
  const h = harness();
  const store = tempStore();
  createTypeSafeExtension(h.pi, { store, promptSecret: h.promptSecret });
  for (const args of ["status", "setup", "setup", "status", "bogus", "logout", "status"]) await h.run(args);
  assert.ok(h.types.length > 0);
  for (const t of h.types) assert.ok(t === "info" || t === "warning" || t === "error", `unexpected notify type ${String(t)}`);
});

test("argument completions: empty prefix lists all subcommands", () => {
  const items = typesafeArgumentCompletions("");
  assert.deepEqual(items?.map((i) => i.value), ["setup", "status", "logout"]);
  assert.equal(TYPESAFE_SUBCOMMANDS.length, 3);
});

test("argument completions filter by trimmed, case-insensitive prefix", () => {
  assert.deepEqual(typesafeArgumentCompletions("se")?.map((i) => i.value), ["setup"]);
  assert.deepEqual(typesafeArgumentCompletions("ST")?.map((i) => i.value), ["status"]);
  assert.deepEqual(typesafeArgumentCompletions("  lo ")?.map((i) => i.value), ["logout"]);
  assert.equal(typesafeArgumentCompletions("x"), null);
});

test("every completion item has value, label and description", () => {
  for (const i of typesafeArgumentCompletions("") ?? []) {
    assert.ok(i.value && i.label && i.description, `incomplete item ${JSON.stringify(i)}`);
  }
});

test("registered /typesafe command exposes getArgumentCompletions", async () => {
  const h = harness();
  createTypeSafeExtension(h.pi, { store: tempStore(), promptSecret: h.promptSecret });
  const cmd = h.commands.get("typesafe")!;
  assert.equal(cmd.description, "TypeSafe (Jev) API key: setup | status | logout");
  assert.equal(typeof cmd.getArgumentCompletions, "function");
  const items = await cmd.getArgumentCompletions!("sta");
  assert.deepEqual(items?.map((i) => i.value), ["status"]);
});
