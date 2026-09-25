// DaemonSocket: one long-lived NDJSON connection per pi process to the daemon's
// Unix control socket (C4). Owns framing, the register round-trip, and
// reconnect-with-backoff. It NEVER blocks pi: a missing/slow daemon must resolve
// to "not connected", never throw synchronously or leave an unhandled rejection.

import { createConnection } from "node:net";
import {
  encodeLine,
  splitFrames,
  decodeLine,
  type RegisterArgs,
  type RegisterReply,
} from "./protocol.ts";

/** Minimal duplex surface the socket needs; the real one wraps node:net. */
export interface Duplex {
  /** Returns false when the write buffer is over the stream's highWaterMark. */
  write(s: string): boolean;
  on(ev: "data", cb: (chunk: string) => void): void;
  on(ev: "close" | "error" | "drain", cb: () => void): void;
  end(): void;
  /** Bytes currently buffered (node:net exposes this). Optional for fakes. */
  writableLength?: number;
  /** True once the buffer is over the highWaterMark (node:net). Optional. */
  writableNeedDrain?: boolean;
}

/**
 * Backpressure high-water mark for PROGRESS frames (muster #502): while the
 * write buffer is above this, the Session holds the newest progress frame
 * instead of piling deltas into an unbounded Node buffer. Boundary frames ignore
 * this and are always written.
 */
export const PROGRESS_HIGH_WATER = 1_000_000;

export type Connect = (path: string) => Promise<Duplex>;

/**
 * Resolve the daemon socket path (C4): `$XDG_RUNTIME_DIR/hail/daemon.sock`,
 * else `$TMPDIR/hail/daemon.sock` (macOS fallback).
 */
