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
  const text = await run(reg, { name: "K", dest: "sub/.env" });
  assert.match(text, /Could not store K: dest must be inside the working directory/);
});

// The popup exits non-zero when creel refuses (tmux then throws), but creel has
// already written its reason to the status file: the agent must get that
// reason, not a bare "Command failed".
test("a popup that exits non-zero still reports creel's reason", async () => {
  const reg = harness(okDeps({
    spawnPopup: () => { throw new Error("Command failed: tmux display-popup ..."); },
    readStatus: () => "error:dest-outside-cwd",
  }));
  const text = await run(reg, { name: "K", dest: "sub/.env" });
  assert.match(text, /Could not store K/);
  assert.match(text, /inside the working directory/);
  assert.doesNotMatch(text, /Command failed/);
});

test("a popup that fails with no status keeps the tmux error", async () => {
  const reg = harness(okDeps({
    spawnPopup: () => { throw new Error("no server running"); },
    readStatus: () => undefined,
  }));
  assert.match(await run(reg, { name: "K" }), /Failed to run the creel popup: .*no server running/);
});

// A dest outside the working directory is refused before any popup opens, with
// the rule and a path that works.
test("a dest outside the working directory is refused without opening the popup", async () => {
  for (const dest of ["../../tmp/x/.env", "/tmp/x/.env"]) {
    let spawned = false;
    const reg = harness(okDeps({ spawnPopup: () => { spawned = true; } }));
    const text = await run(reg, { name: "K", dest });
    assert.equal(spawned, false, `popup opened for ${dest}`);
    assert.match(text, /inside the working directory/);
    assert.match(text, /\.worktrees\//);
  }
});

test("a dest inside the working directory, absolute or relative, opens the popup", async () => {
  for (const dest of [".worktrees/check/.env", `${process.cwd()}/sub/.env`]) {
    let spawned = false;
    const reg = harness(okDeps({ spawnPopup: () => { spawned = true; } }));
    await run(reg, { name: "K", dest });
    assert.equal(spawned, true, `popup not opened for ${dest}`);
  }
});

test("the tool description states the dest rule", () => {
  let def: any;
  createCreel({ registerTool(d: any) { def = d; } }, okDeps());
  assert.match(def.parameters.properties.dest.description, /inside the working directory/);
});
