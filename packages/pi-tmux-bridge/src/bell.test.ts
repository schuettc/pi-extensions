import { test } from "node:test";
import assert from "node:assert/strict";
import { ringBell, raiseAttention, raisePermissionAttention, clearPermissionAttention } from "./bell.ts";

const ctx = { socket: "proj-pi", pane: "%47" };
const BEL = String.fromCharCode(7);

test("the bell is a BEL byte appended to the pane's own tty", () => {
  const writes: Array<{ path: string; data: string }> = [];
  ringBell(ctx, { tty: () => "/dev/ttys004", append: (path, data) => writes.push({ path, data }) });
  assert.deepEqual(writes, [{ path: "/dev/ttys004", data: BEL }]);
});

test("no tty means no write, and no throw", () => {
  const writes: string[] = [];
  ringBell(ctx, { tty: () => undefined, append: (p) => writes.push(p) });
  assert.deepEqual(writes, []);
});

test("a failing write is swallowed — a bell must not fail a turn", () => {
  assert.doesNotThrow(() =>
    ringBell(ctx, { tty: () => "/dev/ttys004", append: () => { throw new Error("gone"); } }),
  );
});

test("attention calls claude-attn raise with the SESSION, not a pid", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  raiseAttention(ctx, { session: () => "pi-97", run: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /claude-attn$/);
  assert.deepEqual(calls[0].args, ["raise", "pi-97"]);
});

test("an unresolvable session raises nothing rather than raising the wrong thing", () => {
  const calls: string[] = [];
  raiseAttention(ctx, { session: () => undefined, run: (cmd) => calls.push(cmd) });
  assert.deepEqual(calls, []);
});

test("permission attention calls claude-attn raise-wait with the session", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  raisePermissionAttention(ctx, { session: () => "pi-97", run: (cmd, args) => calls.push({ cmd, args }) });
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /claude-attn$/);
  assert.deepEqual(calls[0].args, ["raise-wait", "pi-97"]);
});

test("clearing permission attention calls claude-attn clear-wait with the session", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  clearPermissionAttention(ctx, { session: () => "pi-97", run: (cmd, args) => calls.push({ cmd, args }) });
  assert.deepEqual(calls[0].args, ["clear-wait", "pi-97"]);
});

test("an unresolvable session neither raises nor clears the permission flag", () => {
  const calls: string[] = [];
  raisePermissionAttention(ctx, { session: () => undefined, run: (cmd) => calls.push(cmd) });
  clearPermissionAttention(ctx, { session: () => undefined, run: (cmd) => calls.push(cmd) });
  assert.deepEqual(calls, []);
});

test("a failing permission-attention call is swallowed — it must not fail a turn", () => {
  assert.doesNotThrow(() =>
    raisePermissionAttention(ctx, { session: () => "pi-97", run: () => { throw new Error("gone"); } }),
  );
});
