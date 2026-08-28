import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { ConnectionManager } from "../src/connection.ts";
import type { ChannelEvent } from "../src/envelope.ts";

function has(binary: string): boolean {
  try {
    execFileSync("command", ["-v", binary], { shell: "/bin/sh", stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function manager() {
  const events: ChannelEvent[] = [];
  const logs: string[] = [];
  const mgr = new ConnectionManager({
    onEvent: (e) => events.push(e),
    onStatus: () => {},
    log: (m) => logs.push(m),
  });
  return { mgr, events, logs };
}

test("muster channel handshakes and lists muster_channel_status", { skip: !has("muster") }, async () => {
  const { mgr } = manager();
  const conns = await mgr.connectAll({ "muster-channel": { command: "muster", args: ["channel"] } });
  assert.equal(conns.length, 1, "muster channel must declare the claude/channel capability");
  assert.ok((conns[0].instructions ?? "").length > 0);
  assert.ok(conns[0].tools.some((t) => t.name === "muster_channel_status"));
  await mgr.closeAll();
});

test("galley channel handshakes and lists galley_ack", { skip: !has("galley") }, async () => {
  const { mgr } = manager();
  const conns = await mgr.connectAll({ galley: { command: "galley", args: ["channel", "--scope", "."] } });
  assert.equal(conns.length, 1);
  assert.ok(conns[0].tools.some((t) => t.name === "galley_ack"));
  await mgr.closeAll();
});

test("galley channel sees AGENT_SESSION_ID when identity is applied first", {
  skip: !has("galley"),
  // todo, not a plain assertion: this is green only once the galley
  // AGENT_SESSION_ID patch lands (same phase, separate plan). node:test still
  // runs it and reports the outcome, so the cross-repo dependency stays
  // executable without leaving the suite permanently red.
  todo: "green once the galley AGENT_SESSION_ID patch lands",
}, async () => {
  const { mgr, logs } = manager();
  process.env.AGENT_SESSION_ID = "live-test-session";
  await mgr.connectAll({ galley: { command: "galley", args: ["channel", "--scope", "."] } });
  await new Promise((r) => setTimeout(r, 500));
  await mgr.closeAll();
  delete process.env.AGENT_SESSION_ID;
  const line = logs.find((l) => l.includes("session_id_present="));
  // Requires the same-phase galley patch; until it lands galley reads only
  // CLAUDE_CODE_SESSION_ID and this reports false.
  assert.ok(line, `expected galley's startup line in logs: ${logs.join(" | ")}`);
  assert.match(line, /session_id_present=true/);
});

test("calling muster_channel_status through the proxy returns content", { skip: !has("muster") }, async () => {
  const { mgr } = manager();
  const conns = await mgr.connectAll({ "muster-channel": { command: "muster", args: ["channel"] } });
  const result = await conns[0].client.request("tools/call", { name: "muster_channel_status", arguments: {} });
  assert.ok(result);
  await mgr.closeAll();
});
