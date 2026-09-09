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

test("galley channel sees the session id it was spawned with", { skip: !has("galley") }, async () => {
  const { mgr, logs } = manager();
  await mgr.connectAll({ galley: { command: "galley", args: ["channel", "--scope", "."] } }, "live-test-session");
  await new Promise((r) => setTimeout(r, 500));
  await mgr.closeAll();
  // galley channel logs `session_id_present=true|false` on its first stderr
  // line; the manager relays stderr into the log.
  const line = logs.find((l) => l.includes("session_id_present="));
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
