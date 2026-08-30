import { readFileSync } from "node:fs";
import { join } from "node:path";

// The public package ships NO baked-in rules — the policy prose is read from
// config at runtime (see loadProse). The header text is fixed so that a config
// carrying the real rules reproduces the historical output byte-for-byte.
const POLICY_HEADER =
  "Harness policy — earned rules from operating this harness, not permission settings:";

// Append the harness policy to the system prompt. Empty prose is a no-op: the
// system prompt is returned unchanged, so a rig with no configured rules gets
// exactly the prompt it started with.
export function appendPolicy(systemPrompt: string, prose: string[]): string {
  if (!Array.isArray(prose) || prose.length === 0) return systemPrompt;
  const policy = `${POLICY_HEADER}\n${prose.join("\n")}`;
  return systemPrompt ? `${systemPrompt}\n\n${policy}` : policy;
}

// Best-effort loader for the extension's private policy prose. Reads
// <home>/.pi/agent/extensions/pi-guardrails/config.json and returns its
// `prose` string[] field; a missing/unreadable/malformed file, or a missing
// or non-array `prose` field, yields [] — this must never throw.
export function loadProse({ home }: { home: string }): string[] {
  let raw: string;
  try {
    raw = readFileSync(
      join(home, ".pi", "agent", "extensions", "pi-guardrails", "config.json"),
      "utf-8",
    );
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const prose = (parsed as { prose?: unknown }).prose;
  if (!Array.isArray(prose)) return [];
  return prose.filter((p): p is string => typeof p === "string");
}
