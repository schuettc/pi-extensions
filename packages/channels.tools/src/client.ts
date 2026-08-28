import type { Readable, Writable } from "node:stream";

type NotificationHandler = (method: string, params: unknown) => void;
type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: NodeJS.Timeout;
  // Removes the abort listener registered for this request, if any. Called
  // on every settlement path (response, timeout, close) so an aborted-later
  // signal never fires into a request that already finished.
  cleanup?: () => void;
};

const DEFAULT_TIMEOUT_MS = 30_000;

export class JsonRpcClient {
  private streams: { stdin: Writable; stdout: Readable };
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handlers: NotificationHandler[] = [];
  private buffer = "";
  private closed = false;

  constructor(streams: { stdin: Writable; stdout: Readable }) {
    this.streams = streams;
    this.streams.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let nl = this.buffer.indexOf("\n");
    while (nl >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line !== "") this.dispatch(line);
      nl = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A server that writes a stray line must not take the channel down.
      return;
    }
    // A JSON-RPC 1.0-flavored notification carries "id": null rather than
    // omitting id entirely. Requiring strict `undefined` here silently drops
    // that shape — a notification is mail, so this is the silent-mail-loss
    // failure class.
    if (typeof msg.method === "string" && (msg.id === undefined || msg.id === null)) {
      for (const h of this.handlers) h(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.cleanup?.();
    const err = msg.error as { message?: string } | undefined;
    if (err) entry.reject(new Error(err.message ?? "JSON-RPC error"));
    else entry.resolve(msg.result);
  }

  // `signal` threads pi's own abort signal (from `execute(id, params, signal,
  // …)`) through to the pending request so an aborted turn rejects the call
  // immediately instead of waiting out the full timeout with nothing to show
  // for it.
  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("channel client is closed"));
    if (signal?.aborted) return Promise.reject(new Error(`aborted before send: ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.cleanup?.();
        reject(new Error(`timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      let cleanup: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          clearTimeout(timer);
          reject(new Error(`aborted: ${method}`));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
      }

      this.pending.set(id, { resolve, reject, timer, ...(cleanup ? { cleanup } : {}) });
      this.write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.write({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  onNotification(handler: NotificationHandler): void {
    this.handlers.push(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.reject(new Error("channel client is closed"));
    }
    this.pending.clear();
  }

  private write(msg: unknown): void {
    this.streams.stdin.write(JSON.stringify(msg) + "\n");
  }
}
