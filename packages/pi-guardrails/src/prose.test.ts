import { test } from "node:test";
import assert from "node:assert/strict";
import { appendPolicy } from "./prose.ts";

const HEADER =
  "Harness policy — earned rules from operating this harness, not permission settings:";

test("appendPolicy with no prose is a no-op", () => {
  assert.equal(appendPolicy("BASE PROMPT", []), "BASE PROMPT");
});

test("appendPolicy appends the header and the rules in order", () => {
  const out = appendPolicy("BASE PROMPT", ["rule A", "rule B"]);
  assert.equal(out, `BASE PROMPT\n\n${HEADER}\nrule A\nrule B`);
});

test("appendPolicy handles an empty system prompt", () => {
  assert.equal(appendPolicy("", ["rule A"]), `${HEADER}\nrule A`);
});
