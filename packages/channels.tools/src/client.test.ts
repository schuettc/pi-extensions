import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { JsonRpcClient } from "./client.ts";

function pair() {
  const stdin = new PassThrough();   // what the client writes
  const stdout = new PassThrough();  // what the client reads
  const client = new JsonRpcClient({ stdin, stdout });
  return { client, stdin, stdout };
}

function nextLine(stream: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let buf = "";
    stream.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl >= 0) resolve(JSON.parse(buf.slice(0, nl)));
    });
  });
}

test("request writes a framed JSON-RPC call and resolves on the matching id", async () => {
  const { client, stdin, stdout } = pair();
  const pending = client.request("initialize", { protocolVersion: "2025-06-18" });
  const sent = await nextLine(stdin);
  assert.equal(sent.jsonrpc, "2.0");
  assert.equal(sent.method, "initialize");
  assert.deepEqual(sent.params, { protocolVersion: "2025-06-18" });
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, result: { ok: true } }) + "\n");
  assert.deepEqual(await pending, { ok: true });
});

test("a JSON-RPC error response rejects", async () => {
  const { client, stdin, stdout } = pair();
  const pending = client.request("tools/call");
  const sent = await nextLine(stdin);
  stdout.write(JSON.stringify({ jsonrpc: "2.0", id: sent.id, error: { code: -32601, message: "no such tool" } }) + "\n");
  await assert.rejects(pending, /no such tool/);
});

test("notifications reach the handler and carry method and params", async () => {
  const { client, stdout } = pair();
  const seen: Array<{ method: string; params: unknown }> = [];
  client.onNotification((method, params) => seen.push({ method, params }));
  stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: "hello", meta: { intent: "fyi" } },
  }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "notifications/claude/channel");
  assert.deepEqual(seen[0].params, { content: "hello", meta: { intent: "fyi" } });
});

test("a message split across chunk boundaries is reassembled", async () => {
  const { client, stdout } = pair();
  const seen: string[] = [];
  client.onNotification((method) => seen.push(method));
  stdout.write('{"jsonrpc":"2.0","meth');
  stdout.write('od":"notifications/x"}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["notifications/x"]);
});

test("two messages in one chunk are both delivered", async () => {
  const { client, stdout } = pair();
  const seen: string[] = [];
  client.onNotification((method) => seen.push(method));
  stdout.write('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","method":"b"}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["a", "b"]);
});

test("an unparseable line is skipped without killing the stream", async () => {
  const { client, stdout } = pair();
  const seen: string[] = [];
  client.onNotification((method) => seen.push(method));
  stdout.write('not json\n{"jsonrpc":"2.0","method":"after"}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ["after"]);
});

test("close rejects every in-flight request", async () => {
  const { client, stdin } = pair();
  const pending = client.request("initialize");
  await nextLine(stdin);
  client.close();
  await assert.rejects(pending, /closed/);
});

test("a notification carrying \"id\": null is dispatched, not dropped (F8)", async () => {
  const { client, stdout } = pair();
  const seen: Array<{ method: string; params: unknown }> = [];
  client.onNotification((method, params) => seen.push({ method, params }));
  stdout.write(JSON.stringify({
    jsonrpc: "1.0",
    id: null,
    method: "notifications/claude/channel",
    params: { content: "mail", meta: {} },
  }) + "\n");
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1, "an id:null notification must not be silently dropped");
  assert.equal(seen[0].method, "notifications/claude/channel");
});

// Race the pending request against a short timer rather than awaiting it
// directly: pre-fix, an aborted signal is never honored and the request
// never settles, so a direct assert.rejects() would hang instead of failing.
async function raceAbort(pending: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
  return Promise.race([
    pending.then(() => "resolved" as const, () => "rejected" as const),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), 300)),
  ]);
}

test("aborting the signal after send rejects the pending request and stops the timer (F6)", async () => {
  const { client, stdin } = pair();
  const controller = new AbortController();
  const pending = client.request("tools/call", { name: "x" }, 30_000, controller.signal);
  await nextLine(stdin);
  controller.abort();
  assert.equal(await raceAbort(pending), "rejected");
  await assert.rejects(pending, /aborted/);
});

test("an already-aborted signal rejects immediately without sending (F6)", async () => {
  const { client } = pair();
  const controller = new AbortController();
  controller.abort();
  const pending = client.request("tools/call", {}, 30_000, controller.signal);
  assert.equal(await raceAbort(pending), "rejected");
  await assert.rejects(pending, /aborted/);
});
