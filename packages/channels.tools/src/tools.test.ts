import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSchema, resolveToolNames, toTextContent } from "./tools.ts";

test("normalizeSchema strips $schema and additionalProperties", () => {
  const out = normalizeSchema({
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: { doc: { type: "string" } },
    additionalProperties: false,
  });
  assert.deepEqual(out, { type: "object", properties: { doc: { type: "string" } } });
});

test("normalizeSchema substitutes an empty object schema for junk", () => {
  assert.deepEqual(normalizeSchema(undefined), { type: "object", properties: {} });
  assert.deepEqual(normalizeSchema(null), { type: "object", properties: {} });
  assert.deepEqual(normalizeSchema("nonsense"), { type: "object", properties: {} });
  assert.deepEqual(normalizeSchema([1, 2]), { type: "object", properties: {} });
});

test("tool names are registered unprefixed so server instructions stay true", () => {
  const { resolved, dropped } = resolveToolNames(
    [{ name: "muster-channel", tools: [{ name: "muster_channel_status" }] }],
    ["bash", "read"],
  );
  assert.deepEqual(resolved, [
    { server: "muster-channel", original: "muster_channel_status", registered: "muster_channel_status" },
  ]);
  assert.deepEqual(dropped, []);
});

test("a collision with a builtin is prefixed with the server name", () => {
  const { resolved } = resolveToolNames([{ name: "galley", tools: [{ name: "read" }] }], ["bash", "read"]);
  assert.equal(resolved[0].registered, "galley_read");
  assert.equal(resolved[0].original, "read");
});

test("a collision between two servers prefixes only the later one", () => {
  const { resolved } = resolveToolNames(
    [
      { name: "alpha", tools: [{ name: "status" }] },
      { name: "beta", tools: [{ name: "status" }] },
    ],
    [],
  );
  assert.equal(resolved[0].registered, "status");
  assert.equal(resolved[1].registered, "beta_status");
});

test("server names are sanitized before prefixing", () => {
  const { resolved } = resolveToolNames([{ name: "muster-channel", tools: [{ name: "read" }] }], ["read"]);
  assert.equal(resolved[0].registered, "muster_channel_read");
});

test("a tool whose prefixed name still collides with a builtin is dropped with a reason naming the builtin", () => {
  const { resolved, dropped } = resolveToolNames(
    [{ name: "galley", tools: [{ name: "read" }] }],
    ["read", "galley_read"],
  );
  assert.deepEqual(resolved, []);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].server, "galley");
  assert.equal(dropped[0].original, "read");
  assert.match(dropped[0].reason, /builtin/);
});

test("a tool whose prefixed name collides with another server's registered tool is dropped with a reason naming a cross-server collision, not a builtin", () => {
  // No builtins at all: gamma takes the bare name "x", beta gets prefixed to
  // "beta_x" and registers it, then a second beta tool also named "x" tries
  // the same bare-then-prefixed path and finds "beta_x" already taken by its
  // own server's earlier tool — a collision with zero builtins involved.
  const { resolved, dropped } = resolveToolNames(
    [
      { name: "gamma", tools: [{ name: "x" }] },
      { name: "beta", tools: [{ name: "x" }, { name: "x" }] },
    ],
    [],
  );
  assert.equal(resolved.length, 2);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].server, "beta");
  assert.equal(dropped[0].original, "x");
  assert.match(dropped[0].reason, /another server/);
  assert.doesNotMatch(dropped[0].reason, /builtin/);
});

test("toTextContent maps MCP text blocks through", () => {
  const out = toTextContent({ content: [{ type: "text", text: "hello" }] });
  assert.deepEqual(out.content, [{ type: "text", text: "hello" }]);
  assert.equal(out.isError, false);
});

test("toTextContent honors isError", () => {
  const out = toTextContent({ content: [{ type: "text", text: "boom" }], isError: true });
  assert.equal(out.isError, true);
});

test("toTextContent renders non-text blocks as a readable placeholder", () => {
  const out = toTextContent({ content: [{ type: "image", data: "…", mimeType: "image/png" }] });
  assert.equal(out.content.length, 1);
  assert.match(out.content[0].text, /image/);
});

test("toTextContent survives a result with no content", () => {
  const out = toTextContent({});
  assert.equal(out.content.length, 1);
  assert.equal(out.isError, false);
});
