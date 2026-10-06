/**
 * Fire-and-forget calls into the casebook binary. Nothing here throws, blocks a
 * turn, or prints: a missing or failing casebook just means nothing is recorded.
 */
import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

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
 * presence: its name (pi's session name; "" when it has none) and its parent
 * session (the session it was started from; "" for none). pid is pi's own
 * process: the channel reports the same one (its parent). serve calls a
 * session a worker only while its parent is live in the same pi process:
 * pi-subagents runs its workers inside the parent's pi process, while a
 * fork's parent runs in another pi process (a fork started as a pi process
 * of its own) or has ended
 * (an in-process `/fork` replaces it, and this extension reports it ended).
 * So a fork, even one running subagents of its own, stays a session Court
 * can choose; its subagents don't.
 */
export interface SessionFacts {
  id: string;
  name: string;
  cwd: string;
  pid: number;
  parent: string;
}

/** The slice of pi's ReadonlySessionManager sessionFacts reads. */
export interface SessionSource {
  getSessionId(): string;
  getSessionName?(): string | undefined;
  getSessionFile?(): string | undefined;
  getHeader?(): { parentSession?: string } | null;
}

/**
 * The sessions running in this pi process, in the order they started: each
 * session's runtime registers itself at session_start and leaves at
 * session_shutdown. root: it has no parent. One map per process (pi loads
 * this extension once per session; globalThis is shared by all of them).
 */
export type ProcessSessions = Map<string, { root: boolean }>;

const processKey = Symbol.for("pi-casebook.process-sessions");
export function processSessions(): ProcessSessions {
  const g = globalThis as unknown as Record<symbol, ProcessSessions | undefined>;
  return (g[processKey] ??= new Map());
}

/**
 * Records a session in this process's registry, once. The first session
 * registered while no root is live is the process's root: the session pi
 * runs at top level. A fork names a parent in its header, yet it is still the
 * root of its own process, so in-memory subagents it spawns find it.
 */
export function registerSession(procs: ProcessSessions, id: string): void {
  if (procs.has(id)) return;
  const rootLive = [...procs.values()].some((s) => s.root);
  procs.set(id, { root: !rootLive });
}

/**
 * The session id a pi session file belongs to: pi names files
 * `<timestamp>_<id>.jsonl` (the timestamp has no underscore); a file named
 * otherwise is read for its header's id. "" when neither says.
 */
export function sessionIdFromFile(file: string | undefined): string {
  try {
    if (!file) return "";
    const m = /^[^_]+_(.+)\.jsonl$/.exec(basename(file));
    if (m) return m[1];
    const fd = openSync(file, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
      const header = JSON.parse(first) as { type?: unknown; id?: unknown };
      return header.type === "session" && typeof header.id === "string" ? header.id : "";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * The session's facts, or undefined when pi's session manager can't say.
 * parent: the session named by the header's parentSession (pi-subagents
 * writes the parent's file there; a fork names the session it forked). A
 * pi-subagents worker kept in memory (no session file) has no header
 * parent: it runs under the first root session in this process. A session
 * with a file and no parentSession is a root.
 */
export function sessionFacts(
  sm: SessionSource | undefined,
  cwd: string,
  pid: number = process.pid,
  procs: ProcessSessions = processSessions(),
): SessionFacts | undefined {
  try {
    if (!sm) return undefined;
    const id = String(sm.getSessionId?.() ?? "");
    if (!id) return undefined;
    const name = String(sm.getSessionName?.() ?? "");
    let parent = sessionIdFromFile(sm.getHeader?.()?.parentSession);
    if (!parent && !sm.getSessionFile?.()) {
      for (const [other, s] of procs) {
        if (other !== id && s.root) {
          parent = other;
          break;
        }
      }
    }
    return { id, name, cwd, pid, parent };
  } catch {
    return undefined;
  }
}

/** The `casebook session-info` command line for facts. */
export function sessionInfoArgs(f: SessionFacts): string[] {
  const args = ["session-info", "--harness", "pi", "--session", f.id, "--name", f.name, "--cwd", f.cwd, "--pid", String(f.pid)];
  if (f.parent) args.push("--parent", f.parent);
  return args;
}

/** The `casebook session-info` command line that says a session ended. */
export function sessionEndedArgs(id: string): string[] {
  return ["session-info", "--harness", "pi", "--session", id, "--ended"];
}

function spawnQuiet(bin: string, args: string[]): void {
  try {
    const child = spawn(bin, args, { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // never fail the session
  }
}

/** Tell casebook serve a session's name and parent. Fire-and-forget;
 * casebook never starts serve for it. */
export function sessionInfo(bin: string, facts: SessionFacts | undefined): void {
  if (facts) spawnQuiet(bin, sessionInfoArgs(facts));
}

/** Tell casebook serve a session ended (pi replaced it, or quit), so it
 * stops counting as here at once. Fire-and-forget. */
export function sessionEnded(bin: string, id: string): void {
  if (id) spawnQuiet(bin, sessionEndedArgs(id));
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
