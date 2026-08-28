import { homedir } from "node:os";
import { loadChannelConfig } from "./config.ts";
import type { ChannelServerDef } from "./config.ts";
import { ConnectionManager } from "./connection.ts";
import type { Connection } from "./connection.ts";
import { createWake } from "./wake.ts";
import { applyIdentity } from "./identity.ts";
import { normalizeSchema, resolveToolNames, toTextContent } from "./tools.ts";

type Deps = {
  env?: NodeJS.ProcessEnv;
  loadConfig?: (cwd: string) => Record<string, ChannelServerDef>;
  onBeforeSpawn?: () => void;
  // Test seams only: override the ConnectionManager's retry backoff so tests
  // can exercise the retry path without waiting out the real 30s/5min timers.
  retryBaseMs?: number;
  retryMaxMs?: number;
};

export function createExtension(pi: any, deps: Deps = {}): void {
  const env = deps.env ?? process.env;
  const loadConfig = deps.loadConfig ?? ((cwd: string) => loadChannelConfig({ home: homedir(), cwd }));

  const manager = new ConnectionManager({
    onEvent: (event) => wake.onEvent(event),
    onStatus: (status) => uiSetStatus(status),
    log: (message) => log(message),
    // A channel that connects via retry — 30s+ after session_start already
    // ran registerTools() once — is otherwise never brought back into the
    // tool lifecycle: its instructions get injected and its events wake the
    // agent, but the tools it just told the agent to call were never
    // registered. registerTools() is idempotent (it clears and rebuilds
    // registeredNames every call), so re-running it here is safe.
    onConnected: (connections) => {
      try {
        registerTools(connections);
      } catch (error) {
        log(`re-registering tools after a retry reconnect failed: ${String(error)}`);
      }
    },
    ...(deps.retryBaseMs !== undefined ? { retryBaseMs: deps.retryBaseMs } : {}),
    ...(deps.retryMaxMs !== undefined ? { retryMaxMs: deps.retryMaxMs } : {}),
  });

  const wake = createWake({
    deliver: ({ envelope, summary }) => {
      // Two-part delivery so the transcript shows a short readable line
      // instead of the raw XML envelope, while the model still receives the
      // envelope verbatim (pi serializes custom messages to the LLM as user
      // content; display:false only hides them from the TUI).
      //
      // Why not one custom message with triggerTurn: that path starts the
      // turn without emitting before_agent_start (verified against pi
      // 0.84.3 dist), so extensions that assemble or capture the system
      // prompt there never see the turn — a bridge provider can hard-fail a
      // session whose first turn is a channel wake. Instead the envelope is
      // queued deliverAs:"nextTurn" and the turn is triggered by the
      // summary via sendUserMessage: prompt() drains the nextTurn queue
      // into that same turn BEFORE emitting before_agent_start. Wake only
      // delivers while the agent is settled; if a turn starts in the narrow
      // race window, the summary steers into it and the envelope waits for
      // the next prompt — degraded (the summary stands alone by design),
      // never lost.
      pi.sendMessage(
        { customType: "channel-envelope", content: envelope, display: false },
        { deliverAs: "nextTurn" },
      );
      pi.sendUserMessage(summary, { deliverAs: "steer" });
    },
    log: (message) => log(message),
  });

  let ui:
    | {
        setStatus?: (key: string, value?: string) => void;
        notify?: (message: string, type?: string) => void;
      }
    | undefined;
  const registeredNames = new Set<string>();

  function uiSetStatus(status: string): void {
    ui?.setStatus?.("channels", status === "" ? undefined : status);
  }

  function log(message: string): void {
    // Raw stderr writes corrupt the TUI's input line (the text bleeds into
    // the editor and sticks until pi exits). Once session_start has handed
    // us ctx.ui, route through notify; stderr is only the pre-UI fallback.
    if (ui?.notify) ui.notify(`[channels] ${message}`, "info");
    else process.stderr.write(`[channels] ${message}\n`);
  }

  function registerTools(connections: Connection[]): void {
    const builtins = (pi.getAllTools?.() ?? []).map((t: { name: string }) => t.name);
    const { resolved, dropped } = resolveToolNames(
      connections.map((c) => ({ name: c.name, tools: c.tools })),
      builtins,
    );
    // A dropped tool is uncallable and invisible; say so rather than letting
    // the agent wonder why a documented tool does not exist.
    for (const drop of dropped) {
      log(`channel ${drop.server}: tool "${drop.original}" not registered — ${drop.reason}`);
    }

    // session_start also fires for reload/resume/fork, each time with a
    // freshly reconnected `connections` array — the previous connectAll()
    // already closed the old children and clients. Re-registering
    // unconditionally (rather than skipping names already seen) replaces
    // each tool's `execute` closure so it captures the new connection;
    // skipping would leave the tool calling a client that is already
    // closed, failing silently on every future invocation.
    const stillPresent = new Set(resolved.map((e) => e.registered));
    // pi.unregisterTool does not exist in the installed pi 0.84.2 (verified
    // against its docs/ and dist/) — the optional call below is a permanent
    // no-op today, kept only for a future pi version that adds it. The
    // fallback that actually works now: drop the stale names from the
    // active set, computed from getActiveTools() minus what is stale, so a
    // resume never leaves a tool pointing at a closed client. Both calls are
    // guarded; nothing here may throw into session_start.
    const stillStale: string[] = [];
    for (const name of registeredNames) {
      if (stillPresent.has(name)) continue;
      let handled = false;
      try {
        handled = Boolean(pi.unregisterTool?.(name));
      } catch (error) {
        log(`failed to unregister stale tool "${name}": ${String(error)}`);
      }
      if (!handled) stillStale.push(name);
    }
    if (stillStale.length > 0) {
      try {
        const active: string[] = pi.getActiveTools?.() ?? [];
        pi.setActiveTools?.(active.filter((name: string) => !stillStale.includes(name)));
      } catch (error) {
        log(`failed to drop stale tools from the active set: ${String(error)}`);
      }
    }
    registeredNames.clear();

    for (const entry of resolved) {
      // entry.server always names a connection from `connections` — it was
      // built from `connections.map(...)` above.
      const conn = connections.find((c) => c.name === entry.server)!;
      const def = conn.tools.find((t) => t.name === entry.original);
      registeredNames.add(entry.registered);
      pi.registerTool({
        name: entry.registered,
        label: entry.original,
        description: def?.description ?? `Tool from the ${entry.server} channel`,
        // Plain JSON Schema: pi's toolWireSchema and validateToolArguments
        // treat it as such, and it keeps this module free of typebox.
        parameters: normalizeSchema(def?.inputSchema),
        // pi's documented signature is execute(toolCallId, params, signal,
        // onUpdate, ctx). Threading `signal` through to the JSON-RPC request
        // means an aborted turn rejects the pending call immediately instead
        // of leaving it pending for the full 30s timeout.
        async execute(_id: string, params: unknown, signal?: AbortSignal) {
          // pi only honors a thrown error as tool failure (it sets
          // isError: true on the reported result); returning any
          // error-shaped value — nested or not — is inert and the agent
          // reads it as a clean success.
          let result: unknown;
          try {
            result = await conn.client.request(
              "tools/call",
              { name: entry.original, arguments: params ?? {} },
              undefined,
              signal,
            );
          } catch (error) {
            throw new Error(`channel tool "${entry.original}" on ${entry.server} failed: ${String(error)}`);
          }
          const mapped = toTextContent(result);
          if (mapped.isError) {
            const text = mapped.content.map((c) => c.text).join("\n");
            throw new Error(`channel tool "${entry.original}" on ${entry.server} reported an error: ${text}`);
          }
          return { content: mapped.content, details: { server: entry.server } };
        },
      });
    }
  }

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    ui = ctx.ui;
    wake.onSessionStart();

    // The whole body runs under try/finally so wake.onReady() always fires,
    // even if something in between throws (most plausibly pi.registerTool
    // rejecting a schema shaped by an external, out-of-our-control server).
    // onReady() is the only thing that opens the mail gate; skipping it on
    // an unhandled error would silently swallow every channel event for the
    // rest of the session's lifetime.
    try {
      // Ordering is load-bearing: servers may read AGENT_SESSION_ID at
      // their own startup to scope what they attach to. Set it late and
      // such a channel comes up blind while the connection still looks
      // healthy.
      applyIdentity(ctx.sessionManager?.getSessionId?.(), env);
      deps.onBeforeSpawn?.();

      const defs = loadConfig(ctx.cwd ?? process.cwd());
      await manager.connectAll(defs);
      // manager.connections(), NOT the array connectAll returned: a retry that
      // reconnected while a sibling was still handshaking has already
      // registered its tools via onConnected, and connectAll's array cannot
      // contain that server. Registering from the narrower array treats those
      // tools as stale and drops them — leaving a live channel whose
      // instructions are injected and whose events wake the agent, with no
      // tools and no further retry scheduled. connections() is a superset in
      // every other case.
      registerTools(manager.connections());
    } catch (error) {
      log(`session_start failed: ${String(error)}`);
    } finally {
      // The gate opens when session_start completes — never on first
      // settle, since agent_settled only fires after an agent run.
      wake.onReady();
    }
  });

  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    const blocks = manager
      .connections()
      .filter((c) => typeof c.instructions === "string" && c.instructions !== "")
      .map((c) => `<channel-instructions source="${c.name}">\n${c.instructions}\n</channel-instructions>`);
    if (blocks.length === 0) return undefined;
    return { systemPrompt: `${event.systemPrompt ?? ""}\n\n${blocks.join("\n\n")}` };
  });

  pi.on("agent_start", () => wake.onAgentStart());
  pi.on("agent_settled", () => wake.onAgentSettled());
  pi.on("session_shutdown", async () => { await manager.closeAll(); });
}

export default function (pi: any): void {
  createExtension(pi);
}