export function resolveSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR || env.TMPDIR || "/tmp";
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/hail/daemon.sock`;
}

/** The real connect: wrap node:net.createConnection adapted to Duplex. */
export const realConnect: Connect = (path: string) =>
  new Promise<Duplex>((resolve, reject) => {
    const conn = createConnection({ path });
    conn.setEncoding("utf8");
    const onError = (err: Error) => {
      conn.removeListener("connect", onConnect);
      reject(err);
    };
    const onConnect = () => {
      conn.removeListener("error", onError);
      const duplex: Duplex = {
        write: (s: string) => conn.write(s),
        on: (ev: "data" | "close" | "error" | "drain", cb: (...a: never[]) => void) => {
          conn.on(ev, cb as (...a: unknown[]) => void);
        },
        end: () => conn.end(),
        get writableLength() {
          return conn.writableLength;
        },
        get writableNeedDrain() {
          return conn.writableNeedDrain;
        },
      };
      resolve(duplex);
    };
    conn.once("error", onError);
    conn.once("connect", onConnect);
  });

interface Deps {
  connect: Connect;
  path?: string;
  backoffMs?: number[];
  onLine: (msg: unknown) => void;
  onDown: () => void;
  /** The socket owns reconnect scheduling but delegates re-registration here. */
  onReconnect?: () => void | Promise<void>;
}

const DEFAULT_BACKOFF = [500, 1000, 2000, 5000, 10000];

export class DaemonSocket {
  private readonly connect: Connect;
  private readonly path: string;
  private readonly backoffMs: number[];
  private readonly onLine: (msg: unknown) => void;
  private readonly onDown: () => void;
  private readonly onReconnect?: () => void | Promise<void>;

  private duplex: Duplex | null = null;
  private buffer = "";
  private isConnected = false;
  /** Set when write() reported the buffer full; cleared on the next 'drain'. */
  private overHighWater = false;
  /** Session-registered retries, invoked when the duplex drains. */
  private readonly drainListeners: (() => void)[] = [];
  private closed = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolver for the pending register() call, cleared on first reply. */
  private pendingRegister: ((reply: RegisterReply) => void) | null = null;

  constructor(deps: Deps) {
    this.connect = deps.connect;
    this.path = deps.path ?? resolveSocketPath();
    this.backoffMs = deps.backoffMs ?? DEFAULT_BACKOFF;
    this.onLine = deps.onLine;
    this.onDown = deps.onDown;
    this.onReconnect = deps.onReconnect;
  }

  /**
   * Connect, send the register frame, and resolve on the daemon's first reply
   * line. Rejects if connect fails (and schedules a retry).
   */
  async register(args: RegisterArgs): Promise<RegisterReply> {
    if (this.closed) {
      throw new Error("DaemonSocket: closed");
    }
    let duplex: Duplex;
    try {
      duplex = await this.connect(this.path);
    } catch (err) {
      // Connect failure must never leave pi hanging: reject register and retry.
      this.scheduleReconnect();
      throw err instanceof Error ? err : new Error(String(err));
    }
    // close() may have been called while connect() was in flight.
    if (this.closed) {
      duplex.end();
      throw new Error("DaemonSocket: closed");
    }
    this.duplex = duplex;
    this.buffer = "";
    this.isConnected = true;
    this.attempt = 0;

    const replyPromise = new Promise<RegisterReply>((resolve) => {
      this.pendingRegister = resolve;
    });

    duplex.on("data", (chunk: string) => this.onData(chunk));
    duplex.on("close", () => this.onDisconnect());
    duplex.on("error", () => this.onDisconnect());
    duplex.on("drain", () => this.onDrainEvent());
    this.overHighWater = false;

    // Best-effort write of the register frame.
    try {
      duplex.write(encodeLine({ cmd: "session.register", args }));
    } catch {
      // A dead socket surfaces via close/error; do not throw into the caller.
    }

    return replyPromise;
  }

  /** Best-effort send; a silent no-op while disconnected. Tracks write()'s
   *  return so canSendProgress() can gate progress when the buffer fills. */
  send(obj: unknown): void {
    if (!this.isConnected || !this.duplex) return;
    try {
      const ok = this.duplex.write(encodeLine(obj));
      if (ok === false) this.overHighWater = true;
    } catch {
      // never throw into pi
    }
  }

  connected(): boolean {
    return this.isConnected;
  }

  /**
   * Whether a PROGRESS frame may be written now (muster #502). False while
   * disconnected, while write() last reported the buffer full (until 'drain'),
   * or while the buffered byte count is over PROGRESS_HIGH_WATER. Boundary frames
   * do NOT consult this \u2014 they are always written via send().
   */
  canSendProgress(): boolean {
    if (!this.isConnected || !this.duplex) return false;
    if (this.overHighWater) return false;
    if (this.duplex.writableNeedDrain) return false;
    if ((this.duplex.writableLength ?? 0) > PROGRESS_HIGH_WATER) return false;
    return true;
  }

  /** Register a callback invoked whenever the duplex drains (the Session uses
   *  this to retry a held progress flush). */
  onDrain(cb: () => void): void {
    this.drainListeners.push(cb);
  }

  private onDrainEvent(): void {
    this.overHighWater = false;
    for (const cb of this.drainListeners) {
      try {
        cb();
      } catch {
        // never throw into pi
      }
    }
  }

  /** Schedule a reconnect with backoff; caller re-registers via onReconnect. */
  reconnect(): void {
    this.scheduleReconnect();
  }

  close(): void {
    this.closed = true;
    this.isConnected = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.duplex) {
      try {
        this.duplex.end();
      } catch {
        // ignore
      }
      this.duplex = null;
    }
    this.pendingRegister = null;
    // Drop backpressure state so nothing lingers after shutdown.
    this.overHighWater = false;
    this.drainListeners.length = 0;
  }

  private onData(chunk: string): void {
    try {
      this.buffer += chunk;
      const { lines, rest } = splitFrames(this.buffer);
      this.buffer = rest;
      for (const line of lines) {
        // The first inbound line after register is the reply, not a stream frame.
        if (this.pendingRegister) {
          const resolve = this.pendingRegister;
          this.pendingRegister = null;
          try {
            resolve(decodeLine(line) as RegisterReply);
          } catch {
            // malformed reply is dropped, not fatal
          }
          continue;
        }
        // Each frame wrapped so a malformed line is dropped, not fatal.
        try {
          this.onLine(decodeLine(line));
        } catch {
          // drop malformed line
        }
      }
    } catch {
      // never throw into pi
    }
  }

  private onDisconnect(): void {
    if (this.closed) return;
    const wasConnected = this.isConnected;
    this.isConnected = false;
    this.duplex = null;
    // Reset backpressure state for the next connection: the dead duplex's
    // buffer is gone, and its drain listeners must not fire against a new one.
    // The Session re-arms its retry (onTransportDown) after it reconnects.
    this.overHighWater = false;
    this.drainListeners.length = 0;
    if (wasConnected) {
      try {
        this.onDown();
      } catch {
        // never throw into pi
      }
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return;
    const idx = Math.min(this.attempt, this.backoffMs.length - 1);
    const delay = this.backoffMs[idx];
    this.attempt++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      // The session knows the register args + replay cursor; delegate to it.
      if (this.onReconnect) {
        // A sync try/catch cannot catch a rejected promise from an async
        // callback, so bridge through Promise.resolve().
        Promise.resolve(this.onReconnect()).catch(() => {
          // connect failure already re-schedules via register()
        });
      }
    }, delay);
    // Don't keep the event loop alive on our account.
    if (typeof this.reconnectTimer === "object" && this.reconnectTimer && "unref" in this.reconnectTimer) {
      (this.reconnectTimer as { unref: () => void }).unref();
    }
  }
}
