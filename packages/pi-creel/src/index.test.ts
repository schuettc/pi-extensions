import { test } from "node:test";
import assert from "node:assert/strict";

import { createCreel, type Deps } from "./index.ts";
import type { TmuxContext } from "./tmux.ts";

type Registered = {
  name: string;
  execute: (id: string, params: any) => Promise<{ content: { text: string }[] }>;
};

function harness(deps: Deps): Registered {
  let reg: Registered | undefined;
  const pi = {
    registerTool(def: Registered) {
      reg = def;
    },
  };
  createCreel(pi, deps);
  if (!reg) throw new Error("tool not registered");
  return reg;
}

const tmux: TmuxContext = { socket: "proj-x", pane: "%1" };
const okDeps = (overrides: Partial<Deps> = {}): Deps => ({
  resolveTmux: () => tmux,
  creelOnPath: () => true,
  spawnPopup: () => {},
  waitForToken: async () => "added",
  tmpStatusPath: () => "/tmp/creel-status-test",
  ...overrides,
});

async function run(reg: Registered, params: any): Promise<string> {
  const out = await reg.execute("id", params);
  return out.content[0].text;
}

test("registers request_secret", () => {
  const reg = harness(okDeps());
  assert.equal(reg.name, "request_secret");
});

test("rejects an invalid name before touching tmux", async () => {
  let spawned = false;
  const reg = harness(okDeps({ spawnPopup: () => { spawned = true; } }));
  const text = await run(reg, { name: "BAD-NAME" });
  assert.match(text, /not a valid environment-variable name/);
  assert.equal(spawned, false);
});

test("fails fast when not in tmux", async () => {
  const reg = harness(okDeps({ resolveTmux: () => undefined }));
  const text = await run(reg, { name: "OPENAI_API_KEY" });
  assert.match(text, /needs a tmux session/);
});

test("fails when creel is not on PATH", async () => {
  const reg = harness(okDeps({ creelOnPath: () => false }));
  const text = await run(reg, { name: "OPENAI_API_KEY" });
  assert.match(text, /'creel' binary was not found/);
});

test("passes name and default dest to the popup and maps the token", async () => {
  let gotCommand = "";
  const reg = harness(
    okDeps({
      spawnPopup: (_t, command) => { gotCommand = command; },
      waitForToken: async () => "updated",
    }),
  );
  const text = await run(reg, { name: "OPENAI_API_KEY" });
  assert.match(gotCommand, /creel 'OPENAI_API_KEY' --dest '\.env' --status-file/);
  assert.match(text, /Updated OPENAI_API_KEY in \.env/);
});

test("honors a custom dest", async () => {
  let gotCommand = "";
  const reg = harness(okDeps({ spawnPopup: (_t, c) => { gotCommand = c; } }));
  await run(reg, { name: "K", dest: "config/.env" });
  assert.match(gotCommand, /--dest 'config\/\.env'/);
});

test("reports a timeout when no token arrives", async () => {
  const reg = harness(okDeps({ waitForToken: async () => undefined }));
  const text = await run(reg, { name: "K" });
  assert.match(text, /Timed out/);
});

test("surfaces a creel error token", async () => {
  const reg = harness(okDeps({ waitForToken: async () => "error:dest-outside-cwd" }));
  const text = await run(reg, { name: "K", dest: "../x.env" });
  assert.match(text, /Could not store K: dest-outside-cwd/);
});
