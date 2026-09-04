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
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const POPUP_WIDTH = "64";
const POPUP_HEIGHT = "14";
const TOKEN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 150;

export type Deps = {
  resolveTmux?: (env: NodeJS.ProcessEnv) => TmuxContext | undefined;
  creelOnPath?: () => boolean;
  spawnPopup?: (tmux: TmuxContext, command: string) => void;
  waitForToken?: (statusPath: string, timeoutMs: number) => Promise<string | undefined>;
  tmpStatusPath?: () => string;
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
  execFileSync(
    "tmux",
    [
      "-L", tmux.socket,
      "display-popup",
      "-t", tmux.pane,
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
      "Capture an API key or secret from the user without it entering the chat. Opens a masked tmux popup (the creel tool); the user pastes once and the value is written straight into a local .env. Call this whenever you would otherwise ask the user to paste a key — you receive only a confirmation (added/updated), never the value. Requires a tmux session and the 'creel' binary on PATH.",
    promptSnippet:
      "request_secret(name, dest?) — need an API key/secret? Capture it into a .env via a popup instead of asking the user to paste it into chat.",
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

export default function (pi: any) {
  createCreel(pi);
}
