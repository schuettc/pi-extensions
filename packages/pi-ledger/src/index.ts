/**
 * pi-ledger: connects a pi session to ledger (tackle.tools).
 *
 *  - bash tool calls that invoke git or gh are journaled with this pi session
 *    (`ledger record --harness pi`); ledger keeps verbs and targets, never the
 *    command line.
 *  - the first turn of a session gets the repo briefing (`ledger brief`) as a
 *    hidden context message.
 *  - session start and shutdown run `ledger sync --no-github` in the
 *    background; the 30-minute launchd job does the GitHub refresh.
 *
 * Inert when the ledger binary is missing. Never blocks, throws or prints.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brief, installed, ledgerBin, mentionsGit, record, syncInBackground } from "./ledger.ts";

export default function ledger(pi: ExtensionAPI) {
  const bin = ledgerBin();
  if (!installed(bin)) return;
  let cwd = process.cwd();
  let sessionId = "";
  let briefed = false;

  pi.on("session_start", (event, ctx) => {
    cwd = ctx.cwd ?? process.cwd();
    sessionId = String(ctx.sessionManager?.getSessionId?.() ?? "");
    briefed = false;
    if (event.reason !== "reload") syncInBackground(bin);
  });

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
    return { message: { customType: "ledger-brief", content: text, display: false } };
  });

  pi.on("session_shutdown", () => syncInBackground(bin));
}
