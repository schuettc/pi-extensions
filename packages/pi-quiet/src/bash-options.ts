import type { BashSpawnContext, BashToolOptions } from "@earendil-works/pi-coding-agent";

export const SESSION_ID_VAR = "AGENT_SESSION_ID";

// The two pi settings the built-in bash tool is constructed with. pi's own
// SettingsManager satisfies this; tests pass a literal.
export type ShellSettings = {
  getShellCommandPrefix(): string | undefined;
  getShellPath(): string | undefined;
};

// Stamps the harness-neutral session id on every command from pi's own
// per-command PI_SESSION_ID, which pi injects into `context.env` before the
// hook runs. Per command, from pi's live session manager, never from
// process.env: an in-process child session (pi-subagents) can write
// process.env, but it cannot change what pi puts here for THIS command.
// When pi did not expose a session (exposeSessionEnvironment: false), an
// inherited value is removed rather than passed through — a command never
// carries an identity that is not its session's.
export function identitySpawnHook(context: BashSpawnContext): BashSpawnContext {
  const env: NodeJS.ProcessEnv = { ...context.env };
  const id = env.PI_SESSION_ID;
  if (id === undefined || id === "") delete env[SESSION_ID_VAR];
  else env[SESSION_ID_VAR] = id;
  return { ...context, env };
}

// Options for createBashToolDefinition that match what pi itself passes to
// the built-in (settings.shellCommandPrefix and settings.shellPath) plus the
// identity hook. Unset settings are omitted so pi's defaults apply.
export function buildBashOptions(settings: ShellSettings): BashToolOptions {
  const commandPrefix = settings.getShellCommandPrefix();
  const shellPath = settings.getShellPath();
  return {
    ...(commandPrefix !== undefined ? { commandPrefix } : {}),
    ...(shellPath !== undefined ? { shellPath } : {}),
    spawnHook: identitySpawnHook,
  };
}
