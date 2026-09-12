// pi-creel — the request_secret tool.
//
// When the model needs an API key it calls request_secret instead of asking
// the user to paste it into chat. This wiring resolves tmux, opens a
// display-popup running the creel binary, and waits for creel to write a
// status token to a temp file. The captured value goes straight from the popup
// into the target .env; this process — and therefore the model's context —
// only ever sees the token (added / updated / cancelled / error), never the
// value.
//
// The pure pieces (schema, command string, token mapping) live in capture.ts;
// this file is the thin, injectable pi/tmux/fs wiring, in the same split
// pi-wakeup and guardrails use.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, watch } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveTmux, type TmuxContext } from "./tmux.ts";
import {
  REQUEST_SECRET_PARAMS,
  creelCommand,
  tokenToText,
  validName,
} from "./capture.ts";
import { parseEvent, savedMessage } from "./notify.ts";

const POPUP_WIDTH = "64";
const POPUP_HEIGHT = "14";
const TOKEN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 150;

export type WatchHandle = { close: () => void };

export type Deps = {
  resolveTmux?: (env: NodeJS.ProcessEnv) => TmuxContext | undefined;
  creelOnPath?: () => boolean;
  spawnPopup?: (tmux: TmuxContext, command: string) => void;
  waitForToken?: (statusPath: string, timeoutMs: number) => Promise<string | undefined>;
  tmpStatusPath?: () => string;
  resolveSessionId?: (tmux: TmuxContext) => string | undefined;
  homedir?: () => string;
  watch?: (dir: string, cb: (event: string, filename: string | null) => void) => WatchHandle;
  readEventFile?: (path: string) => string;
  eventMtimeMs?: (path: string) => number;
  mkdir?: (dir: string) => void;
};

