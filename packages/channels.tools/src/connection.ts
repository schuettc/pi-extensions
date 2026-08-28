import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { JsonRpcClient } from "./client.ts";
import type { ChannelServerDef } from "./config.ts";
import type { ChannelEvent } from "./envelope.ts";

export const CHANNEL_CAPABILITY = "claude/channel";
export const CHANNEL_NOTIFICATION = "notifications/claude/channel";

const PROTOCOL_VERSION = "2025-06-18";
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;
// Some real channel servers ignore SIGTERM outright — only SIGKILL ends
// them. A well-behaved server exits on SIGTERM well inside this
// window, so the escalation almost never fires against it. Deliberately not
// unref'd: elsewhere in this file timers are unref'd so they cannot hold the
// process open, but here that would let Node exit before the SIGKILL is
// delivered, orphaning the very child this timer exists to kill.
const KILL_GRACE_MS = 300;

// Tracks children currently mid-kill so two killChild() calls landing in the
// same tick (e.g. conn.close() followed by closeAll() sweeping `pending`)
// don't each register their own SIGKILL timer and their own `exit` listener.
const killing = new WeakSet<ChildProcess>();

// SIGTERM, then SIGKILL after a short grace period if the child hasn't
// exited on its own. Cleared the moment the child's 'exit' fires, so a
// well-behaved server is never force-killed and a clean shutdown is never
// delayed.
function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (killing.has(child)) return;
  killing.add(child);
  child.kill();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  child.once("exit", () => {
    clearTimeout(timer);
    killing.delete(child);
  });
}

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type Connection = {
  name: string;
  client: JsonRpcClient;
  instructions?: string;
  tools: McpToolDef[];
  close(): void;
};

