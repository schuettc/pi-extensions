export const SESSION_ID_VAR = "AGENT_SESSION_ID";

// Deliberately does NOT set CLAUDE_CODE_SESSION_ID. Some channel servers
// read that variable to decide whether a session is Claude Code, and a pi
// session must never claim to be one. Servers wanting this session's id
// should read the neutral AGENT_SESSION_ID.
export function applyIdentity(sessionId: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (sessionId === undefined || sessionId === "") {
    delete env[SESSION_ID_VAR];
    return;
  }
  env[SESSION_ID_VAR] = sessionId;
}
