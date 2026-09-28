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
