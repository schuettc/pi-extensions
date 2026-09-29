import { isAbsolute, relative, resolve, sep } from "node:path";
// Pure pieces of the request_secret tool: parameter schema, env-var name
// validation, the popup command string, and the status-token -> reply mapping.
// None of these ever see the captured value — creel writes it straight to the
// .env, and this layer only ever handles a name, a destination, and a token.

export const REQUEST_SECRET_PARAMS = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "The environment-variable name to store the secret under, e.g. OPENAI_API_KEY.",
    },
    dest: {
      type: "string",
      description:
        "Path to the .env file to write. Must be inside the working directory (relative, e.g. .env or .worktrees/<name>/.env); creel refuses anything outside it. Defaults to .env.",
    },
  },
  required: ["name"],
} as const;

// ValidName mirrors the Go creel.ValidName: a legal env-var name.
export function validName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// creelCommand is the sh command tmux display-popup runs. name/dest/status are
// single-quoted; the popup's creel writes the value to dest and the token to
// status.
export function creelCommand(name: string, dest: string, statusFile: string): string {
  return `creel ${shq(name)} --dest ${shq(dest)} --status-file ${shq(statusFile)}`;
}

// tokenToText maps creel's status token to the reply the model sees. It never
// includes the secret — only the outcome.
// destInsideCwd mirrors creel's own rule (ResolveDest): an agent-chosen dest
// resolves against the working directory and may not leave it. Checked here
// too, so a refused path never opens a popup the user then sees fail.
export function destInsideCwd(cwd: string, dest: string): boolean {
  const rel = relative(cwd, resolve(cwd, dest));
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// outsideCwdText is the reply for a dest outside the working directory: the
// rule, and a path that works.
export function outsideCwdText(name: string, cwd: string): string {
  return (
    `Could not store ${name}: dest must be inside the working directory (${cwd}), ` +
    "so a secret only lands where this project keeps its own files. Use a path under it, " +
    "e.g. .env, or .worktrees/<name>/.env for scratch work; nothing was written."
  );
}

export function tokenToText(
  token: string | undefined,
  name: string,
  dest: string,
  cwd: string = process.cwd(),
): string {
  if (token === undefined || token === "") {
    return `Timed out waiting for the creel popup; nothing was recorded for ${name}.`;
  }
  // howToUse tells the model the two supported ways to consume a mid-session
  // secret without ever handling the value itself. It must never suggest
  // reading the .env directly (the value must not enter the harness/context).
  const howToUse =
    ` The value was not shown here. To use it, run \`creel exec ${name} -- <command>\`` +
    ` (that puts ${name} in the command's environment only), or read \`process.env.${name}\`` +
    ` after a relaunch. Do not read ${dest} yourself.`;
  switch (token) {
    case "added":
      return `Added ${name} to ${dest} (chmod 600).` + howToUse;
    case "updated":
      return `Updated ${name} in ${dest}.` + howToUse;
    case "cancelled":
      return `Capture cancelled; nothing was written for ${name}.`;
    default:
      if (token === "error:dest-outside-cwd") return outsideCwdText(name, cwd);
      if (token.startsWith("error:")) {
        return `Could not store ${name}: ${token.slice("error:".length)}.`;
      }
      return `Capture finished with an unexpected status (${token}).`;
  }
}
