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
        "Path to the .env file to write, relative to the working directory. Defaults to .env.",
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
export function tokenToText(
  token: string | undefined,
  name: string,
  dest: string,
): string {
  if (token === undefined || token === "") {
    return `Timed out waiting for the creel popup; nothing was recorded for ${name}.`;
  }
  switch (token) {
    case "added":
      return `Added ${name} to ${dest} (chmod 600). The value was not shown here.`;
    case "updated":
      return `Updated ${name} in ${dest}. The value was not shown here.`;
    case "cancelled":
      return `Capture cancelled; nothing was written for ${name}.`;
    default:
      if (token.startsWith("error:")) {
        return `Could not store ${name}: ${token.slice("error:".length)}.`;
      }
      return `Capture finished with an unexpected status (${token}).`;
  }
}
