// Pure pieces of the creel-save notifier: the value-free event shape, its
// parser, and the note the agent receives. None of these ever see the secret
// value; creel writes only {name, dest, action} to its --event-file, and this
// code refuses anything carrying a value field.

export type CreelEvent = { name: string; dest: string; action: "added" | "updated" };

// A legal environment-variable name, mirroring creel's own ValidName.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// parseEvent reads a creel --event-file payload and returns a CreelEvent only
// when it is well-formed: a valid env-var name, a non-empty dest, an
// added/updated action, and crucially NO value field. Anything else (bad JSON,
// missing fields, or a stray value) returns undefined and is ignored, so a
// malformed or tampered file can never push a secret into the agent.
export function parseEvent(raw: string): CreelEvent | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== "object" || obj === null) return undefined;
  const rec = obj as Record<string, unknown>;
  if ("value" in rec) return undefined; // creel never writes one; refuse if present
  const name = typeof rec.name === "string" ? rec.name : "";
  const dest = typeof rec.dest === "string" ? rec.dest : "";
  const action = rec.action === "added" || rec.action === "updated" ? rec.action : "";
  if (!NAME_RE.test(name) || dest === "" || action === "") return undefined;
  return { name, dest, action };
}

// savedMessage is the note the agent receives when the user saves a secret via
// creel OUTSIDE a request_secret call (the tmux keybind). It names what was
// captured and where, tells the agent how to reference it, and never carries
// the value.
export function savedMessage(e: CreelEvent): string {
  return (
    `The user just ${e.action} the secret \`${e.name}\` in \`${e.dest}\` using creel. ` +
    `The value went straight into that file and is not shown here: reference it as ` +
    `\`process.env.${e.name}\` (or have your program read \`${e.dest}\` at runtime), and do not ` +
    `try to read the .env yourself. No action is needed unless you were waiting on this key.`
  );
}
