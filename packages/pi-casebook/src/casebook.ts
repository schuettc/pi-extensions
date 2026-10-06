/**
 * Fire-and-forget calls into the casebook binary. Nothing here throws, blocks a
 * turn, or prints: a missing or failing casebook just means nothing is recorded.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The casebook binary: $CASEBOOK_BIN, else ~/.local/bin/casebook. */
export function casebookBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.CASEBOOK_BIN || join(homedir(), ".local", "bin", "casebook");
}

/** True when the binary exists (the extension stays inert otherwise). */
export function installed(bin: string): boolean {
  return existsSync(bin);
}

/** Cheap prefilter: does the command invoke git or gh as a word? */
export function mentionsGit(command: string): boolean {
  return /(^|[\s;&|(/])(git|gh)(\s|$)/.test(command);
}

/** The `casebook record --harness pi` payload. */
export function recordPayload(command: string, cwd: string): string {
  return JSON.stringify({ command, cwd });
}

/**
 * The child's environment: the pi session id as AGENT_SESSION_ID (pi sets it
 * per command, never in this process), and no Claude or child-marker
 * variables that could claim the action for another session.
 */
export function childEnv(base: NodeJS.ProcessEnv, sessionId: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.AGENT_SESSION_CHILD;
  if (sessionId) env.AGENT_SESSION_ID = sessionId;
  else delete env.AGENT_SESSION_ID;
  return env;
}

/** Journal one bash command. */
export function record(bin: string, command: string, cwd: string, sessionId: string): void {
  try {
    const child = spawn(bin, ["record", "--harness", "pi"], {
      stdio: ["pipe", "ignore", "ignore"],
      env: childEnv(process.env, sessionId),
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(recordPayload(command, cwd));
    child.unref();
  } catch {
    // never fail the session
  }
}

/** Tell casebook serve this session's turn ended (`casebook settled`), so page
 * messages queued behind the turn go out. Fire-and-forget.
 * Pass shownIds (sorted delivery numbers) to report which deliveries the agent
 * was actually shown this run; omit to report without --shown. */
export function settled(bin: string, sessionId: string, shownIds?: number[]): void {
  if (!sessionId) return;
  try {
    const args = ["settled", "--session", sessionId];
    if (shownIds && shownIds.length > 0) args.push("--shown", shownIds.join(","));
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // never fail the session
  }
}

/**
 * Extract casebook delivery IDs from text containing <channel ...> tags.
 * Returns the numeric delivery values from tags with source="casebook".
 * Never throws.
 */
export function extractCasebookDeliveries(text: string): number[] {
  const result: number[] = [];
  // Match opening channel tags (may span attributes across the tag)
  const tagRe = /<channel\s[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(text)) !== null) {
    const tag = m[0];
    if (!tag.includes('source="casebook"')) continue;
    const dm = /\bdelivery="(\d+)"/.exec(tag);
    if (dm) result.push(Number(dm[1]));
  }
  return result;
}

/**
 * What casebook serve is told about a pi session beyond the channel's
 * presence: its name (pi's session name; "" when it has none) and whether
 * pi marks it a child session. pid is pi's own process: the channel reports
 * the same one (its parent), and pi-subagents runs worker sessions inside
 * the parent's pi process, so serve calls a child that shares a live
 * session's process a worker. A fork also names a parentSession, but runs
 * in a pi process of its own, so it stays a top-level session.
 */
export interface SessionFacts {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  child: boolean;
}

/** The slice of pi's ReadonlySessionManager sessionFacts reads. */
export interface SessionSource {
  getSessionId(): string;
  getSessionName?(): string | undefined;
  getSessionFile?(): string | undefined;
  getHeader?(): { parentSession?: string } | null;
}

/**
 * The session's facts, or undefined when pi's session manager can't say.
 * child: pi-subagents writes parentSession into a persisted worker's header,
 * and an in-memory worker has no session file at all.
 */
export function sessionFacts(sm: SessionSource | undefined, cwd: string, pid: number = process.pid): SessionFacts | undefined {
  try {
    if (!sm) return undefined;
    const id = String(sm.getSessionId?.() ?? "");
    if (!id) return undefined;
    const name = String(sm.getSessionName?.() ?? "");
    const file = sm.getSessionFile?.();
    const parent = sm.getHeader?.()?.parentSession;
    return { id, name, cwd, pid, child: !!parent || !file };
  } catch {
    return undefined;
  }
}

/** The `casebook session-info` command line for facts. */
export function sessionInfoArgs(f: SessionFacts): string[] {
  const args = ["session-info", "--harness", "pi", "--session", f.id, "--name", f.name, "--cwd", f.cwd, "--pid", String(f.pid)];
  if (f.child) args.push("--child");
  return args;
}

/** Tell casebook serve a session's name and child mark. Fire-and-forget;
 * casebook never starts serve for it. */
export function sessionInfo(bin: string, facts: SessionFacts | undefined): void {
  if (!facts) return;
  try {
    const child = spawn(bin, sessionInfoArgs(facts), { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // never fail the session
  }
}

/** Start `casebook sync --no-github` detached. */
export function syncInBackground(bin: string): void {
  try {
    const child = spawn(bin, ["sync", "--no-github"], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // never fail the session
  }
}

/** The repo briefing for cwd, or "" on any failure or after timeoutMs. */
export function brief(bin: string, cwd: string, timeoutMs = 2000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile(bin, ["brief", "--cwd", cwd], { timeout: timeoutMs }, (err, stdout) => {
        resolve(err ? "" : String(stdout));
      });
    } catch {
      resolve("");
    }
  });
}
