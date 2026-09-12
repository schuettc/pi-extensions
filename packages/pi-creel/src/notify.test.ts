import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEvent, savedMessage } from "./notify.ts";

test("parseEvent accepts a well-formed added/updated event", () => {
  assert.deepEqual(parseEvent('{"name":"STRIPE_KEY","dest":".env","action":"added"}'), {
    name: "STRIPE_KEY",
    dest: ".env",
    action: "added",
  });
  assert.deepEqual(parseEvent('{"name":"K","dest":"config/.env","action":"updated"}'), {
    name: "K",
    dest: "config/.env",
    action: "updated",
  });
});

test("parseEvent rejects bad json, missing fields, bad name, bad action", () => {
  assert.equal(parseEvent("not json"), undefined);
  assert.equal(parseEvent("{}"), undefined);
  assert.equal(parseEvent('{"name":"K","dest":".env"}'), undefined); // no action
  assert.equal(parseEvent('{"name":"BAD-NAME","dest":".env","action":"added"}'), undefined);
  assert.equal(parseEvent('{"name":"K","dest":".env","action":"deleted"}'), undefined);
  assert.equal(parseEvent('{"name":"K","dest":"","action":"added"}'), undefined);
});

test("parseEvent refuses any payload carrying a value field", () => {
  assert.equal(
    parseEvent('{"name":"K","dest":".env","action":"added","value":"sk-secret"}'),
    undefined,
  );
});

test("savedMessage names the key and dest, points at process.env, and omits the value", () => {
  const m = savedMessage({ name: "STRIPE_KEY", dest: ".env", action: "added" });
  assert.match(m, /STRIPE_KEY/);
  assert.match(m, /\.env/);
  assert.match(m, /process\.env\.STRIPE_KEY/);
  assert.ok(!/sk-/.test(m));
});
