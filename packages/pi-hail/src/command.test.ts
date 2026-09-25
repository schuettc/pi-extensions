import { test } from "node:test";
import assert from "node:assert/strict";
import { runHailCommand } from "./command.ts";
import { Session, type SessionDeps } from "./session.ts";

function sessionWithSends() {
  const sent: unknown[] = [];
  const deps: SessionDeps = {
    send: (o) => sent.push(o),
    sendUserMessage: () => {},
    ui: {
      setStatus: () => {},
      notify: () => {},
      holdInput: () => {},
      openDialog: () => Promise.resolve(undefined),
    },
    getEntries: () => [],
  };
  return { session: new Session(deps), sent };
}

test("/hail connect and /hail disconnect send connection requests", () => {
  const { session, sent } = sessionWithSends();
  const notes: string[] = [];
  runHailCommand("connect", session, (m) => notes.push(m));
  runHailCommand(" disconnect ", session, (m) => notes.push(m));
  assert.deepEqual(sent, [{ connection: "connect" }, { connection: "disconnect" }]);
  assert.equal(notes.length, 2);
});

test("/hail with no session explains it is not connected", () => {
  const notes: string[] = [];
  runHailCommand("connect", undefined, (m) => notes.push(m));
  assert.match(notes[0], /not connected/);
});

test("/hail with an unknown argument prints usage", () => {
  const { session, sent } = sessionWithSends();
  const notes: string[] = [];
  runHailCommand("", session, (m) => notes.push(m));
  runHailCommand("bogus", session, (m) => notes.push(m));
  assert.deepEqual(sent, []);
  assert.equal(notes.length, 2);
  for (const n of notes) assert.match(n, /usage: \/hail connect \| disconnect/);
});
