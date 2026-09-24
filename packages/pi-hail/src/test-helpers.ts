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

/** Reusable fake dependency set. Later tasks extend this. */
export function fakeDeps() {
  const send = recorder<[unknown]>();
  const sendUserMessage = recorder<[string]>();
  const setStatus = recorder<[string | undefined]>();
  const notify = recorder<[string, ("info" | "warning" | "error")?]>();
  const holdInput = recorder<[boolean]>();
  const getEntries = (): unknown[] => [];
  const deps: SessionDeps & {
    send: typeof send;
    sendUserMessage: typeof sendUserMessage;
    ui: { setStatus: typeof setStatus; notify: typeof notify; holdInput: typeof holdInput };
    getEntries: typeof getEntries;
  } = {
    send,
    sendUserMessage,
    ui: { setStatus, notify, holdInput },
    getEntries,
  };
  return deps;
}

export function lastSend(deps: ReturnType<typeof fakeDeps>): unknown {
  return deps.send.lastArg?.[0];
}
