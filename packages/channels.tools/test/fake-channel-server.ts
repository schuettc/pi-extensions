// A minimal claude/channel server for tests.
// Env knobs:
//   FAKE_NO_CAPABILITY=1  → omit the experimental capability (must be rejected)
//   FAKE_PUSH_AFTER_MS=n  → emit one channel notification after n ms
//   FAKE_EXIT_AFTER_MS=n  → exit(1) after n ms, to exercise backoff
//   FAKE_TOOL_ISERROR=1   → tools/call responds with isError:true and error text
//   FAKE_TOOL_NAME=name   → advertise this tool name instead of fake_status,
//                            so two fixtures in one test expose distinct tools
//   FAKE_INIT_DELAY_MS=n  → delay the initialize response by n ms, so a
//                            sibling's retry can land before connectAll resolves
//   FAKE_IGNORE_SIGTERM=1 → install a no-op SIGTERM handler, like real
//                           `muster channel` — only SIGKILL ends the process;
//                           also reports "PID:<n>" to stderr so a test can
//                           verify the OS process actually dies
if (process.env.FAKE_IGNORE_SIGTERM) {
  process.on("SIGTERM", () => {});
  process.stderr.write(`PID:${process.pid}\n`);
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");
  let nl = buffer.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line !== "") handle(JSON.parse(line));
    nl = buffer.indexOf("\n");
  }
});

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function handle(msg: Record<string, unknown>): void {
  if (msg.method === "initialize") {
    const capabilities = process.env.FAKE_NO_CAPABILITY
      ? { tools: {} }
      : { experimental: { "claude/channel": {} }, tools: {} };
    const initDelay = Number(process.env.FAKE_INIT_DELAY_MS ?? 0);
    const respond = () => send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        capabilities,
        instructions: "FAKE CORE INSTRUCTIONS",
        protocolVersion: "2025-06-18",
        serverInfo: { name: "fake", version: "0.0.1" },
      },
    });
    if (initDelay > 0) setTimeout(respond, initDelay);
    else respond();
    return;
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{
          name: process.env.FAKE_TOOL_NAME ?? "fake_status",
          description: "Report fake status",
          inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: {}, additionalProperties: false },
        }],
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    if (process.env.FAKE_TOOL_ISERROR) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: "FAKE TOOL ERROR TEXT" }], isError: true },
      });
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "fake ok" }] } });
    return;
  }
  if (typeof msg.id === "number") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
}

const pushAfter = Number(process.env.FAKE_PUSH_AFTER_MS ?? 0);
if (pushAfter > 0) {
  setTimeout(() => {
    send({
      jsonrpc: "2.0",
      method: "notifications/claude/channel",
      params: { content: "fake: something happened\n\n---\nFAKE GUIDANCE", meta: { intent: "fyi", count: "1" } },
    });
  }, pushAfter);
}

const exitAfter = Number(process.env.FAKE_EXIT_AFTER_MS ?? 0);
if (exitAfter > 0) setTimeout(() => process.exit(1), exitAfter);
