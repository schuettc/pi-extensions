// Integration test — pi-hail against the REAL hail daemon binary over the C4
// control socket (plan Task 11, deliverable 6).
//
// Guards the whole point of the lane at the wire level: a pi-hail extension,
// talking to the actual daemon built from hail main, completes the C4
// `session.register` handshake and streams turn/event/exit frames the daemon
// accepts — the same socket a hand-started Mac pi uses to appear on the phone.
//
// WHY THIS IS OPT-IN (skipped by default):
//   The real daemon is a production process. On macOS it stores the host
//   identity in the login Keychain under the FIXED, non-path-scoped service
//   "tools.hail" (internal/platform/secrets_darwin.go) — there is no
//   disposable-keychain override. So booting it on a developer's primary Mac
//   would touch the same Keychain entry the real daemon uses, and a second
//   relay connection under the same host identity collides with a running
//   daemon. This test therefore refuses to run unless HAIL_INTEGRATION=1 is
//   set explicitly, and it must only be set on a host that is NOT already
//   running hail and can use a throwaway login Keychain (a CI runner or a
//   scratch account). It never runs in the default `npm test`.
//
// HOW TO RUN (on a clean host):
//   1. Build the daemon from a hail checkout on main:
//        (cd /path/to/hail && go build -o /tmp/hail ./cmd/hail)
//   2. HAIL_INTEGRATION=1 HAIL_BIN=/tmp/hail \
//        node --test packages/pi-hail/src/integration.test.ts
//
// SCOPE: this exercises the extension->daemon direction (register + frames)
// against the real binary. The phone->extension {prompt} round-trip needs a
// sealed inbound relay frame from a paired peer (a fake relay + registry, as in
// the daemon's own Go tests) — covered here by the unit tests against a fake
// socket, not by this binary-level test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSocket, realConnect } from "./socket.ts";
import { EXTENSION_VERSION } from "./version.ts";
import type { RegisterReply } from "./protocol.ts";

// Resolve the daemon binary and the opt-in gate up front so the skip reason is
// specific.
const hailBin = process.env.HAIL_BIN;
function skipReason(): string | false {
  if (process.env.HAIL_INTEGRATION !== "1") {
    return "set HAIL_INTEGRATION=1 (and HAIL_BIN) to run against the real daemon; see file header for why this is opt-in";
  }
  if (!hailBin || !existsSync(hailBin)) {
    return `HAIL_BIN not set or missing (${hailBin ?? "unset"}); build with: go build -o /tmp/hail ./cmd/hail`;
  }
  return false;
}

async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return pred();
}

test(
  "the real daemon accepts session.register and the turn/event/exit stream (C4)",
  { skip: skipReason() },
  async () => {
    // Fully isolated runtime so the daemon's socket, state and config are
    // throwaway. provider=builtin keeps the daemon from probing `proj`, whose
    // detection ("proj list --json") blocks when a `proj` TUI is on PATH.
    const root = mkdtempSync(join(tmpdir(), "pi-hail-it-"));
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      HOME: join(root, "home"),
    };
    for (const d of ["run", "state", "home", "config/hail"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    writeFileSync(join(root, "config/hail/config.toml"), 'provider = "builtin"\n');

    const sockPath = join(root, "run", "hail", "daemon.sock");
    const logPath = join(root, "daemon.log");
    let daemon: ChildProcess | undefined;
    let socket: DaemonSocket | undefined;

    try {
      const logFd = openSync(logPath, "a");
      daemon = spawn(hailBin as string, ["daemon"], { env, stdio: ["ignore", logFd, logFd] });

      const up = await waitFor(() => existsSync(sockPath), 15000);
      assert.ok(
        up,
        `daemon socket never appeared at ${sockPath} within 15s. daemon log:\n${safeRead(logPath)}`,
      );

      // Register through the extension's own socket client, exactly as the
      // extension does at session_start.
      const inbound: unknown[] = [];
      socket = new DaemonSocket({
        connect: realConnect,
        path: sockPath,
        onLine: (msg) => inbound.push(msg),
        onDown: () => {},
      });

      const reply: RegisterReply = await socket.register({
        sessionId: "it-session-1",
        project: "acceptance",
        work: "first-run",
        dir: root,
        piVersion: "0.85.1",
        extensionVersion: EXTENSION_VERSION,
      });

      assert.equal(reply.ok, true, `register rejected: ${JSON.stringify(reply)}`);
      if (reply.ok) {
        assert.equal(reply.data.accepted, true);
        assert.equal(typeof reply.data.daemonVersion, "string");
        assert.notEqual(reply.data.daemonVersion, "");
      }

      // Stream the extension->daemon frames. The daemon accepts them silently
      // (no reply is expected); success is that the long-lived connection stays
      // healthy and the process keeps running.
      socket.send({ turn: "start" });
      socket.send({ event: { type: "message_start", message: { role: "assistant" } } });
      socket.send({ turn: "end" });
      await new Promise((r) => setTimeout(r, 300));

      assert.ok(socket.connected(), "socket dropped after streaming turn/event frames");
      assert.ok(daemon.pid && isAlive(daemon.pid), "daemon exited while streaming frames");

      // A clean exit frame closes the session from the extension side.
      socket.send({ exit: { code: 0 } });
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      socket?.close();
      if (daemon) {
        daemon.kill("SIGTERM");
        await new Promise((r) => setTimeout(r, 300));
        if (daemon.pid && isAlive(daemon.pid)) daemon.kill("SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "(no log)";
  }
}
