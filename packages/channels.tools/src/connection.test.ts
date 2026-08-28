import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { ConnectionManager } from "./connection.ts";
import type { ChannelEvent } from "./envelope.ts";

const FAKE = join(import.meta.dirname, "..", "test", "fake-channel-server.ts");

function manager(overrides: { retryBaseMs?: number; retryMaxMs?: number } = {}) {
  const events: ChannelEvent[] = [];
  const statuses: string[] = [];
  const logs: string[] = [];
  const mgr = new ConnectionManager({
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    ...overrides,
  });
  return { mgr, events, statuses, logs };
}

test("connects a server declaring the channel capability and captures instructions and tools", async () => {
  const { mgr } = manager();
  const conns = await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  assert.equal(conns.length, 1);
  assert.equal(conns[0].name, "fake");
  assert.equal(conns[0].instructions, "FAKE CORE INSTRUCTIONS");
  assert.equal(conns[0].tools.length, 1);
  assert.equal(conns[0].tools[0].name, "fake_status");
  await mgr.closeAll();
});

test("rejects a server that does not declare the capability", async () => {
  const { mgr, logs } = manager();
  const conns = await mgr.connectAll({
    nope: { command: process.execPath, args: [FAKE], env: { FAKE_NO_CAPABILITY: "1" } },
  });
  assert.equal(conns.length, 0);
  assert.ok(logs.some((l) => /capability/i.test(l)), `expected a capability log, got: ${logs.join(" | ")}`);
  // Capability rejection is a permanent incompatibility, not a transient
  // fault — it must never be retried.
  assert.ok(!logs.some((l) => /retry|retrying/i.test(l)), `expected no retry log, got: ${logs.join(" | ")}`);
  await mgr.closeAll();
});

test("a missing binary is reported, not thrown, and is retried", async () => {
  const { mgr, logs } = manager();
  const conns = await mgr.connectAll({ ghost: { command: "definitely-not-a-real-binary-xyz" } });
  assert.equal(conns.length, 0);
  assert.ok(logs.some((l) => /ghost/.test(l)));
  assert.ok(logs.some((l) => /retry|retrying/i.test(l)), `expected a retry log, got: ${logs.join(" | ")}`);
  await mgr.closeAll();
});

test("an inbound channel notification reaches onEvent tagged with its source", async () => {
  const { mgr, events } = manager();
  await mgr.connectAll({
    fake: { command: process.execPath, args: [FAKE], env: { FAKE_PUSH_AFTER_MS: "50" } },
  });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "fake");
  assert.match(events[0].content, /something happened/);
  assert.equal(events[0].meta.intent, "fyi");
  await mgr.closeAll();
});

