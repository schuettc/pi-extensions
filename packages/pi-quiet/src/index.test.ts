import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import quietTools from "./index.ts";

// A project that sets a shell prefix in its own .pi/settings.json, plus an
// empty agent dir so the developer's real global settings never leak in.
function withFixture(run: (cwd: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pi-quiet-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ shellCommandPrefix: "export FROM_PROJECT=1" }),
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    run(cwd);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("the bash tool is registered from session_start, with pi's project-trust decision", () => {
  withFixture((cwd) => {
    const handlers = new Map<string, any>();
    const registered: any[] = [];
    const pi = {
      on: (event: string, handler: any) => handlers.set(event, handler),
      registerTool: (definition: any) => registered.push(definition),
    };

    quietTools(pi as any);

    // Nothing is registered at load time; the trust decision is not known yet.
    assert.equal(registered.length, 0);
    const onSessionStart = handlers.get("session_start");
    assert.equal(typeof onSessionStart, "function");

    onSessionStart({ type: "session_start", reason: "startup" }, {
      cwd,
      isProjectTrusted: () => true,
    });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "bash");
    assert.equal(typeof registered[0].renderCall, "function");
    assert.equal(typeof registered[0].renderResult, "function");
  });
});

// createBashToolDefinition does not expose the prefix it was constructed with,
// so the trust flag is pinned where it is observable: the settings read.
test("the project's shellCommandPrefix is visible only when the project is trusted", () => {
  withFixture((cwd) => {
    assert.equal(
      SettingsManager.create(cwd, undefined, { projectTrusted: true }).getShellCommandPrefix(),
      "export FROM_PROJECT=1",
    );
    assert.equal(
      SettingsManager.create(cwd, undefined, { projectTrusted: false }).getShellCommandPrefix(),
      undefined,
    );
  });
});

test("an older pi without isProjectTrusted still registers, failing closed", () => {
  withFixture((cwd) => {
    const handlers = new Map<string, any>();
    const registered: any[] = [];
    const pi = {
      on: (event: string, handler: any) => handlers.set(event, handler),
      registerTool: (definition: any) => registered.push(definition),
    };

    quietTools(pi as any);
    handlers.get("session_start")({ type: "session_start", reason: "startup" }, { cwd });

    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, "bash");
  });
});
