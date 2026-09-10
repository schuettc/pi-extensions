import { test } from "node:test";
import assert from "node:assert/strict";
import { presenceToStatus } from "./status.ts";

// Guards: the person must see phone presence in exactly the spec's words; a wrong string is a silent-state defect (spec §4, §6).
test("driving phone shows 'phone is working'", () => {
  assert.equal(presenceToStatus([{ deviceId: "p", name: "iPhone", state: "driving" }]), "phone is working");
});
test("connected phone shows 'phone connected'", () => {
  assert.equal(presenceToStatus([{ deviceId: "p", name: "iPhone", state: "connected" }]), "phone connected");
});
test("no phones / all offline shows 'offline'", () => {
  assert.equal(presenceToStatus([]), "offline");
  assert.equal(presenceToStatus([{ deviceId: "p", name: "iPhone", state: "offline" }]), "offline");
});
