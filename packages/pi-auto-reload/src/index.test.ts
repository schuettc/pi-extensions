import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAutoReload, npmPackageName, packagesFingerprint, RELOAD_COMMAND } from "./index.ts";

test("npmPackageName strips versions, keeps scopes, ignores non-npm specs", () => {
  assert.equal(npmPackageName("npm:@schuettc/pi-auto-review@0.20.0-schuettc.3"), "@schuettc/pi-auto-review");
  assert.equal(npmPackageName("npm:@scope/name"), "@scope/name");
  assert.equal(npmPackageName("npm:pi-quiet"), "pi-quiet");
  assert.equal(npmPackageName("npm:pi-typesafe-ai@0.2.0"), "pi-typesafe-ai");
  assert.equal(npmPackageName("git:github.com/obra/superpowers"), undefined);
});

test("the fingerprint changes when a package is updated or the list changes", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-auto-reload-"));
  const install = (name: string, version: string) => {
    mkdirSync(join(dir, "npm", "node_modules", name), { recursive: true });
    writeFileSync(join(dir, "npm", "node_modules", name, "package.json"), JSON.stringify({ name, version }));
  };
  const settings = (packages: string[]) => writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages }));
  settings(["npm:@x/a@1.0.0", "npm:b", "git:github.com/y/z"]);
  install("@x/a", "1.0.0");
  install("b", "2.0.0");
  const first = packagesFingerprint(dir);
  assert.equal(packagesFingerprint(dir), first, "stable when nothing changes");
  install("@x/a", "1.1.0");
  const updated = packagesFingerprint(dir);
  assert.notEqual(updated, first, "a version bump changes it");
  // A reinstall of the same version changes the mtime.
  const pkg = join(dir, "npm", "node_modules", "b", "package.json");
  utimesSync(pkg, new Date(), new Date(Date.now() + 5_000));
  assert.notEqual(packagesFingerprint(dir), updated, "a reinstall changes it");
  const before = packagesFingerprint(dir);
  settings(["npm:@x/a@1.1.0", "npm:b", "npm:c"]);
  assert.notEqual(packagesFingerprint(dir), before, "a package list change changes it");
  assert.match(packagesFingerprint(dir), /c:missing/);
});

function harness(opts: { idle?: boolean; pending?: boolean } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sent: Array<{ text: string; options: unknown }> = [];
  const statuses: string[] = [];
  let fp = "v1";
  let idle = opts.idle ?? true;
  let tick: (() => void) | undefined;
  let cleared = false;
  const pi = {
    registerCommand: (name: string, options: never) => { commands.set(name, options); },
    on: (event: string, handler: (...args: unknown[]) => unknown) => { handlers.set(event, handler); },
    sendUserMessage: (text: string, options: unknown) => { sent.push({ text, options }); },
  } as unknown as ExtensionAPI;
  createAutoReload(pi, {
    fingerprint: () => fp,
    pollMs: 1_000,
    setInterval: (fn) => { tick = fn; return {}; },
    clearInterval: () => { cleared = true; },
  });
  const ctx = {
    isIdle: () => idle,
    hasPendingMessages: () => opts.pending ?? false,
    ui: { setStatus: (_key: string, text: string) => { statuses.push(text); } },
  };
  handlers.get("session_start")!({}, ctx);
  return {
    sent, statuses, commands, handlers,
    update: () => { fp = `v${Math.random()}`; },
    tick: () => tick!(),
    setIdle: (v: boolean) => { idle = v; },
    wasCleared: () => cleared,
  };
}

test("an idle session reloads itself through the hidden command after an update", () => {
  const h = harness();
  h.tick();
  assert.equal(h.sent.length, 0, "nothing changed yet");
  h.update();
  h.tick();
  assert.deepEqual(h.sent, [{ text: `/${RELOAD_COMMAND}`, options: { expandPromptTemplates: true } }]);
  assert.match(h.statuses.at(-1) ?? "", /reloading when idle/);
  h.tick();
  assert.equal(h.sent.length, 1, "triggers once");
});

test("a busy session waits until it settles; an open prompt blocks it", () => {
  const h = harness({ idle: false });
  h.update();
  h.tick();
  assert.equal(h.sent.length, 0, "busy: wait");
  h.setIdle(true);
  h.handlers.get("ui_prompt_start")!({});
  h.handlers.get("agent_settled")!({});
  assert.equal(h.sent.length, 0, "prompt open: wait");
  h.handlers.get("ui_prompt_end")!({});
  assert.equal(h.sent.length, 1, "reloads once the prompt closes");
});

test("queued messages defer the reload", () => {
  const h = harness({ pending: true });
  h.update();
  h.tick();
  assert.equal(h.sent.length, 0);
});

test("the hidden command reloads; a new session re-baselines; shutdown stops polling", async () => {
  const h = harness();
  let reloads = 0;
  await h.commands.get(RELOAD_COMMAND)!.handler("", { reload: async () => { reloads++; } });
  assert.equal(reloads, 1);
  h.update();
  h.handlers.get("session_start")!({}, { isIdle: () => true, hasPendingMessages: () => false, ui: { setStatus() {} } });
  h.tick();
  assert.equal(h.sent.length, 0, "the new session's baseline includes the update");
  h.handlers.get("session_shutdown")!({});
  assert.equal(h.wasCleared(), true);
});
