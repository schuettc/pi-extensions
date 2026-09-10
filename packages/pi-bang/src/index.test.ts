import { test } from "node:test";
import assert from "node:assert/strict";
import { createBang } from "./index.ts";

// A fake pi capturing handlers, commands and sent messages, plus a manual
// timer queue so the macrotask defer is observable and controllable.
function makeFixture(opts: { execExitCode?: number | null; execAborts?: boolean } = {}) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const sent: { message: any; options: any }[] = [];
  const timers: (() => void)[] = [];
  const execCalls: string[] = [];

  const pi = {
    on(event: string, handler: any) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    sendMessage(message: any, options: any) {
      sent.push({ message, options });
    },
  };

  const signal = { aborted: false };
  const fakeOps = {
    async exec(command: string, _cwd: string, _options: any) {
      execCalls.push(command);
      if (opts.execAborts) signal.aborted = true;
      return { exitCode: opts.execExitCode === undefined ? 0 : opts.execExitCode };
    },
  };

  // Fake editor base standing in for pi's CustomEditor: plain text buffer,
  // append-on-input, so the subclass's interception is observable.
  class FakeEditorBase {
    text = "";
    constructor(..._args: any[]) {}
    getText() {
      return this.text;
    }
    setText(t: string) {
      this.text = t;
    }
    handleInput(d: string) {
      this.text += d;
    }
  }

  createBang(pi, {
    createOps: () => fakeOps,
    setTimer: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    loadEditorBase: async () => FakeEditorBase,
  });

  async function startSession(ctx: any) {
    await handlers.get("session_start")!({}, ctx);
  }

  // A fake ctx.ui that accepts an editor replacement, optionally pretending
  // another extension already owns the editor.
  function makeUi(existing?: unknown) {
    let factory: any = existing;
    return {
      setEditorComponent(f: any) {
        factory = f;
      },
      getEditorComponent() {
        return factory;
      },
      makeEditor() {
        return factory({}, {}, {});
      },
    };
  }

  // ctx defaults to undefined so the wiring keeps the ctx captured at
  // session_start (a truthy fake here would overwrite it).
  async function runUserBash(command: string, excludeFromContext: boolean, ctx: any = undefined) {
    const handler = handlers.get("user_bash");
    assert.ok(handler, "user_bash handler registered");
    const result = handler!({ type: "user_bash", command, excludeFromContext, cwd: "/tmp" }, ctx);
    const execResult = await result.operations.exec(command, "/tmp", { signal });
    return execResult;
  }

  function flushTimers() {
    while (timers.length > 0) timers.shift()!();
  }

  return { pi, handlers, commands, sent, timers, execCalls, runUserBash, flushTimers, startSession, makeUi };
}

test("successful ! run defers a nudge, then sends it with triggerTurn", async () => {
  const f = makeFixture({ execExitCode: 0 });
  await f.startSession({ isIdle: () => true });
  await f.runUserBash("git status", false);

  assert.equal(f.sent.length, 0, "nudge must not fire before the timer (entry-ordering)");
  assert.equal(f.timers.length, 1);

  f.flushTimers();
  assert.equal(f.sent.length, 1);
  const { message, options } = f.sent[0]!;
  assert.equal(message.customType, "bang");
  assert.ok(message.content.includes("`git status`"));
  assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
});

test("busy session delivers as followUp", async () => {
  const f = makeFixture({ execExitCode: 0 });
  await f.startSession({ isIdle: () => false });
  await f.runUserBash("ls", false);
  f.flushTimers();
  assert.equal(f.sent[0]!.options.deliverAs, "followUp");
});

test("!! never nudges", async () => {
  const f = makeFixture({ execExitCode: 0 });
  await f.runUserBash("ls", true);
  f.flushTimers();
  assert.equal(f.sent.length, 0);
});

test("aborted command never nudges", async () => {
  const f = makeFixture({ execExitCode: null, execAborts: true });
  await f.runUserBash("sleep 100", false);
  f.flushTimers();
  assert.equal(f.sent.length, 0);
});

test("/bang off silences, /bang on restores", async () => {
  const f = makeFixture({ execExitCode: 0 });
  const cmd = f.commands.get("bang");
  assert.ok(cmd, "/bang registered");

  await cmd!.handler("off", {});
  await f.runUserBash("ls", false);
  f.flushTimers();
  assert.equal(f.sent.length, 0);

  await cmd!.handler("on", {});
  await f.runUserBash("ls", false);
  f.flushTimers();
  assert.equal(f.sent.length, 1);
});

test("exec result passes through unchanged", async () => {
  const f = makeFixture({ execExitCode: 3 });
  const result = await f.runUserBash("false", false);
  assert.deepEqual(result, { exitCode: 3 });
  assert.deepEqual(f.execCalls, ["false"]);
});

test("a throwing sendMessage is contained", async () => {
  const f = makeFixture({ execExitCode: 0 });
  f.pi.sendMessage = () => {
    throw new Error("boom");
  };
  await f.runUserBash("ls", false);
  assert.doesNotThrow(() => f.flushTimers());
});

test("stale ctx.isIdle throw falls back to followUp", async () => {
  const f = makeFixture({ execExitCode: 0 });
  await f.startSession({
    isIdle: () => {
      throw new Error("assertActive: session replaced");
    },
  });
  await f.runUserBash("ls", false);
  f.flushTimers();
  assert.equal(f.sent[0]!.options.deliverAs, "followUp");
});

test("editor: typing ! then a command yields '! cmd', second ! upgrades to '!!'", async () => {
  const f = makeFixture();
  const ui = f.makeUi();
  await f.startSession({ ui });

  const ed = ui.makeEditor();
  ed.handleInput("!");
  assert.equal(ed.getText(), "! ", "auto-space after bang");
  for (const ch of "ls") ed.handleInput(ch);
  assert.equal(ed.getText(), "! ls");

  const ed2 = ui.makeEditor();
  ed2.handleInput("!");
  ed2.handleInput("!");
  assert.equal(ed2.getText(), "!! ", "second bang upgrades");
  for (const ch of "ls") ed2.handleInput(ch);
  assert.equal(ed2.getText(), "!! ls");
});

test("editor: ! mid-text is untouched", async () => {
  const f = makeFixture();
  const ui = f.makeUi();
  await f.startSession({ ui });
  const ed = ui.makeEditor();
  for (const ch of "echo hi") ed.handleInput(ch);
  ed.handleInput("!");
  assert.equal(ed.getText(), "echo hi!");
});

test("editor: not installed when another extension owns the editor", async () => {
  const f = makeFixture();
  const theirs = () => ({ marker: "vim" });
  const ui = f.makeUi(theirs);
  await f.startSession({ ui });
  assert.equal(ui.getEditorComponent(), theirs, "existing editor factory untouched");
});

test("editor: missing ui does not break session start", async () => {
  const f = makeFixture();
  await assert.doesNotReject(f.startSession({}));
});
