import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { MaskedInput, promptSecret } from "./masked-input.ts";

function harness() {
  const submitted: string[] = [];
  let cancelled = 0;
  let renders = 0;
  const input = new MaskedInput({
    title: "Paste your TypeSafe API key",
    onSubmit: (v) => submitted.push(v),
    onCancel: () => { cancelled += 1; },
    requestRender: () => { renders += 1; },
  });
  return {
    input,
    submitted,
    get cancelled() { return cancelled; },
    get renders() { return renders; },
    masked: () => input.render(80)[1]!,
  };
}

test("typed characters are submitted but never rendered", () => {
  const h = harness();
  const value = "ts_abc";
  const outputs: string[] = [];
  for (const ch of value) {
    h.input.handleInput(ch);
    outputs.push(h.input.render(80).join("\n"));
  }
  const joined = outputs.join("\n");
  assert.ok(!joined.includes(value));
  assert.ok(outputs.at(-1)!.includes("••••••"));
  // The title/hint are fixed text; the masked line itself must hold only the prompt and bullets.
  assert.equal(h.masked(), "> ••••••");
  for (const out of outputs) {
    const masked = out.split("\n")[1]!;
    for (const ch of value) assert.ok(!masked.includes(ch), `masked line leaked ${ch}`);
  }
  assert.equal(h.renders, value.length);

  h.input.handleInput("\r");
  assert.deepEqual(h.submitted, ["ts_abc"]);
});

test("bracketed paste appends the pasted text without rendering it", () => {
  const h = harness();
  h.input.handleInput("\x1b[200~ts_pasted123\n\x1b[201~");
  const out = h.input.render(80).join("\n");
  assert.ok(!out.includes("ts_pasted123"));
  assert.equal(h.masked(), `> ${"•".repeat(12)}`);
  h.input.handleInput("\r");
  assert.deepEqual(h.submitted, ["ts_pasted123"]);
});

test("bracketed paste without an end marker takes everything after the start", () => {
  const h = harness();
  h.input.handleInput("\x1b[200~abc\r\n");
  h.input.handleInput("\r");
  assert.deepEqual(h.submitted, ["abc"]);
});

test("backspace, ctrl+u, arrow keys and escape", () => {
  const h = harness();
  for (const ch of "abcd") h.input.handleInput(ch);
  h.input.handleInput("\x7f");
  assert.equal(h.masked(), "> •••");

  h.input.handleInput("\x1b[A");
  assert.equal(h.masked(), "> •••");

  h.input.handleInput("\x15");
  assert.equal(h.masked(), "> ");

  h.input.handleInput("xy");
  h.input.handleInput("\x1b");
  assert.equal(h.cancelled, 1);
  assert.deepEqual(h.submitted, []);
});

test("ctrl+c cancels", () => {
  const h = harness();
  h.input.handleInput("a");
  h.input.handleInput("\x03");
  assert.equal(h.cancelled, 1);
});

test("render never exceeds the given width", () => {
  const h = harness();
  h.input.handleInput(`\x1b[200~${"k".repeat(50)}\x1b[201~`);
  const lines = h.input.render(10);
  assert.equal(lines.length, 3);
  for (const line of lines) assert.ok(visibleWidth(line) <= 10, `line too wide: ${JSON.stringify(line)}`);
  assert.ok(!lines[1]!.includes("k"));
});

type NotifyType = Parameters<ExtensionUIContext["notify"]>[1];
type CustomFactory = Parameters<ExtensionUIContext["custom"]>[0];

function fakeCtx(hasUI: boolean) {
  const notes: { message: string; type: NotifyType }[] = [];
  const factories: CustomFactory[] = [];
  const ui: Pick<ExtensionUIContext, "notify" | "custom"> = {
    notify: (message, type) => { notes.push({ message, type }); },
    custom: <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
      factories.push(factory);
      return Promise.resolve(undefined as T);
    },
  };
  const ctx = { hasUI, ui } as unknown as ExtensionCommandContext;
  return { ctx, notes, factories };
}

async function mount(factory: CustomFactory) {
  const results: unknown[] = [];
  let renders = 0;
  const tui = { requestRender: () => { renders += 1; } } as unknown as Parameters<CustomFactory>[0];
  const component: Component = await factory(
    tui,
    {} as Parameters<CustomFactory>[1],
    {} as Parameters<CustomFactory>[2],
    (r) => { results.push(r); },
  );
  return { component, results, get renders() { return renders; } };
}

test("promptSecret without a UI warns and returns undefined", async () => {
  const f = fakeCtx(false);
  assert.equal(await promptSecret(f.ctx, "Paste your TypeSafe API key"), undefined);
  assert.equal(f.notes.length, 1);
  assert.equal(f.notes[0]!.type, "warning");
  assert.equal(f.factories.length, 0);
});

test("promptSecret with a UI mounts a masked input that submits on enter", async () => {
  const f = fakeCtx(true);
  await promptSecret(f.ctx, "Paste your TypeSafe API key");
  assert.equal(f.factories.length, 1);
  const m = await mount(f.factories[0]!);
  m.component.handleInput!("a");
  m.component.handleInput!("b");
  assert.equal(m.renders, 2);
  m.component.handleInput!("\r");
  assert.deepEqual(m.results, ["ab"]);
});

test("promptSecret with a UI resolves undefined on escape", async () => {
  const f = fakeCtx(true);
  await promptSecret(f.ctx, "Paste your TypeSafe API key");
  const m = await mount(f.factories[0]!);
  m.component.handleInput!("x");
  m.component.handleInput!("\x1b");
  assert.deepEqual(m.results, [undefined]);
});
