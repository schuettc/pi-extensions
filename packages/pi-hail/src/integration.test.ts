// Integration test — pi-hail against the REAL hail daemon binary over the C4
// control socket (plan Task 11, deliverable 6).
//
// Guards the whole point of the lane at the wire level: a pi-hail extension,
// talking to the actual daemon built from hail main, completes the C4
// `session.register` handshake and streams turn/event/exit frames the daemon
// accepts — the same socket a hand-started Mac pi uses to appear on the phone.
//
// WHY THIS IS OPT-IN (skipped by default):
//   The real daemon is a production process: it boots the actual `hail`
//   binary, opens a control socket, and writes a host identity into the macOS
//   login Keychain. So the test refuses to run unless HAIL_INTEGRATION=1 is set
//   explicitly, and it never runs in the default `npm test`.
//
//   It stays off the LIVE keychain identity by using hail's disposable-service
//   override (F22, HAIL_KEYCHAIN_SERVICE): the daemon reads/writes its Keychain
//   items under whatever service that env names, and this test defaults it to
//   "tools.hail.itest" — never the production "tools.hail" — then deletes those
//   items in teardown, leaving the Mac's keychain as it found it. It refuses to
//   run against the live "tools.hail" service outright. XDG_RUNTIME_DIR/
//   XDG_STATE_HOME/XDG_CONFIG_HOME are isolated to a temp dir so the socket,
//   state and config are throwaway; HOME is NOT overridden — on darwin that
//   breaks the `security` CLI's keychain resolution and the daemon dies at
//   startup (F24).
//
// HOW TO RUN (on a clean host):
//   1. Build the daemon from a hail checkout on main (F21 gives the proj-probe
//      a timeout, F22 the keychain-service override):
//        (cd /path/to/hail && go build -o /tmp/hail ./cmd/hail)
//   2. HAIL_INTEGRATION=1 HAIL_BIN=/tmp/hail \
//        [HAIL_KEYCHAIN_SERVICE=tools.hail.itest] \
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
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonSocket, realConnect } from "./socket.ts";
import { EXTENSION_VERSION } from "./version.ts";
import type { RegisterReply } from "./protocol.ts";

// Resolve the daemon binary, the disposable keychain service, and the opt-in
// gate up front so the skip reason is specific.
const hailBin = process.env.HAIL_BIN;
// The daemon writes its host identity under this Keychain service (F22). It
// defaults to a scratch service and is deleted in teardown; it must never be
// the live "tools.hail", which the test refuses outright.
const KEYCHAIN_SERVICE = process.env.HAIL_KEYCHAIN_SERVICE ?? "tools.hail.itest";
function skipReason(): string | false {
  if (process.env.HAIL_INTEGRATION !== "1") {
    return "set HAIL_INTEGRATION=1 (and HAIL_BIN) to run against the real daemon; see file header for why this is opt-in";
  }
  if (!hailBin || !existsSync(hailBin)) {
    return `HAIL_BIN not set or missing (${hailBin ?? "unset"}); build with: go build -o /tmp/hail ./cmd/hail`;
  }
  if (KEYCHAIN_SERVICE === "tools.hail") {
    return "refusing to run against the live 'tools.hail' keychain service; the test writes and DELETES items under HAIL_KEYCHAIN_SERVICE — leave it unset or use a scratch service";
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
    // Isolate the daemon's socket/state/config to a temp dir via XDG. HOME is
    // deliberately NOT overridden: on darwin that breaks the `security` CLI's
    // keychain resolution and the daemon dies at startup (F24). The keychain
    // items are isolated instead by HAIL_KEYCHAIN_SERVICE.
    const root = mkdtempSync(join(tmpdir(), "pi-hail-it-"));
    const env = {
      ...process.env,
      XDG_RUNTIME_DIR: join(root, "run"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_CONFIG_HOME: join(root, "config"),
      HAIL_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
    };
    for (const d of ["run", "state", "config/hail"]) {
      mkdirSync(join(root, d), { recursive: true });
    }
    // provider=builtin keeps the daemon off the `proj` auto-probe. With F21's
    // probe timeout this is no longer required, but it is harmless and keeps
    // the test fast on a host that happens to have a `proj` on PATH.
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
      // An approval ask + its close (spec \u00a7A): the daemon marks the request open
      // with no fail-closed timer, then closes it on askDone. Older daemons that
      // predate these keys ignore them, so the stream stays healthy either way.
      socket.send({
        ask: {
          requestId: "it-ask-1",
          title: "Allow bash?",
          message: "echo hi",
          toolName: "bash",
          surface: "bash",
          value: "echo hi",
        },
      });
      socket.send({ askDone: { requestId: "it-ask-1", outcome: "deferred", by: "mac" } });
      socket.send({ turn: "end" });
      await new Promise((r) => setTimeout(r, 300));

      assert.ok(socket.connected(), "socket dropped after streaming turn/event/ask frames");
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
      // Leave the Mac's keychain as we found it: delete every generic-password
      // item the daemon wrote under our scratch service (identity/host and any
      // sibling entries). Best-effort; the live service is never reached here
      // because skipReason() refuses it.
      cleanupKeychain(KEYCHAIN_SERVICE);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// Delete all generic-password items under `service` from the login keychain.
// Each `security delete-generic-password -s <service>` removes ONE matching
// item and exits non-zero once none remain; loop until it stops (capped so a
// surprising keychain can never spin forever). darwin-only and never invoked
// for the live service (guarded in skipReason).
function cleanupKeychain(service: string): void {
  if (process.platform !== "darwin" || service === "tools.hail") return;
  for (let i = 0; i < 32; i++) {
    const r = spawnSync("security", ["delete-generic-password", "-s", service], {
      stdio: "ignore",
    });
    if (r.status !== 0) break;
  }
}

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
