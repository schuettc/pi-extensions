// Shared test helpers for pi-hail. NOTE: this file must contain NO `test()`
// registrations — importing it from a test file must not re-run any suite.
// It lives under src/ so `files: ["src", ...]` still ships it, and the package
// test glob (`src/*.test.ts`) does not match `test-helpers.ts`.

import type { SessionDeps } from "./session.ts";

interface Recorder<A extends unknown[]> {
  (...args: A): void;
  calls: A[];
  get lastArg(): A;
}

function recorder<A extends unknown[]>(): Recorder<A> {
  const calls: A[] = [];
  const fn = ((...args: A) => {
    calls.push(args);
  }) as Recorder<A>;
  fn.calls = calls;
  Object.defineProperty(fn, "lastArg", {
    get() {
      return calls[calls.length - 1];
    },
  });
  return fn;
}

/**
 * A controllable fake for ui.openDialog: records [title, options, signal] per
 * call, stays pending until a test calls `resolve(...)` (so "no answer" leaves
 * the promise unsettled), and exposes the last-observed AbortSignal so a test
 * can assert the Session dismissed it.
 */
interface OpenDialogFake {
  (title: string, options: string[], signal: AbortSignal): Promise<string | undefined>;
  calls: [string, string[], AbortSignal][];
  /** Resolve the most recent (still-pending) openDialog call. */
  resolve(value: string | undefined): void;
  /** Reject the most recent (still-pending) openDialog call. */
  reject(err?: unknown): void;
  /** The AbortSignal handed to the most recent call. */
  lastSignal(): AbortSignal | undefined;
}

/**
 * Options to model the ways a real ctx.ui.select can misbehave:
 *  - throwSync: the call itself throws synchronously (before returning a promise);
 *  - rejectOnAbort: the returned promise REJECTS when the signal aborts (pi's
 *    real interactive select RESOLVES undefined instead, but a link must be
 *    robust to either).
 */
export function makeOpenDialogFake(opts: { throwSync?: boolean; rejectOnAbort?: boolean } = {}): OpenDialogFake {
  const calls: [string, string[], AbortSignal][] = [];
  const settlers: { resolve: (v: string | undefined) => void; reject: (e: unknown) => void }[] = [];
  const fn = ((title: string, options: string[], signal: AbortSignal) => {
    calls.push([title, options, signal]);
    if (opts.throwSync) throw new Error("openDialog boom (sync)");
    return new Promise<string | undefined>((resolve, reject) => {
      settlers.push({ resolve, reject });
      if (opts.rejectOnAbort) {
        signal.addEventListener("abort", () => reject(new Error("dialog aborted")), { once: true });
      }
    });
  }) as OpenDialogFake;
  fn.calls = calls;
  fn.resolve = (value) => {
    settlers.shift()?.resolve(value);
  };
  fn.reject = (err) => {
    settlers.shift()?.reject(err ?? new Error("openDialog rejected"));
  };
  fn.lastSignal = () => calls[calls.length - 1]?.[2];
  return fn;
}

function openDialogFake(): OpenDialogFake {
  return makeOpenDialogFake();
}

/** Reusable fake dependency set. Later tasks extend this. */
export function fakeDeps() {
  const send = recorder<[unknown]>();
  const sendUserMessage = recorder<[string]>();
  const setStatus = recorder<[string | undefined]>();
  const notify = recorder<[string, ("info" | "warning" | "error")?]>();
  const holdInput = recorder<[boolean]>();
  const openDialog = openDialogFake();
  const getEntries = (): unknown[] => [];
  const deps: SessionDeps & {
    send: typeof send;
    sendUserMessage: typeof sendUserMessage;
    ui: {
      setStatus: typeof setStatus;
      notify: typeof notify;
      holdInput: typeof holdInput;
      openDialog: typeof openDialog;
    };
    getEntries: typeof getEntries;
  } = {
    send,
    sendUserMessage,
    ui: { setStatus, notify, holdInput, openDialog },
    getEntries,
  };
  return deps;
}

export function lastSend(deps: ReturnType<typeof fakeDeps>): unknown {
  return deps.send.lastArg?.[0];
}
