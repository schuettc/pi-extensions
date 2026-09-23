import { test } from "node:test";
import assert from "node:assert/strict";
import { runHailCommand } from "./command.ts";
import { Session, type SessionDeps } from "./session.ts";

function sessionWithSends() {
  const sent: unknown[] = [];
  const deps: SessionDeps = {
    send: (o) => sent.push(o),
    sendUserMessage: () => {},
    ui: { setStatus: () => {}, notify: () => {}, holdInput: () => {} },
    readSessionEvents: () => [],
  };
  return { session: new Session(deps), sent };
}

test("/hail show and /hail hide send visibility requests", () => {
  const { session, sent } = sessionWithSends();
  const notes: string[] = [];
  runHailCommand("show", session, (m) => notes.push(m));
  runHailCommand(" hide ", session, (m) => notes.push(m));
  assert.deepEqual(sent, [{ visibility: "show" }, { visibility: "hide" }]);
  assert.equal(notes.length, 2);
});

test("/hail with no session explains it is not connected", () => {
  const notes: string[] = [];
  runHailCommand("show", undefined, (m) => notes.push(m));
  assert.match(notes[0], /not connected/);
});

test("/hail with an unknown argument prints usage", () => {
  const { session, sent } = sessionWithSends();
  const notes: string[] = [];
  runHailCommand("", session, (m) => notes.push(m));
  runHailCommand("bogus", session, (m) => notes.push(m));
  assert.deepEqual(sent, []);
  assert.equal(notes.length, 2);
  for (const n of notes) assert.match(n, /usage: \/hail show \| hide/);
});