test("notifications other than the channel notification are ignored", async () => {
  const { mgr, events } = manager();
  const conns = await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  conns[0].client.notify("notifications/unrelated", { x: 1 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(events.length, 0);
  await mgr.closeAll();
});

test("closeAll is idempotent and leaves no connections", async () => {
  const { mgr } = manager();
  await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  await mgr.closeAll();
  await mgr.closeAll();
  assert.equal(mgr.connections().length, 0);
});

test("connectAll after a previous connect replaces rather than duplicates", async () => {
  const { mgr } = manager();
  await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  assert.equal(mgr.connections().length, 1);
  await mgr.closeAll();
});

test("a child that dies mid-handshake is not accepted, reports unhealthy, is retried, and connectAll returns promptly", async () => {
  const { mgr, logs, statuses } = manager();
  const start = Date.now();
  // This process spawns successfully but exits immediately without ever
  // reading stdin or writing a response — a deterministic way to die before
  // `initialize` can complete, without racing a timer against a fixture.
  const conns = await mgr.connectAll({
    dead: { command: process.execPath, args: ["-e", "process.exit(1)"] },
  });
  const elapsed = Date.now() - start;
  assert.equal(conns.length, 0);
  assert.equal(mgr.connections().length, 0);
  assert.ok(logs.some((l) => /handshake/i.test(l)), `expected a mid-handshake log, got: ${logs.join(" | ")}`);
  assert.ok(logs.some((l) => /retry|retrying/i.test(l)), `expected a retry log, got: ${logs.join(" | ")}`);
  assert.ok(statuses.some((s) => /DEGRADED/.test(s)), `expected a DEGRADED status, got: ${statuses.join(" | ")}`);
  assert.ok(elapsed < 5000, `connectAll took ${elapsed}ms — it must not stall on the JSON-RPC 30s timeout`);
  await mgr.closeAll();
});

test("a channel that dies after connecting is marked degraded and a retry is scheduled", async () => {
  const { mgr, logs, statuses } = manager();
  const conns = await mgr.connectAll({
    fake: { command: process.execPath, args: [FAKE], env: { FAKE_EXIT_AFTER_MS: "50" } },
  });
  assert.equal(conns.length, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(mgr.connections().length, 0);
  assert.ok(statuses.some((s) => /DEGRADED/.test(s)), `expected a DEGRADED status, got: ${statuses.join(" | ")}`);
  assert.ok(logs.some((l) => /retrying/i.test(l)), `expected a retry log, got: ${logs.join(" | ")}`);
  await mgr.closeAll();
});

test("closeAll while a connect is mid-handshake kills the pending child promptly and it never becomes live", async () => {
  const { mgr } = manager();
  // Never responds to initialize and never exits on its own — the only way
  // this settles is if closeAll() actively kills it.
  const connectPromise = mgr.connectAll({
    hang: { command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"] },
  });
  await new Promise((r) => setTimeout(r, 150));
  const start = Date.now();
  await mgr.closeAll();
  const conns = await connectPromise;
  const elapsed = Date.now() - start;
  assert.equal(conns.length, 0);
  assert.equal(mgr.connections().length, 0);
  assert.ok(elapsed < 5000, `closeAll + settle took ${elapsed}ms — the pending child must be killed, not waited out`);
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("closeAll kills a child that ignores SIGTERM, and it exits promptly", async () => {
  const { mgr, logs } = manager();
  // A real muster channel process ignores SIGTERM outright — only SIGKILL
  // ends it. Without the escalation in killChild(), this child (and the
  // real one) survives closeAll() as an orphan, holding its stdio pipes
  // open and hanging the process that spawned it.
  await mgr.connectAll({
    stubborn: { command: process.execPath, args: [FAKE], env: { FAKE_IGNORE_SIGTERM: "1" } },
  });
  const pidLine = logs.find((l) => l.includes("PID:"));
  assert.ok(pidLine, `expected the fake server to report its pid, got: ${logs.join(" | ")}`);
  const pid = Number(pidLine.split("PID:")[1]);
  assert.ok(isAlive(pid), `expected pid ${pid} to be alive before closeAll()`);

  const start = Date.now();
  await mgr.closeAll();
  while (isAlive(pid)) {
    assert.ok(Date.now() - start < 2000, `pid ${pid} is still alive ${Date.now() - start}ms after closeAll()`);
    await new Promise((r) => setTimeout(r, 20));
  }
});

test("connections() is ordered by configured server order, not handshake completion order (F4)", async () => {
  const { mgr } = manager();
  // "slow" is listed first in the config but will finish its handshake
  // later — a fake server has no artificial handshake delay knob, so this
  // relies on "fast" being pushed a channel event to prove genuine liveness,
  // while ordering itself is asserted purely from `defs` key order.
  await mgr.connectAll({
    zeta: { command: process.execPath, args: [FAKE] },
    alpha: { command: process.execPath, args: [FAKE] },
    mid: { command: process.execPath, args: [FAKE] },
  });
  const names = mgr.connections().map((c) => c.name);
  assert.deepEqual(names, ["zeta", "alpha", "mid"], `expected configured order, got: ${names.join(", ")}`);
  await mgr.closeAll();
});

test("a live stream error is logged rather than silently swallowed (F3)", async () => {
  const { mgr, logs } = manager();
  const conns = await mgr.connectAll({ fake: { command: process.execPath, args: [FAKE] } });
  const entry = (mgr as unknown as { live: Map<string, { child: { stdout: NodeJS.ReadableStream } }> }).live.get(
    "fake",
  );
  assert.ok(entry, "fake must be live");
  entry!.child.stdout.emit("error", new Error("EPIPE synthetic"));
  assert.ok(
    logs.some((l) => /stdout error/i.test(l) && /EPIPE synthetic/.test(l)),
    `expected a logged stdout error, got: ${logs.join(" | ")}`,
  );
  assert.equal(conns.length, 1);
  await mgr.closeAll();
});

test("a retry that reconnects fires onConnected with the up-to-date connection list (F1)", async () => {
  const events: ChannelEvent[] = [];
  const statuses: string[] = [];
  const logs: string[] = [];
  const onConnectedCalls: string[][] = [];
  const mgr = new ConnectionManager({
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    log: (m) => logs.push(m),
    onConnected: (conns) => onConnectedCalls.push(conns.map((c) => c.name)),
    retryBaseMs: 40,
    retryMaxMs: 40,
  });
  // A process that spawns and exits immediately without responding to
  // initialize: a deterministic mid-handshake death on the *first* attempt.
  // The retry's own connectOne (same command/args) will hit the same fate
  // every time with this fixture, so instead swap the def in place before
  // the retry fires: scheduleRetry reads `this.defs[name]` fresh each time,
  // so mutating the manager's stored def changes what the retry spawns.
  const conns = await mgr.connectAll({ flaky: { command: process.execPath, args: ["-e", "process.exit(1)"] } });
  assert.equal(conns.length, 0);
  (mgr as unknown as { defs: Record<string, unknown> }).defs.flaky = { command: process.execPath, args: [FAKE] };
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(onConnectedCalls.length > 0, "onConnected must fire once the retry connects");
  assert.deepEqual(onConnectedCalls.at(-1), ["flaky"]);
  assert.equal(mgr.connections().length, 1);
  await mgr.closeAll();
});

test("an unexpected rejection from a retry's connectOne is caught, not left unhandled (F7)", async () => {
  const { mgr, logs } = manager({ retryBaseMs: 40, retryMaxMs: 40 });
  await mgr.connectAll({ ghost: { command: "definitely-not-a-real-binary-xyz" } });

  // Force the retry's own connectOne to throw, simulating an unexpected
  // failure inside handshake (e.g. child.kill() EPERM) rather than one of
  // connectOne's normal resolve-to-undefined error paths.
  const patched = mgr as unknown as { connectOne: (...args: unknown[]) => Promise<unknown> };
  patched.connectOne = async () => {
    throw new Error("synthetic handshake throw");
  };

  let unhandled: unknown;
  const onUnhandled = (reason: unknown) => { unhandled = reason; };
  process.once("unhandledRejection", onUnhandled);
  await new Promise((r) => setTimeout(r, 250));
  process.removeListener("unhandledRejection", onUnhandled);

  assert.equal(unhandled, undefined, `expected no unhandled rejection, got: ${String(unhandled)}`);
  assert.ok(
    logs.some((l) => /retry attempt failed/.test(l) && /synthetic handshake throw/.test(l)),
    `expected a logged retry failure, got: ${logs.join(" | ")}`,
  );
  await mgr.closeAll();
});

test("closing a connection twice in the same tick does not stack kill timers or exit listeners (F11)", async () => {
  const { mgr, logs } = manager();
  const conns = await mgr.connectAll({
    stubborn3: { command: process.execPath, args: [FAKE], env: { FAKE_IGNORE_SIGTERM: "1" } },
  });
  const pidLine = logs.find((l) => l.includes("PID:"));
  assert.ok(pidLine, `expected the fake server to report its pid, got: ${logs.join(" | ")}`);
  const pid = Number(pidLine.split("PID:")[1]);
  assert.ok(isAlive(pid), `expected pid ${pid} to be alive before close()`);

  const start = Date.now();
  conns[0].close();
  conns[0].close(); // same tick: must not register a second SIGKILL timer / exit listener
  while (isAlive(pid)) {
    assert.ok(Date.now() - start < 2000, `pid ${pid} is still alive ${Date.now() - start}ms after double close()`);
    await new Promise((r) => setTimeout(r, 20));
  }
});

test("two concurrent connectAll calls do not interleave — the second supersedes the first cleanly", async () => {
  const { mgr } = manager();
  const p1 = mgr.connectAll({ a: { command: process.execPath, args: [FAKE] } });
  const p2 = mgr.connectAll({ b: { command: process.execPath, args: [FAKE] } });
  const [r1, r2] = await Promise.all([p1, p2]);

  // Both calls settle successfully (the first is superseded, not aborted),
  // but they must run one after the other — never interleaved.
  assert.equal(r1.length, 1);
  assert.equal(r1[0].name, "a");
  assert.equal(r2.length, 1);
  assert.equal(r2[0].name, "b");

  // The surviving live state must match the second call's defs exactly —
  // not a mix of both, and not zero connections.
  const conns = mgr.connections();
  assert.equal(conns.length, 1, `expected exactly one live connection, got: ${conns.map((c) => c.name).join(", ")}`);
  assert.equal(conns[0].name, "b");

  await mgr.closeAll();
});
