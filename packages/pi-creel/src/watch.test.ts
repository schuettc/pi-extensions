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
// watchDeps models a file that is ABSENT until a save creates it: eventMtimeMs
// throws while `present` is false (statSync's real behavior on a missing file),
// so the startup mtime-seed only kicks in when the file already exists. `fire`
// marks the file present (a save wrote it) before invoking the watch callback,
// mirroring reality. Pass presentAtStartup:true to simulate a stale file left
// by a prior session.
function watchDeps(
  overrides: Partial<Deps> = {},
  opts: { presentAtStartup?: boolean; mtime?: number } = {},
) {
  let cb: ((e: string, f: string | null) => void) | undefined;
  let closed = false;
  let watchedDir: string | undefined;
  const mkdirCalls: string[] = [];
  let present = opts.presentAtStartup ?? false;
  let mt = opts.mtime ?? 1000;
  const deps: Deps = {
    resolveTmux: () => ({ socket: "s", pane: "%1" }),
    resolveSessionId: () => "$3",
    homedir: () => "/home/u",
    mkdir: (d) => {
      mkdirCalls.push(d);
    },
    watch: (dir, c) => {
      watchedDir = dir;
      cb = c;
      return { close() { closed = true; } } as WatchHandle;
    },
    readEventFile: () => '{"name":"STRIPE_KEY","dest":".env","action":"added"}',
    eventMtimeMs: () => {
      if (!present) throw new Error("ENOENT");
      return mt;
    },
    ...overrides,
  };
  return {
    deps,
    fire: (file: string | null = "$3.json") => {
      present = true;
      cb?.("change", file);
    },
    setMtime: (v: number) => {
      mt = v;
    },
    isClosed: () => closed,
    watchedDir: () => watchedDir,
    mkdirCalls: () => mkdirCalls,
  };
}

test("watches (and creates) a socket-scoped events dir, not the shared root", () => {
  // session ids (`$0`, `$1`...) are unique only within one tmux server, so the
  // routing key must include the socket name or a save on one socket wakes a
  // same-id session on another. The watcher scopes to <root>/<socket>.
  const { pi } = fakePi();
  const { deps, watchedDir, mkdirCalls } = watchDeps();
  startCreelWatch(pi, deps);
  assert.equal(watchedDir(), "/home/u/.pi/agent/creel-events/s");
  assert.ok(mkdirCalls().includes("/home/u/.pi/agent/creel-events/s"));
});

test("a pre-existing stale event file does not fire on the first spurious event", () => {
  // If this session's file already exists at startup (a prior save at the same
  // sid), a stray dir event (macOS can deliver a null filename) must not
  // re-deliver the old note. Seeding lastMtimeMs from the file at startup guards
  // this: an unchanged mtime is skipped.
  const { pi, sent } = fakePi();
  const { deps, fire } = watchDeps({}, { presentAtStartup: true, mtime: 1000 });
  startCreelWatch(pi, deps);
  fire(null); // null filename falls through the name filter; mtime is unchanged
  assert.equal(sent.length, 0);
});

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
  const { deps, fire, setMtime } = watchDeps();
  startCreelWatch(pi, deps);
  fire();
  fire(); // double-fire of one write -> same mtime -> skipped
  assert.equal(sent.length, 1);
  setMtime(2000); // a genuinely new save
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