type ManagerOpts = {
  onEvent: (event: ChannelEvent) => void;
  onStatus: (status: string) => void;
  log: (message: string) => void;
  // Fired after a *retry* connects a server that was not part of the
  // connections array most recently returned by connectAll()/connections().
  // Without this, a channel that reconnects 30s after session_start is live
  // in `this.live` (instructions injected, events waking the agent) but was
  // never handed back to the caller to re-run tool registration — the exact
  // "healthy-looking but deaf channel" failure this component exists to
  // avoid.
  onConnected?: (connections: Connection[]) => void;
  // Test seams only: production always uses the real RETRY_BASE_MS/
  // RETRY_MAX_MS. Overriding lets tests exercise the retry path (including
  // onConnected above) without waiting out a real 30s backoff.
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export class ConnectionManager {
  private live = new Map<string, { conn: Connection; child: ChildProcess }>();
  // Children that have spawned and are mid-handshake, not yet in `live`.
  // closeAll() must kill these directly — they are otherwise invisible to it,
  // which is how a hung handshake used to survive closeAll() as an orphan.
  private pending = new Set<ChildProcess>();
  private retries = new Map<string, { attempts: number; timer?: NodeJS.Timeout }>();
  private defs: Record<string, ChannelServerDef> = {};

  // Bumped by closeAll(). Every connectOne()/retry call captures the
  // generation it started with; if the generation has moved on by the time
  // it would mutate shared state (this.live), it backs out instead of
  // resurrecting a connection the caller believes is torn down.
  private generation = 0;

  // Serializes connectAll() calls. closeAll() has no internal await, so two
  // unawaited connectAll() calls would otherwise both run their `await
  // this.closeAll()` before either resumes, letting the second call's
  // generation bump land underneath the first call's continuation — both
  // then pass the generation check and end up live together. Each
  // connectAll() call chains onto this promise instead of running
  // immediately, so a queued call always starts only after the previous one
  // has fully settled (including its own closeAll()), and captures the
  // generation it will actually run under.
  private queue: Promise<void> = Promise.resolve();

  // Field + body assignment, not a constructor parameter property: Node's
  // strip-only TypeScript rejects those with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  private readonly opts: ManagerOpts;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(opts: ManagerOpts) {
    this.opts = opts;
    this.retryBaseMs = opts.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = opts.retryMaxMs ?? RETRY_MAX_MS;
  }

  // Ordered by the configured server order (spec §4: "connection order for
  // prefix stability"), not by whichever server happened to finish its
  // handshake first — `this.live` is populated inside a `Promise.all`, so
  // insertion order there varies run to run, and the instructions block
  // built from this is a system-prompt prefix. A flipped order costs a full
  // prompt-cache miss.
  connections(): Connection[] {
    const order = Object.keys(this.defs);
    return [...this.live.values()]
      .map((e) => e.conn)
      .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  }

  // Deliberately not `async`: the chaining onto `this.queue` must happen
  // synchronously, before control ever returns to the caller, so that a
  // second connectAll() called back-to-back (no await in between) sees the
  // link this call just made rather than the pre-call queue tail.
  connectAll(defs: Record<string, ChannelServerDef>): Promise<Connection[]> {
    const run = this.queue.then(() => this.runConnectAll(defs));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runConnectAll(defs: Record<string, ChannelServerDef>): Promise<Connection[]> {
    await this.closeAll();
    this.defs = defs;
    const gen = this.generation;
    const results = await Promise.all(
      Object.entries(defs).map(([name, def]) => this.connectOne(name, def, gen)),
    );
    const ok = results.filter((c): c is Connection => c !== undefined);
    this.publishStatus();
    return ok;
  }

  private async connectOne(name: string, def: ChannelServerDef, gen: number): Promise<Connection | undefined> {
    let child: ChildProcess;
    try {
      child = spawn(def.command, def.args ?? [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...(def.env ?? {}) },
        ...(def.cwd ? { cwd: def.cwd } : {}),
      });
    } catch (error) {
      this.opts.log(`channel ${name}: spawn failed: ${String(error)}`);
      this.scheduleRetry(name, gen);
      return undefined;
    }

    // spawn() is async: ENOENT arrives on 'error', not as a throw. Wiring the
    // connection before this resolves turns a missing binary into a silent
    // dead pipe. A failure here is transient-looking (the binary may appear
    // later), so it is retried like any other startup failure.
    const started = await new Promise<boolean>((resolve) => {
      const onSpawn = () => { cleanup(); resolve(true); };
      const onError = (err: Error) => {
        cleanup();
        this.opts.log(`channel ${name}: spawn failed: ${err.message}`);
        resolve(false);
      };
      const cleanup = () => {
        child.removeListener("spawn", onSpawn);
        child.removeListener("error", onError);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });

    if (!started) {
      this.scheduleRetry(name, gen);
      return undefined;
    }
    if (!child.stdin || !child.stdout) {
      killChild(child);
      this.scheduleRetry(name, gen);
      return undefined;
    }
    if (gen !== this.generation) {
      // closeAll() ran while we were waiting on the spawn/error gate.
      killChild(child);
      return undefined;
    }

    this.pending.add(child);
    try {
      return await this.handshake(name, def, gen, child);
    } finally {
      this.pending.delete(child);
    }
  }

  private async handshake(
    name: string,
    def: ChannelServerDef,
    gen: number,
    child: ChildProcess,
  ): Promise<Connection | undefined> {
    // If the child's own pipe is already broken (it died before we got here,
    // or dies mid-write), a write must not surface as an unhandled 'error'
    // event and crash the process — the exit handler below is what reports
    // the death.
    // The handler must stay — an unhandled stream 'error' crashes the
    // process — but it must log. Silently swallowing a *live* pipe error
    // stops delivery with no 'exit' event, so no retry is scheduled and
    // publishStatus() keeps reporting healthy: mail is then lost silently
    // and indefinitely with zero evidence.
    child.stdin?.on("error", (err) => this.opts.log(`channel ${name}: stdin error: ${String(err)}`));
    child.stdout?.on("error", (err) => this.opts.log(`channel ${name}: stdout error: ${String(err)}`));

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8").trim();
      if (text !== "") this.opts.log(`channel ${name} stderr: ${text}`);
    });

    const client = new JsonRpcClient({ stdin: child.stdin!, stdout: child.stdout! });

    // Registered BEFORE the handshake requests: a child that dies mid-
    // handshake must not fire 'exit' into a void (a listener installed only
    // after `initialize` resolves would miss it entirely, leaving a dead
    // child silently inserted into `live` as if it were healthy). Closing
    // the client here makes the in-flight request reject immediately
    // instead of waiting out JsonRpcClient's 30s timeout.
    let handshakeDone = false;
    child.once("exit", (code) => {
      const entry = this.live.get(name);
      if (entry && entry.child === child) {
        this.live.delete(name);
        this.opts.log(`channel ${name}: exited (code ${code ?? "null"})`);
        this.publishStatus();
        this.scheduleRetry(name, gen);
        return;
      }
      if (!handshakeDone) {
        this.opts.log(`channel ${name}: exited during handshake (code ${code ?? "null"})`);
        client.close();
      }
    });

    let result: Record<string, unknown>;
    try {
      result = (await client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "channels.tools", version: "0.1.0" },
      })) as Record<string, unknown>;
    } catch (error) {
      this.opts.log(`channel ${name}: initialize failed: ${String(error)}`);
      handshakeDone = true;
      client.close();
      killChild(child);
      this.scheduleRetry(name, gen);
      return undefined;
    }

    if (gen !== this.generation) {
      handshakeDone = true;
      client.close();
      killChild(child);
      return undefined;
    }

    const capabilities = (result.capabilities ?? {}) as { experimental?: Record<string, unknown> };
    if (!capabilities.experimental || !(CHANNEL_CAPABILITY in capabilities.experimental)) {
      this.opts.log(`channel ${name}: rejected — no ${CHANNEL_CAPABILITY} capability declared`);
      handshakeDone = true;
      client.close();
      killChild(child);
      // Permanent incompatibility, not a transient fault: never retried.
      return undefined;
    }

    client.notify("notifications/initialized");

    let tools: McpToolDef[] = [];
    try {
      const listed = (await client.request("tools/list", {})) as { tools?: McpToolDef[] };
      tools = listed.tools ?? [];
    } catch (error) {
      this.opts.log(`channel ${name}: tools/list failed: ${String(error)}`);
    }

    handshakeDone = true;

    if (gen !== this.generation) {
      client.close();
      killChild(child);
      return undefined;
    }

    client.onNotification((method, params) => {
      if (method !== CHANNEL_NOTIFICATION) return;
      const p = (params ?? {}) as { content?: unknown; meta?: unknown };
      const meta: Record<string, string> = {};
      if (typeof p.meta === "object" && p.meta !== null) {
        for (const [k, v] of Object.entries(p.meta as Record<string, unknown>)) {
          if (v !== undefined && v !== null) meta[k] = String(v);
        }
      }
      this.opts.onEvent({ source: name, content: String(p.content ?? ""), meta });
    });

    const conn: Connection = {
      name,
      client,
      ...(typeof result.instructions === "string" ? { instructions: result.instructions } : {}),
      tools,
      close: () => { client.close(); killChild(child); },
    };

    this.live.set(name, { conn, child });
    this.retries.delete(name);
    return conn;
  }

  private scheduleRetry(name: string, gen: number): void {
    if (gen !== this.generation) return;
    const def = this.defs[name];
    if (!def) return;
    const state = this.retries.get(name) ?? { attempts: 0 };
    state.attempts += 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (state.attempts - 1), this.retryMaxMs);
    this.opts.log(`channel ${name}: retrying in ${Math.round(delay / 1000)}s (attempt ${state.attempts})`);
    const timer = setTimeout(() => {
      if (gen !== this.generation) return;
      this.connectOne(name, def, gen)
        .then((conn) => {
          if (!conn || gen !== this.generation) return;
          this.publishStatus();
          // The caller (index.ts) is not otherwise notified that a
          // previously-failed channel just came up: its instructions and
          // events are now live via `this.live`, but the tool layer never
          // heard about it without this callback.
          this.opts.onConnected?.(this.connections());
        })
        .catch((error) => {
          // connectOne's own error paths all resolve rather than reject;
          // this only catches an unexpected throw (e.g. inside handshake).
          // Without a rejection handler here, that throw becomes an
          // unhandled rejection and exits the process under Node's default.
          this.opts.log(`channel ${name}: retry attempt failed: ${String(error)}`);
        });
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    state.timer = timer;
    this.retries.set(name, state);
  }

  private publishStatus(): void {
    const configured = Object.keys(this.defs).length;
    const up = this.live.size;
    if (configured === 0) { this.opts.onStatus(""); return; }
    // A dead channel loses mail silently, so degraded state must be visible.
    this.opts.onStatus(up === configured ? `channels ${up}/${configured}` : `channels ${up}/${configured} DEGRADED`);
  }

  async closeAll(): Promise<void> {
    this.generation++;
    for (const [, state] of this.retries) if (state.timer) clearTimeout(state.timer);
    this.retries.clear();
    for (const [, entry] of this.live) entry.conn.close();
    this.live.clear();
    // Kill anything still mid-handshake too — otherwise a hung handshake
    // outlives closeAll() as an orphan process.
    for (const child of this.pending) killChild(child);
    this.pending.clear();
    this.defs = {};
    this.opts.onStatus("");
  }
}
