import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CredentialStore } from "./credentials.ts";
import { BOX_WIDTH, renderBox, TypeSafePanel, type ConnectionResult, type PanelTheme } from "./panel.ts";

const plain: PanelTheme = { fg: (_color, text) => text, bold: (text) => text };
const KEY = "ts_live_abcdef0123456789";
const ENTER = "\r";
const ESC = "\x1b";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

function tempStore() {
  return new CredentialStore({ dir: join(mkdtempSync(join(tmpdir(), "pi-ts-panel-")), "typesafe") });
}

async function openPanel(opts: { store?: CredentialStore; test?: () => Promise<ConnectionResult> } = {}) {
  const store = opts.store ?? tempStore();
  let closed = false;
  let tests = 0;
  const panel = new TypeSafePanel({
    store,
    model: "jev-latest",
    theme: plain,
    testConnection: opts.test ?? (async () => { tests++; return { ok: true, latencyMs: 212, model: "jev-1.13.0" }; }),
    requestRender: () => {},
    onClose: () => { closed = true; },
  });
  await panel.idle();
  const screen = (width = 100) => panel.render(width).join("\n");
  const press = async (...keys: string[]) => { for (const k of keys) { panel.handleInput(k); await panel.idle(); } };
  return { panel, store, screen, press, isClosed: () => closed, tests: () => tests };
}

test("renderBox draws creel's rounded frame at an exact width", () => {
  for (const width of [120, BOX_WIDTH, 40]) {
    const lines = renderBox({ title: "🔑 typesafe · Jev", body: ["short", "x".repeat(200)], footer: "esc close", width, theme: plain });
    const w = Math.min(BOX_WIDTH, width);
    for (const line of lines) assert.equal(visibleWidth(line), w, `width ${width}: ${JSON.stringify(line)}`);
    assert.ok(lines[0]!.startsWith("╭") && lines[0]!.endsWith("╮"));
    assert.ok(lines.at(-1)!.startsWith("╰") && lines.at(-1)!.endsWith("╯"));
    assert.ok(lines.some((l) => l.includes("🔑 typesafe · Jev")));
    assert.ok(lines.some((l) => l.includes("esc close")));
    // Two columns of padding inside the side borders, like creel.
    assert.ok(lines.find((l) => l.includes("short"))!.startsWith("│  short"));
  }
});

test("the panel lists the four rows with their state", async () => {
  const p = await openPanel();
  const s = p.screen();
  assert.match(s, /API key\s+not set/);
  assert.match(s, /Model\s+jev-latest/);
  assert.match(s, /Test connection\s+not run/);
  assert.match(s, /Remove key/);
  assert.match(s, /↑↓ select · enter change · esc close/);
});

test("setting a key happens inside the box and never renders the key", async () => {
  const p = await openPanel();
  await p.press(ENTER);
  assert.match(p.screen(), /paste your TypeSafe API key/i);
  await p.press(...KEY);
  assert.match(p.screen(), new RegExp("•{" + KEY.length + "}"));
  await p.press(ENTER);
  assert.equal((await p.store.read())?.apiKey, KEY);
  assert.match(p.screen(), /API key\s+configured/);
  assert.doesNotMatch(p.screen(), /abcdef/);
  // Esc in the list closes the panel.
  await p.press(ESC);
  assert.equal(p.isClosed(), true);
});

test("an invalid key is refused with a reason; esc backs out of entry", async () => {
  const p = await openPanel();
  await p.press(ENTER, "a", " ", "b", ENTER);
  assert.match(p.screen(), /✗ .*whitespace/);
  assert.equal(await p.store.read(), undefined);
  await p.press(ESC);
  assert.equal(p.isClosed(), false);
  assert.match(p.screen(), /API key\s+not set/);
});

test("test connection reports latency and the model version Jev reports", async () => {
  const store = tempStore();
  await store.write(KEY);
  const p = await openPanel({ store });
  await p.press(DOWN, DOWN, ENTER);
  assert.equal(p.tests(), 1);
  assert.match(p.screen(), /Test connection\s+ok · 212ms/);
  assert.match(p.screen(), /Model\s+jev-latest → jev-1\.13\.0/);
  const failing = await openPanel({ store, test: async () => ({ ok: false, reason: "HTTP 401 (key rejected)" }) });
  await failing.press(DOWN, DOWN, ENTER);
  assert.match(failing.screen(), /Test connection\s+✗ HTTP 401 \(key rejected\)/);
});

test("remove key asks y/N inside the box", async () => {
  const store = tempStore();
  await store.write(KEY);
  const p = await openPanel({ store });
  await p.press(DOWN, DOWN, DOWN, ENTER);
  assert.match(p.screen(), /delete the stored key\? y\/N/i);
  await p.press("n");
  assert.equal((await store.read())?.apiKey, KEY);
  await p.press(ENTER, "y");
  assert.equal(await store.read(), undefined);
  assert.match(p.screen(), /API key\s+not set/);
});

test("remove key does nothing when no key is stored; navigation wraps within rows", async () => {
  const p = await openPanel();
  await p.press(UP, ENTER); // up from the first row lands on Remove key
  assert.doesNotMatch(p.screen(), /y\/N/);
  assert.match(p.screen(), /no key is stored/i);
});

test("the box keeps one height across rows, messages and modes (no re-centering jump)", async () => {
  const store = tempStore();
  await store.write(KEY);
  const p = await openPanel({ store, test: async () => ({ ok: false, reason: "HTTP 401 (key rejected)" }) });
  const heights = new Set<number>();
  const snap = () => heights.add(p.panel.render(100).length);
  for (let i = 0; i < 4; i++) { snap(); await p.press(DOWN); }
  await p.press(DOWN, DOWN, ENTER); snap();          // test result message
  await p.press(DOWN, ENTER); snap();                // remove confirm
  await p.press("n"); snap();                        // kept message
  await p.press(DOWN, ENTER); snap();                // key entry
  await p.press("a", " ", ENTER); snap();            // key entry + error
  await p.press(ESC); snap();
  assert.equal(heights.size, 1, `heights seen: ${[...heights].join(", ")}`);
});
