// pi-auto-reload: reload a pi session automatically, when it is idle, after
// the installed pi packages change on disk (for example after `kempt update`
// or `pi update`). A running session keeps the code it loaded at startup but
// resolves anything it loads later from the new files, so after an in-place
// update it can run a mix of old and new code until it reloads.
//
// pi exposes reload() only on a slash command's context. So the extension
// registers a hidden command and invokes it through sendUserMessage with
// expandPromptTemplates: pi runs extension commands directly (no model turn,
// no `input` event) and hands the handler a command context with reload().
// In the TUI that is the same code path as typing /reload, which refuses while
// a response is streaming or compacting.
//
// It also watches the executables of the channel servers channels.tools
// spawns (casebook, muster, ...). channels.tools starts them once per session,
// so after their binaries are upgraded a session keeps running the old ones;
// a reload closes them and starts fresh ones from the new binaries.
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RELOAD_COMMAND = "auto-reload-now";
const STATUS_KEY = "auto-reload";

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env.PI_CODING_AGENT_DIR ?? join(home, ".pi", "agent");
}

/** npm:@scope/name@1.2.3 -> @scope/name ; npm:name -> name. */
export function npmPackageName(spec: string): string | undefined {
  if (!spec.startsWith("npm:")) return undefined;
  const rest = spec.slice(4);
  const at = rest.lastIndexOf("@");
  return at > 0 ? rest.slice(0, at) : rest;
}

// A fingerprint of what pi would load: the settings.json package list plus
// the version and mtime of each installed npm package, and any extra files.
// A different fingerprint means this session is running stale code.
export function packagesFingerprint(agentDir: string, extraFiles: readonly string[] = []): string {
  const parts: string[] = [];
  let packages: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as { packages?: unknown };
    packages = Array.isArray(settings.packages) ? settings.packages.map(String) : [];
  } catch {
    parts.push("settings:unreadable");
  }
  parts.push(`packages:${JSON.stringify(packages)}`);
  for (const spec of packages) {
    const name = npmPackageName(spec);
    if (!name) continue;
    const file = join(agentDir, "npm", "node_modules", name, "package.json");
    try {
      const version = (JSON.parse(readFileSync(file, "utf8")) as { version?: unknown }).version;
      parts.push(`${name}@${String(version)}:${statSync(file).mtimeMs}`);
    } catch {
      parts.push(`${name}:missing`);
    }
  }
  for (const file of extraFiles) {
    try { parts.push(`${file}:${statSync(file).mtimeMs}`); } catch { parts.push(`${file}:missing`); }
  }
  return parts.join("\n");
}

function readChannelServers(file: string): Record<string, { command: string; cwd?: string }> {
  try {
    const servers = (JSON.parse(readFileSync(file, "utf8")) as { channelServers?: unknown }).channelServers;
    if (typeof servers !== "object" || servers === null) return {};
    const out: Record<string, { command: string; cwd?: string }> = {};
    for (const [name, def] of Object.entries(servers as Record<string, { command?: unknown; cwd?: unknown }>)) {
      if (typeof def?.command !== "string" || def.command === "") continue;
      out[name] = { command: def.command, ...(typeof def.cwd === "string" ? { cwd: def.cwd } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

// The executable each configured channel server runs, resolved the way
// spawn() resolves it: a bare name is looked up on PATH, a path is taken
// relative to the server's cwd. Reads the same two files as channels.tools'
// loadChannelConfig, with the project file overriding the global one by name.
// A command that resolves to nothing is skipped; once it is installed, the
// list itself changes.
export function channelServerExecutables(opts: { home: string; cwd: string; path: string }): string[] {
  const servers = {
    ...readChannelServers(join(opts.home, ".pi", "agent", "channels.json")),
    ...readChannelServers(join(opts.cwd, ".pi", "channels.json")),
  };
  const found: string[] = [];
  for (const def of Object.values(servers)) {
    if (def.command.includes("/")) {
      const file = isAbsolute(def.command) ? def.command : resolve(opts.cwd, def.cwd ?? "", def.command);
      if (isExecutable(file)) found.push(file);
      continue;
    }
    const file = opts.path.split(delimiter).filter(Boolean).map((dir) => join(dir, def.command)).find(isExecutable);
    if (file) found.push(file);
  }
  return found;
}

export interface AutoReloadDeps {
  fingerprint?: () => string;
  pollMs?: number;
  setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
  clearInterval?: (handle: unknown) => void;
}

export function createAutoReload(pi: ExtensionAPI, deps: AutoReloadDeps = {}): void {
  // PI_AUTO_RELOAD_EXTRA: extra files to watch (comma-separated). Touching one
  // triggers a reload, which makes the behavior easy to test.
  const extra = (process.env.PI_AUTO_RELOAD_EXTRA ?? "").split(",").filter(Boolean);
  const agentDir = resolveAgentDir();
  let cwd = process.cwd();
  const fingerprint = deps.fingerprint ?? (() => packagesFingerprint(agentDir, [
    ...extra,
    ...channelServerExecutables({ home: homedir(), cwd, path: process.env.PATH ?? "" }),
  ]));
  const pollMs = deps.pollMs ?? 15_000;
  const every = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const stop = deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let baseline: string | undefined;
  let pending = false;
  let triggered = false;
  let promptOpen = false;
  let timer: unknown;
  let ctxRef: ExtensionContext | undefined;

  const tryReload = (): void => {
    const ctx = ctxRef;
    if (!pending || triggered || promptOpen || !ctx) return;
    try {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
    } catch {
      return; // stale context: the session was already replaced
    }
    triggered = true;
    pi.sendUserMessage(`/${RELOAD_COMMAND}`, { expandPromptTemplates: true } as never);
  };

  const check = (): void => {
    if (baseline === undefined || pending) return;
    let current: string;
    try { current = fingerprint(); } catch { return; }
    if (current === baseline) return;
    pending = true;
    try { ctxRef?.ui.setStatus(STATUS_KEY, "update installed · reloading when idle"); } catch { /* stale */ }
  };

  const tick = (): void => { check(); tryReload(); };

  pi.registerCommand(RELOAD_COMMAND, {
    description: "Reload this session now (pi-auto-reload uses this after package updates)",
    handler: async (_args, ctx) => {
      await ctx.reload();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    cwd = ctx.cwd ?? cwd;
    try { baseline = fingerprint(); } catch { baseline = undefined; }
    pending = false;
    triggered = false;
    promptOpen = false;
    if (timer === undefined) {
      const handle = every(tick, pollMs);
      handle.unref?.();
      timer = handle;
    }
  });
  pi.on("agent_settled", () => { tick(); });
  pi.on("ui_prompt_start", () => { promptOpen = true; });
  pi.on("ui_prompt_end", () => { promptOpen = false; tryReload(); });
  pi.on("session_shutdown", () => {
    if (timer !== undefined) stop(timer);
    timer = undefined;
    ctxRef = undefined;
  });
}

export default function (pi: ExtensionAPI): void { createAutoReload(pi); }
