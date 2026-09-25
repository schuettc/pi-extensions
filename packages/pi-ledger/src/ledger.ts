/**
 * Fire-and-forget calls into the ledger binary. Nothing here throws, blocks a
 * turn, or prints: a missing or failing ledger just means nothing is recorded.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The ledger binary: $LEDGER_BIN, else ~/.local/bin/ledger. */
export function ledgerBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.LEDGER_BIN || join(homedir(), ".local", "bin", "ledger");
}

/** True when the binary exists (the extension stays inert otherwise). */
export function installed(bin: string): boolean {
  return existsSync(bin);
}

/** Cheap prefilter: does the command invoke git or gh as a word? */
export function mentionsGit(command: string): boolean {
  return /(^|[\s;&|(/])(git|gh)(\s|$)/.test(command);
}

/** The `ledger record --harness pi` payload. */
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

/** Start `ledger sync --no-github` detached. */
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
