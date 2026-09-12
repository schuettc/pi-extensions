import { test } from "node:test";
import assert from "node:assert/strict";

import { startCreelWatch, type Deps, type WatchHandle } from "./index.ts";

type Sent = { content: any; opts: any };

function fakePi() {
  const sent: Sent[] = [];
  const handlers: Record<string, (...a: any[]) => void> = {};
  const pi = {
    on(evt: string, cb: (...a: any[]) => void) {
      handlers[evt] = cb;
    },
    sendMessage(content: any, opts: any) {
      sent.push({ content, opts });
    },
    appendEntry() {},
  };
  return { pi, sent, handlers };
}

// watchDeps wires a fully-injected Deps: no real fs, no real tmux. `fire`
// invokes the captured watch callback for this session's file; `closeFake`
// reports whether the handle was closed.
function watchDeps(overrides: Partial<Deps> = {}) {
  let cb: ((e: string, f: string | null) => void) | undefined;
  let closed = false;
  const deps: Deps = {
    resolveTmux: () => ({ socket: "s", pane: "%1" }),
    resolveSessionId: () => "$3",
    homedir: () => "/home/u",
    mkdir: () => {},
    watch: (_dir, c) => {
      cb = c;
      return { close() { closed = true; } } as WatchHandle;
    },
    readEventFile: () => '{"name":"STRIPE_KEY","dest":".env","action":"added"}',
    eventMtimeMs: () => 1000,
    ...overrides,
  };
  return {
    deps,
    fire: (file: string | null = "$3.json") => cb?.("change", file),
    isClosed: () => closed,
  };
}

test("delivers a value-free note on a new event, queued after the turn", () => {
  const { pi, sent } = fakePi();
  const { deps, fire } = watchDeps();
  startCreelWatch(pi, deps);
  fire();
  assert.equal(sent.length, 1);
  assert.match(sent[0].content.content, /STRIPE_KEY/);
  assert.equal(sent[0].content.customType, "creel_saved");
  assert.equal(sent[0].opts.triggerTurn, true);
  assert.equal(sent[0].opts.deliverAs, "followUp"); // no ctx captured -> not idle
});

test("an idle session steers a fresh turn", () => {
  const { pi, sent, handlers } = fakePi();
  const { deps, fire } = watchDeps();
  startCreelWatch(pi, deps);
  handlers.session_start?.(null, { isIdle: () => true });
  fire();
  assert.equal(sent[0].opts.deliverAs, "steer");
});

test("the same mtime does not re-notify; a new mtime does", () => {
  const { pi, sent } = fakePi();
  let mt = 1000;
  const { deps, fire } = watchDeps({ eventMtimeMs: () => mt });
  startCreelWatch(pi, deps);
  fire();
  fire(); // double-fire of one write -> same mtime -> skipped
  assert.equal(sent.length, 1);
  mt = 2000; // a genuinely new save
  fire();
  assert.equal(sent.length, 2);
});

test("ignores a change to another session's file", () => {
  const { pi, sent } = fakePi();
  const { deps, fire } = watchDeps();
  startCreelWatch(pi, deps);
  fire("$9.json");
  assert.equal(sent.length, 0);
});

test("is a no-op outside tmux and when the session id cannot resolve", () => {
  const a = fakePi();
  startCreelWatch(a.pi, watchDeps({ resolveTmux: () => undefined }).deps);
  assert.equal(a.sent.length, 0);
  const b = fakePi();
  startCreelWatch(b.pi, watchDeps({ resolveSessionId: () => undefined }).deps);
  assert.equal(b.sent.length, 0);
});

test("ignores a malformed event file", () => {
  const { pi, sent } = fakePi();
  const { deps, fire } = watchDeps({ readEventFile: () => "garbage" });
  startCreelWatch(pi, deps);
  fire();
  assert.equal(sent.length, 0);
});

test("closes the watcher on session shutdown", () => {
  const { pi, handlers } = fakePi();
  const { deps, isClosed } = watchDeps();
  startCreelWatch(pi, deps);
  assert.equal(isClosed(), false);
  handlers.session_shutdown?.();
  assert.equal(isClosed(), true);
});
