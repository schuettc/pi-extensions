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
 *
 * Inert when the casebook binary is missing. Never blocks, throws or prints.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { brief, installed, casebookBin, mentionsGit, record, syncInBackground } from "./casebook.ts";

export default function casebook(pi: ExtensionAPI) {
  const bin = casebookBin();
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
    return { message: { customType: "casebook-brief", content: text, display: false } };
  });

  pi.on("session_shutdown", () => syncInBackground(bin));
}
