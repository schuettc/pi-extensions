/**
 * pi-casebook: connects a pi session to casebook (tackle.tools).
 *
 *  - bash tool calls that invoke git or gh are journaled with this pi session
 *    (`casebook record --harness pi`); casebook keeps verbs and targets, never the
 *    command line.
 *  - the first turn of a session gets the repo briefing (`casebook brief`) as a
 *    hidden context message.
 *  - session start and shutdown run `casebook sync --no-github` in the
 *    background; the 30-minute launchd job does the GitHub refresh.
 *  - when the agent settles (its turn ends), `casebook settled` tells casebook
 *    serve, so page messages that queued behind the turn go out.
 *  - `casebook session-info` tells casebook serve the session's name (so the
 *    page can say which session it belongs to) and its parent session (so
 *    the page can leave pi-subagents workers out): at session start, on
 *    every rename, and at each turn's end (serve may have been down at the
 *    last one). When pi replaces the session in its process (/fork, /new,
 *    /resume) or quits, it says the session ended.
 *
 * Inert when the casebook binary is missing. Never blocks, throws or prints.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  brief,
  installed,
  casebookBin,
  mentionsGit,
  record,
  settled,
  syncInBackground,
  extractCasebookDeliveries,
  sessionFacts,
  sessionInfo,
  sessionEnded,
  sessionIdFromFile,
  processSessions,
  type SessionSource,
} from "./casebook.ts";

export default function casebook(pi: ExtensionAPI) {
  const bin = casebookBin();
  if (!installed(bin)) return;
  let cwd = process.cwd();
  let sessionId = "";
  let briefed = false;
  const shownDeliveries = new Set<number>();
  // The session manager pi handed this session; read again at each report,
  // so the name sent is always the current one.
  let sessionManager: SessionSource | undefined;
  const reportInfo = () => {
    const facts = sessionFacts(sessionManager, cwd);
    if (facts && !processSessions().has(facts.id)) processSessions().set(facts.id, { root: !facts.parent });
    sessionInfo(bin, facts);
  };

  pi.on("session_start", (event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    sessionManager = ctx.sessionManager as SessionSource | undefined;
    sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "");
    briefed = false;
    // pi replaced the previous session in this process (/fork, /new,
    // /resume): it ended. Its own shutdown says so too; this covers a
    // shutdown report that was lost.
    if (event.reason === "fork" || event.reason === "new" || event.reason === "resume") {
      const previous = sessionIdFromFile(event.previousSessionFile);
      if (previous && previous !== sessionId) sessionEnded(bin, previous);
    }
    reportInfo();
    if (event.reason !== "reload") syncInBackground(bin);
  });

  // Court renamed the session (pi's /name): the page shows the new name.
  pi.on("session_info_changed", () => reportInfo());

  pi.on("tool_result", (event) => {
    if (event.toolName !== "bash") return;
    const command = String((event.input as { command?: unknown })?.command ?? "");
    if (command && mentionsGit(command)) record(bin, command, cwd, sessionId);
  });

  pi.on("before_agent_start", async () => {
    if (briefed) return undefined;
    briefed = true;
    const text = (await brief(bin, cwd)).trim();
    if (!text) return undefined;
    return { message: { customType: "casebook-brief", content: text, display: false } };
  });

  pi.on("context", (event) => {
    for (const msg of event.messages) {
      try {
        const content = (msg as { content?: unknown }).content;
        if (typeof content === "string") {
          for (const id of extractCasebookDeliveries(content)) shownDeliveries.add(id);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            try {
              if (
                typeof block === "object" &&
                block !== null &&
                (block as { type?: unknown }).type === "text" &&
                typeof (block as { text?: unknown }).text === "string"
              ) {
                for (const id of extractCasebookDeliveries((block as { text: string }).text)) shownDeliveries.add(id);
              }
            } catch {
              // skip malformed block
            }
          }
        }
      } catch {
        // skip malformed message
      }
    }
    return undefined;
  });

  pi.on("agent_settled", () => {
    const shown = shownDeliveries.size > 0 ? [...shownDeliveries].sort((a, b) => a - b) : undefined;
    shownDeliveries.clear();
    settled(bin, sessionId, shown);
    reportInfo();
  });

  pi.on("session_shutdown", (event) => {
    processSessions().delete(sessionId);
    // The session ends unless pi is only reloading this runtime (the same
    // session starts again at once).
    if (event?.reason !== "reload") sessionEnded(bin, sessionId);
    syncInBackground(bin);
  });
}
