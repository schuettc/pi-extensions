// Canonical session identity (spec §4.1). Pure; no I/O. Precedence:
//   1. hail-owned (@hail_session set)  → today's identity, unchanged
//   2. proj convention (tmux session name "project/work", both parts valid)
//   3. fallback (cwd basename / window name) — never adoptable
import { basename } from "node:path";

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Mirrors Go tmux.ValidName exactly. */
export function validName(s: string): boolean {
  return s !== "." && s !== ".." && NAME_RE.test(s);
}

export interface TmuxFacts {
  inTmux: boolean;
  hailSession?: string;
  sessionName?: string;
  windowName?: string;
  socketPath?: string;
  paneId?: string;
}

export type IdentitySource = "hail" | "proj" | "fallback";

export interface Identity {
  sessionId: string;
  project: string;
  work: string;
  identity: IdentitySource;
}

export function deriveIdentity(f: TmuxFacts, piSessionId: string, cwd: string): Identity {
  const base = basename(cwd);
  if (f.hailSession) {
    return { sessionId: f.hailSession, project: base, work: f.windowName ?? base, identity: "hail" };
  }
  const name = f.inTmux ? f.sessionName : undefined;
  if (name) {
    const parts = name.split("/");
    if (parts.length === 2 && validName(parts[0]) && validName(parts[1])) {
      return { sessionId: piSessionId, project: parts[0], work: parts[1], identity: "proj" };
    }
  }
  return { sessionId: piSessionId, project: base, work: f.windowName ?? base, identity: "fallback" };
}