function defaultCreelOnPath(): boolean {
  try {
    execFileSync("creel", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultSpawnPopup(tmux: TmuxContext, command: string): void {
  // display-popup returns immediately (the popup runs detached on the server),
  // so completion is observed out-of-band via the status file.
  //
  // -d anchors the popup's working directory to this process's cwd — the folder
  // pi was launched in, i.e. the project being worked on. creel resolves a
  // relative --dest (".env") against that cwd, so the key lands in the project's
  // .env. Without -d, tmux opens the popup in $HOME and the .env goes there.
  execFileSync(
    "tmux",
    [
      "-L", tmux.socket,
      "display-popup",
      "-t", tmux.pane,
      "-d", process.cwd(),
      "-E",
      "-w", POPUP_WIDTH,
      "-h", POPUP_HEIGHT,
      "-T", " creel · request_secret ",
      command,
    ],
    { stdio: "ignore" },
  );
}

async function defaultWaitForToken(
  statusPath: string,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(statusPath)) {
      const raw = readFileSync(statusPath, "utf-8");
      // creel writes "<token>\n" in a single write; wait for the newline so we
      // never read a half-written token.
      if (raw.endsWith("\n")) return raw.trim();
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return undefined;
}

function defaultTmpStatusPath(): string {
  return join(tmpdir(), `creel-status-${randomUUID()}`);
}

function reply(text: string) {
  return { content: [{ type: "text", text }] };
}

export function createCreel(pi: any, deps: Deps = {}): void {
  const resolve = deps.resolveTmux ?? resolveTmux;
  const onPath = deps.creelOnPath ?? defaultCreelOnPath;
  const spawn = deps.spawnPopup ?? defaultSpawnPopup;
  const wait = deps.waitForToken ?? defaultWaitForToken;
  const tmpPath = deps.tmpStatusPath ?? defaultTmpStatusPath;

  pi.registerTool({
    name: "request_secret",
    label: "Request Secret",
    description:
      "Capture an API key, token, password, or any secret from the user WITHOUT it entering the chat or your context. Opens a masked tmux popup (the creel tool); the user pastes once and the value is written straight into a local .env (chmod 600). ALWAYS use this instead of asking the user to paste a secret into chat: any time you need a credential, or are about to say 'paste your ... key/token', call request_secret first. You receive only a confirmation (added/updated/cancelled), never the value. Requires a tmux session and the 'creel' binary on PATH.",
    promptSnippet:
      "request_secret(name, dest?) - need ANY secret, API key, token, or password? ALWAYS capture it via this popup instead of asking the user to paste it into chat.",
    parameters: REQUEST_SECRET_PARAMS,
    async execute(_id: string, params: { name?: string; dest?: string }) {
      const name = typeof params?.name === "string" ? params.name : "";
      const dest = typeof params?.dest === "string" && params.dest ? params.dest : ".env";

      if (!validName(name)) {
        return reply(`"${name}" is not a valid environment-variable name; nothing captured.`);
      }

      const tmux = resolve(process.env);
      if (!tmux) {
        return reply(
          "request_secret needs a tmux session and none is attached. Ask the user to paste the key manually, or run pi under tmux.",
        );
      }
      if (!onPath()) {
        return reply(
          "The 'creel' binary was not found on PATH. Install the tackle 'creel' tool, then retry.",
        );
      }

      const statusPath = tmpPath();
      try {
        spawn(tmux, creelCommand(name, dest, statusPath));
        const token = await wait(statusPath, TOKEN_TIMEOUT_MS);
        return reply(tokenToText(token, name, dest));
      } catch (error) {
        return reply(`Failed to run the creel popup: ${String(error)}`);
      } finally {
        try {
          rmSync(statusPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }
    },
  });
}

const EVENTS_SUBDIR = ".pi/agent/creel-events";

// defaultResolveSessionId asks tmux for the id of the session this pi runs in,
// so the watcher reacts only to saves made in THIS session (routing by tmux
// session). Returns undefined outside tmux or on any tmux error.
function defaultResolveSessionId(tmux: TmuxContext): string | undefined {
  try {
    const out = execFileSync(
      "tmux",
      ["-L", tmux.socket, "display-message", "-p", "-t", tmux.pane, "#{session_id}"],
      { stdio: ["ignore", "pipe", "ignore"] },
    ).toString("utf-8");
    const id = out.trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

// startCreelWatch notifies THIS pi session when the user saves a secret via
// creel outside a request_secret call (the tmux keybind runs creel with
// --event-file <dir>/<session>.json). It resolves the session id so a save in
// one session never notifies another (routing by tmux session), watches the
// events dir, and on a NEW event delivers a value-free note - steering a fresh
// turn when idle, queuing after the current turn when busy (mirroring
// pi-wakeup). It is a no-op outside tmux, where there is no keybind to hear.
export function startCreelWatch(pi: any, deps: Deps = {}): void {
  const resolveT = deps.resolveTmux ?? resolveTmux;
  const resolveSid = deps.resolveSessionId ?? defaultResolveSessionId;
  const home = (deps.homedir ?? homedir)();
  const startWatch = deps.watch ?? watch;
  const readEvent = deps.readEventFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const mtimeMs = deps.eventMtimeMs ?? ((p: string) => statSync(p).mtimeMs);
  const ensureDir = deps.mkdir ?? ((d: string) => mkdirSync(d, { recursive: true }));

  const tmux = resolveT(process.env);
  if (!tmux) return;
  const sid = resolveSid(tmux);
  if (!sid) return;

  const dir = join(home, EVENTS_SUBDIR);
  try {
    ensureDir(dir);
  } catch {
    return; // nothing to watch if the dir cannot be made
  }
  const fileName = `${sid}.json`;
  const target = join(dir, fileName);

  let ctx: any;
  pi.on?.("session_start", (_e: unknown, sessionCtx: any) => {
    ctx = sessionCtx;
  });

  // Dedupe by mtime: one write can fire the watcher twice (rename+change), and
  // two saves with identical name/dest/action have identical CONTENT, so mtime
  // - which advances on every write - is the reliable "is this a new save" key.
  let lastMtimeMs = -1;
  const handle = startWatch(dir, (_event: string, changed: string | null) => {
    if (changed !== null && changed !== fileName) return;
    let m: number;
    try {
      m = mtimeMs(target);
    } catch {
      return; // file gone or unreadable
    }
    if (m === lastMtimeMs) return;
    lastMtimeMs = m;
    let raw: string;
    try {
      raw = readEvent(target);
    } catch {
      return;
    }
    const evt = parseEvent(raw);
    if (!evt) return;
    let idle = false;
    try {
      idle = ctx && typeof ctx.isIdle === "function" ? Boolean(ctx.isIdle()) : false;
    } catch {
      idle = false;
    }
    try {
      pi.sendMessage(
        { content: savedMessage(evt), customType: "creel_saved", display: true },
        { triggerTurn: true, deliverAs: idle ? "steer" : "followUp" },
      );
    } catch (error) {
      try {
        pi.appendEntry?.("creel_notify_failed", { error: String(error) });
      } catch {
        // best-effort
      }
    }
  });

  pi.on?.("session_shutdown", () => {
    try {
      handle?.close?.();
    } catch {
      // best-effort
    }
  });
}

export default function (pi: any) {
  createCreel(pi);
  startCreelWatch(pi);
}
