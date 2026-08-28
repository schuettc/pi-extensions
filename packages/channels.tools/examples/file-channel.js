#!/usr/bin/env node
// Reference channel server for the claude/channel convention.
//
// Watches a file; every line appended to it is pushed into the connected pi
// session as a channel event. Declares one tool (file_channel_status) so the
// tool-proxy path is exercised too.
//
//   node file-channel.js <path>            run as a channel server (pi spawns this)
//   node file-channel.js --demo            narrated walkthrough, no pi needed
//   node file-channel.js --demo --wire     the same exchange as raw wire frames
//
// Wire format: newline-delimited JSON-RPC 2.0 over stdio.

import { openSync, readSync, fstatSync, watchFile, closeSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const NOTIFICATION = "notifications/claude/channel";
const CAPABILITY = "claude/channel";

const arg = process.argv[2];
if (!arg || arg === "--help") {
  console.error("usage: file-channel.js <path-to-watch> | --demo");
  process.exit(2);
}

if (arg === "--demo") {
  // One scripted exchange, printable two ways: --wire shows the literal
  // ndjson frames; the default narrates the same frames as a story.
  const frames = {
    init: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "channels.tools", version: "0.1.0" } } },
    initResult: { jsonrpc: "2.0", id: 1, result: { capabilities: { experimental: { [CAPABILITY]: {} } }, instructions: "Lines appended to the watched file arrive as channel events." } },
    initialized: { jsonrpc: "2.0", method: "notifications/initialized" },
    toolsList: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    toolsResult: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "file_channel_status", description: "Report the watched path and lines delivered.", inputSchema: { type: "object", properties: {} } }] } },
    event1: { jsonrpc: "2.0", method: NOTIFICATION, params: { content: "deploy finished: api v2.4.1 is live", meta: { count: 1, source_path: "inbox.txt" } } },
    event3: { jsonrpc: "2.0", method: NOTIFICATION, params: { content: "tests passed: 214/214\nreview approved: PR #87\nnew issue filed: login flake", meta: { count: 3, source_path: "inbox.txt" } } },
  };

  if (process.argv.includes("--wire")) {
    for (const [name, frame] of Object.entries(frames)) {
      const dir = frame.method === NOTIFICATION || frame.result ? "->" : "<-";
      console.log(`${dir} ${JSON.stringify(frame)}`);
      void name;
    }
    process.exit(0);
  }

  const tty = process.stdout.isTTY;
  const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
  const dim = (s) => paint(2, s);
  const cyan = (s) => paint(36, s);
  const bold = (s) => paint(1, s);
  const green = (s) => paint(32, s);
  const rule = (title) => console.log(`\n${dim("──")} ${bold(title)} ${dim("─".repeat(Math.max(2, 56 - title.length)))}`);
  const say = (s) => console.log(s);
  const pause = () => (tty ? sleep(650) : Promise.resolve());

  say(`${bold("file-channel")} ${dim("·")} a channel server: one file in, channel events out`);
  say(dim("the same exchange as raw wire frames: --demo --wire"));

  rule("1 · handshake — the session spawns this server");
  await pause();
  say(`  ${cyan("→")} initialize`);
  say(`  ${cyan("←")} capabilities.experimental[${green('"claude/channel"')}] ${green("✓")}`);
  say(`    ${dim("instructions:")} "Lines appended to the watched file arrive as channel events."`);
  await pause();
  say(`  ${cyan("→")} tools/list`);
  say(`  ${cyan("←")} 1 tool: ${bold("file_channel_status")} ${dim("— registered with the agent, callable by name")}`);

  rule("2 · something happens on your machine");
  await pause();
  say(`  ${dim("$")} echo ${green('"deploy finished: api v2.4.1 is live"')} >> inbox.txt`);
  await pause();
  say(`  ${cyan("←")} notifications/claude/channel  ${dim("(count 1, source inbox.txt)")}`);
  say(`    ${bold("deploy finished: api v2.4.1 is live")}`);
  say(`    ${dim("the session is idle — this push wakes it and starts a turn")}`);

  rule("3 · three more land while the agent is busy");
  await pause();
  say(`  ${dim("$")} echo ... >> inbox.txt   ${dim("×3, mid-turn")}`);
  await pause();
  say(`  ${cyan("←")} notifications/claude/channel  ${dim("(count 3 — one push, coalesced)")}`);
  for (const line of frames.event3.params.content.split("\n")) say(`    ${bold(line)}`);
  say(`    ${dim("buffered while the turn ran; delivered together when it settled")}`);

  rule("try it live");
  say(`  add to ${cyan("~/.pi/agent/channels.json")}:`);
  say(`    { "channelServers": { "file": { "command": "node", "args": ["${dim("/path/to/")}file-channel.js", "inbox.txt"] } } }`);
  say(`  then, with the session idle:  ${dim("$")} echo hi >> inbox.txt   ${dim("— and watch it wake")}\n`);
  process.exit(0);
}

const watchedPath = arg;
let delivered = 0;
let offset = 0;

function send(msg) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
}

function drainNewLines() {
  let fd;
  try {
    fd = openSync(watchedPath, "r");
  } catch {
    return; // file may not exist yet; watchFile fires again when it does
  }
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0; // truncated: start over
    if (size === offset) return;
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    offset = size;
    const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return;
    delivered += lines.length;
    send({
      method: NOTIFICATION,
      params: {
        content: lines.join("\n"),
        meta: { count: lines.length, source_path: watchedPath },
      },
    });
  } finally {
    closeSync(fd);
  }
}

let buffered = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let nl;
  while ((nl = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, nl);
    buffered = buffered.slice(nl + 1);
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(msg) {
  if (msg.method === "initialize") {
    send({
      id: msg.id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { experimental: { [CAPABILITY]: {} } },
        serverInfo: { name: "file-channel", version: "0.1.0" },
        instructions:
          `Lines appended to ${watchedPath} arrive as channel events. ` +
          "Call file_channel_status to see what has been delivered.",
      },
    });
    // Start from the file's current end: only NEW lines become events.
    try {
      const fd = openSync(watchedPath, "r");
      offset = fstatSync(fd).size;
      closeSync(fd);
    } catch {
      offset = 0;
    }
    watchFile(watchedPath, { interval: 500 }, drainNewLines);
    return;
  }
  if (msg.method === "tools/list") {
    send({
      id: msg.id,
      result: {
        tools: [
          {
            name: "file_channel_status",
            description: "Report the watched path and how many lines have been delivered.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    if (name === "file_channel_status") {
      send({
        id: msg.id,
        result: {
          content: [{ type: "text", text: `watching ${watchedPath}; ${delivered} line(s) delivered` }],
        },
      });
    } else {
      send({ id: msg.id, error: { code: -32601, message: `unknown tool: ${name}` } });
    }
    return;
  }
  if (msg.id !== undefined) {
    // Unknown request: answer rather than dangle the client's promise.
    send({ id: msg.id, error: { code: -32601, message: `unknown method: ${msg.method}` } });
  }
}

process.on("SIGTERM", () => process.exit(0));
