export const SESSION_ID_VAR = "AGENT_SESSION_ID";

// The environment a channel server is spawned with. A NEW object every time:
// identity is handed to the child at spawn and nowhere else. This module used
// to write AGENT_SESSION_ID into process.env, and pi-subagents runs child
// sessions inside the parent's process, so a child's session_start overwrote
// the parent's value for every later spawn and every bash command. Nothing
// here may write to `base`.
//
// Deliberately does NOT set CLAUDE_CODE_SESSION_ID. Some channel servers
// read that variable to decide whether a session is Claude Code, and a pi
// session must never claim to be one. An inherited AGENT_SESSION_ID (pi
// running inside another agent) is replaced by this session's id, or removed
// when there is none — a child never inherits an identity that is not its
// spawner's.
export function spawnEnv(
  base: NodeJS.ProcessEnv,
  sessionId: string | undefined,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (sessionId === undefined || sessionId === "") delete env[SESSION_ID_VAR];
  else env[SESSION_ID_VAR] = sessionId;
  return { ...env, ...extra };
}
