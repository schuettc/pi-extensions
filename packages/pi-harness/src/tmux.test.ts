import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTmux } from "./tmux.ts";

test("resolves socket and pane from a real TMUX value", () => {
  const ctx = resolveTmux({ TMUX: "/private/tmp/tmux-501/proj-pi,12345,3", TMUX_PANE: "%47" });
  assert.equal(ctx?.socket, "proj-pi");
  assert.equal(ctx?.pane, "%47");
});

test("returns undefined outside tmux", () => {
  assert.equal(resolveTmux({}), undefined);
  assert.equal(resolveTmux({ TMUX_PANE: "%1" }), undefined);
  assert.equal(resolveTmux({ TMUX: "/tmp/sock,1,0" }), undefined);
});

test("socket is the basename of the first comma field, not the whole path", () => {
  // Pane ids are only unique per server and this machine runs a socket per
  // project, so the socket name is half the state-file key. Taking the path
  // rather than its basename would put slashes in a filename.
  const ctx = resolveTmux({ TMUX: "/very/long/path/to/default,9,0", TMUX_PANE: "%1" });
  assert.equal(ctx?.socket, "default");
});

test("an empty or malformed TMUX yields undefined rather than a junk socket", () => {
  assert.equal(resolveTmux({ TMUX: "", TMUX_PANE: "%1" }), undefined);
  assert.equal(resolveTmux({ TMUX: ",,", TMUX_PANE: "%1" }), undefined);
});
