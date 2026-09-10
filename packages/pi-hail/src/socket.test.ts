import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DaemonSocket, resolveSocketPath, type Duplex } from "./socket.ts";
import type { RegisterArgs, RegisterReply } from "./protocol.ts";

/** In-process fake Duplex: captures writes; lets the test push `data` and emit `close`/`error`. */
class FakeDuplex extends EventEmitter implements Duplex {
  writes: string[] = [];
  ended = false;
  write(s: string): void {
    this.writes.push(s);
  }
  end(): void {
    this.ended = true;
  }
  /** test helper: push an inbound chunk */
  push(chunk: string): void {
    this.emit("data", chunk);
  }
}

const REGISTER_ARGS: RegisterArgs = {
  sessionId: "S",
  project: "acceptance",
  work: "first-run",
  dir: "/abs",
  piVersion: "0.85.1",
  extensionVersion: "0.1.0",
};

// Guards: pi must never hang waiting for a daemon; register resolves with the daemon's first reply line.
test("register resolves with the daemon's first reply line", async () => {
  const fake = new FakeDuplex();
  const sock = new DaemonSocket({
    connect: async () => fake,
    onLine: () => {},
    onDown: () => {},
  });
  const p = sock.register(REGISTER_ARGS);
  // let connect() resolve
  await Promise.resolve();
  await Promise.resolve();
  fake.push(
    '{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true,"have":7}}\n',
  );
  const reply = (await p) as RegisterReply;
  assert.ok(reply.ok);
  if (reply.ok) {
    assert.equal(reply.data.have, 7);
  }
  // register wrote a session.register frame
  assert.match(fake.writes[0], /"cmd":"session\.register"/);
});

// Guards: two daemon frames arriving in one chunk are both delivered, in order (phone would otherwise drop events).
test("onLine fires once per NDJSON frame across chunk boundaries", async () => {
  const fake = new FakeDuplex();
  const seen: unknown[] = [];
  const sock = new DaemonSocket({
    connect: async () => fake,
    onLine: (m) => seen.push(m),
    onDown: () => {},
  });
  const p = sock.register(REGISTER_ARGS);
  await Promise.resolve();
  await Promise.resolve();
  // first inbound line resolves register
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await p;
  // now stream frames split across chunk boundaries
  fake.push('{"presence":{"phones":[]}}\n{"prom');
  fake.push('pt":{"text":"hi","from":"p","requestId":"r"}}\n');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0], { presence: { phones: [] } });
  assert.deepEqual(seen[1], { prompt: { text: "hi", from: "p", requestId: "r" } });
});

// Guards: when the daemon dies, the extension stays quiet and does not throw; send() becomes a no-op and onDown fires.
test("socket close makes connected() false, fires onDown, and send() is a silent no-op", async () => {
  const fake = new FakeDuplex();
  let downCalls = 0;
  const sock = new DaemonSocket({
    connect: async () => fake,
    // huge backoff so the reconnect timer never fires during the test
    backoffMs: [3_600_000],
    onLine: () => {},
    onDown: () => {
      downCalls++;
    },
  });
  const p = sock.register(REGISTER_ARGS);
  await Promise.resolve();
  await Promise.resolve();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await p;
  assert.equal(sock.connected(), true);
  fake.emit("close");
  assert.equal(sock.connected(), false);
  assert.equal(downCalls, 1);
  // send() must not throw while disconnected, and must write nothing
  const before = fake.writes.length;
  assert.doesNotThrow(() => sock.send({ turn: "start" }));
  assert.equal(fake.writes.length, before);
  sock.close();
});

// Guards: an async onReconnect that rejects (connect failed) must NOT surface an unhandled rejection that kills pi.
test("async onReconnect that rejects does not leak an unhandled rejection", async () => {
  const fake = new FakeDuplex();
  const sock = new DaemonSocket({
    connect: async () => fake,
    // fire the reconnect timer promptly
    backoffMs: [0],
    onLine: () => {},
    onDown: () => {},
    onReconnect: async () => {
      throw new Error("connect failed");
    },
  });
  const p = sock.register(REGISTER_ARGS);
  await Promise.resolve();
  await Promise.resolve();
  fake.push('{"ok":true,"data":{"hostId":"h","daemonVersion":"0.3.0","accepted":true}}\n');
  await p;

  let leaked: unknown = null;
  const guard = (reason: unknown) => {
    leaked = reason;
  };
  process.once("unhandledRejection", guard);
  try {
    // trigger a reconnect: emit close on the fake duplex
    fake.emit("close");
    // let the [0]ms reconnect timer fire and the rejected onReconnect settle
    await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(leaked, null, "onReconnect rejection must not escape as unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", guard);
    sock.close();
  }
});

// Guards: resolveSocketPath prefers XDG_RUNTIME_DIR then TMPDIR (macOS), matching the CLI's own path (C4).
test("resolveSocketPath honors XDG_RUNTIME_DIR then TMPDIR", () => {
  assert.equal(
    resolveSocketPath({ XDG_RUNTIME_DIR: "/run/user/1", TMPDIR: "/tmp" }),
    "/run/user/1/hail/daemon.sock",
  );
  assert.equal(
    resolveSocketPath({ TMPDIR: "/var/folders/x/" }),
    "/var/folders/x/hail/daemon.sock",
  );
});
