import { test } from "node:test";
import assert from "node:assert/strict";
import { Session } from "./session.ts";
import type { SessionDeps } from "./session.ts";
import { EXTENSION_VERSION } from "./version.ts";

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
  const readSessionEvents = (_sinceSeq: number): unknown[] => [];
  const deps: SessionDeps & {
    send: typeof send;
    sendUserMessage: typeof sendUserMessage;
    ui: { setStatus: typeof setStatus; notify: typeof notify; holdInput: typeof holdInput };
  } = {
    send,
    sendUserMessage,
    ui: { setStatus, notify, holdInput },
    readSessionEvents,
  };
  return deps;
}

export function lastSend(deps: ReturnType<typeof fakeDeps>): unknown {
  return deps.send.lastArg?.[0];
}

// Guards: the phone never sees a session it can't identify — register must carry id, project, work, dir, and both versions.
test("buildRegisterArgs stamps extensionVersion and passes identity through", () => {
  const s = new Session(fakeDeps());
  const args = s.buildRegisterArgs({
    sessionId: "S",
    project: "acceptance",
    work: "first-run",
    dir: "/abs",
    piVersion: "0.85.1",
  });
  assert.deepEqual(args, {
    sessionId: "S",
    project: "acceptance",
    work: "first-run",
    dir: "/abs",
    piVersion: "0.85.1",
    extensionVersion: EXTENSION_VERSION,
  });
});

// Guards: every pi event reaches the phone verbatim, wrapped as { event }.
test("forwardEvent wraps the pi event verbatim", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  const evt = { type: "message_start", id: "m1" };
  s.forwardEvent(evt);
  assert.deepEqual(lastSend(deps), { event: evt });
});

// Guards: turn boundaries the phone needs to gate its composer.
test("turnStart/turnEnd emit { turn:'start' } and { turn:'end' }", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.turnStart();
  assert.deepEqual(lastSend(deps), { turn: "start" });
  s.turnEnd();
  assert.deepEqual(lastSend(deps), { turn: "end" });
});

// Guards: a clean pi exit tells the phone the session is gone.
test("exit emits { exit:{code} }", () => {
  const deps = fakeDeps();
  const s = new Session(deps);
  s.exit(0);
  assert.deepEqual(lastSend(deps), { exit: { code: 0 } });
});
