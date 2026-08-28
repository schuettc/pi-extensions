import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadChannelConfig } from "./config.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "pi-channels-config-"));
}

test("returns empty when no config files exist", () => {
  const home = scratch();
  const cwd = scratch();
  assert.deepEqual(loadChannelConfig({ home, cwd }), {});
});

test("reads the global config", () => {
  const home = scratch();
  const cwd = scratch();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "channels.json"),
    JSON.stringify({ channelServers: { "muster-channel": { command: "muster", args: ["channel"] } } }),
  );
  assert.deepEqual(loadChannelConfig({ home, cwd }), {
    "muster-channel": { command: "muster", args: ["channel"] },
  });
});

test("project config overrides global by name and adds new names", () => {
  const home = scratch();
  const cwd = scratch();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "channels.json"),
    JSON.stringify({ channelServers: { galley: { command: "galley", args: ["channel"] } } }),
  );
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "channels.json"),
    JSON.stringify({
      channelServers: {
        galley: { command: "galley", args: ["channel", "--scope", "."] },
        "muster-channel": { command: "muster", args: ["channel"] },
      },
    }),
  );
  assert.deepEqual(loadChannelConfig({ home, cwd }), {
    galley: { command: "galley", args: ["channel", "--scope", "."] },
    "muster-channel": { command: "muster", args: ["channel"] },
  });
});

test("malformed JSON is skipped, not thrown", () => {
  const home = scratch();
  const cwd = scratch();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "channels.json"), "{ not json");
  assert.deepEqual(loadChannelConfig({ home, cwd }), {});
});

test("entries without a command string are rejected", () => {
  const home = scratch();
  const cwd = scratch();
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".pi", "agent", "channels.json"),
    JSON.stringify({ channelServers: { broken: { args: ["x"] }, ok: { command: "muster" } } }),
  );
  assert.deepEqual(loadChannelConfig({ home, cwd }), { ok: { command: "muster" } });
});
