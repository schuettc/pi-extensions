import { test } from "node:test";
import assert from "node:assert/strict";
import { createWake } from "./wake.ts";
import type { ChannelEvent } from "./envelope.ts";

function harness() {
  const delivered: string[] = [];
  const wake = createWake({ deliver: (d) => delivered.push(d.envelope) });
  wake.onSessionStart();
  wake.onReady();
  return { wake, delivered };
}

const ev = (source: string, content: string, meta: Record<string, string> = {}): ChannelEvent =>
  ({ source, content, meta });

test("an event while idle delivers immediately", () => {
  const { wake, delivered } = harness();
  wake.onEvent(ev("muster-channel", "mail arrived"));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /mail arrived/);
});

test("an event mid-turn is buffered, not delivered", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onEvent(ev("muster-channel", "mail arrived"));
  assert.equal(delivered.length, 0);
  assert.equal(wake.pendingCount(), 1);
});

test("settling flushes the buffer coalesced into one delivery per source", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onEvent(ev("muster-channel", "one"));
  wake.onEvent(ev("muster-channel", "two"));
  wake.onAgentSettled();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /one/);
  assert.match(delivered[0], /two/);
  assert.equal(wake.pendingCount(), 0);
});

test("events from different sources flush as separate deliveries", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onEvent(ev("muster-channel", "mail"));
  wake.onEvent(ev("galley", "revise"));
  wake.onAgentSettled();
  assert.equal(delivered.length, 2);
  assert.match(delivered[0], /source="muster-channel"/);
  assert.match(delivered[1], /source="galley"/);
});

test("settling with an empty buffer delivers nothing", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onAgentSettled();
  assert.equal(delivered.length, 0);
});

test("mail arriving before ready is buffered and released once ready", () => {
  const delivered: string[] = [];
  const wake = createWake({ deliver: (d) => delivered.push(d.envelope) });
  wake.onSessionStart();
  wake.onEvent(ev("muster-channel", "early mail"));
  assert.equal(delivered.length, 0, "must not deliver into a half-built session");
  wake.onReady();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0], /early mail/);
});

test("a turn started by the operator also buffers", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();          // not triggered by us
  wake.onEvent(ev("muster-channel", "mail"));
  assert.equal(delivered.length, 0);
});

test("session_start clears the buffer and closes the gate again", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onEvent(ev("muster-channel", "stale"));
  wake.onSessionStart();
  assert.equal(wake.pendingCount(), 0);
  wake.onEvent(ev("muster-channel", "after resume"));
  assert.equal(delivered.length, 0, "gate is closed until ready");
  wake.onReady();
  assert.equal(delivered.length, 1);
  assert.doesNotMatch(delivered[0], /stale/);
});

test("a throwing deliver for one source still delivers the other (F2)", () => {
  const delivered: string[] = [];
  const logs: string[] = [];
  const wake = createWake({
    deliver: (d) => {
      if (d.envelope.includes('source="bad"')) throw new Error("boom: deliver exploded");
      delivered.push(d.envelope);
    },
    log: (m) => logs.push(m),
  });
  wake.onSessionStart();
  wake.onReady();
  wake.onAgentStart();
  wake.onEvent(ev("bad", "one"));
  wake.onEvent(ev("good", "two"));
  wake.onAgentSettled();
  assert.equal(delivered.length, 1, "the good source's batch must still be delivered");
  assert.match(delivered[0], /source="good"/);
  assert.ok(logs.some((l) => /bad/.test(l)), `expected a log naming the failed source, got: ${logs.join(" | ")}`);
});

test("delivery order across sources follows first arrival", () => {
  const { wake, delivered } = harness();
  wake.onAgentStart();
  wake.onEvent(ev("galley", "first"));
  wake.onEvent(ev("muster-channel", "second"));
  wake.onAgentSettled();
  assert.match(delivered[0], /source="galley"/);
});
