import { appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ttyOfPane, sessionOfPane } from "./tmux.ts";
import type { TmuxContext } from "./tmux.ts";

const ATTN = join(homedir(), ".local", "bin", "claude-attn");
const BEL = String.fromCharCode(7);

// The bell lights tmux's status-left attention banner, the window indicator,
// and Ghostty's tab bell and border. It goes to THIS pane's tty and nowhere
// else: ringing every same-directory session is worse than ringing none.
export function ringBell(
  ctx: TmuxContext,
  deps: {
    tty?: (socket: string, pane: string) => string | undefined;
    append?: (path: string, data: string) => void;
  } = {},
): void {
  const readTty = deps.tty ?? ttyOfPane;
  const write = deps.append ?? ((path: string, data: string) => appendFileSync(path, data));
  try {
    const tty = readTty(ctx.socket, ctx.pane);
    if (!tty) return;
    write(tty, BEL);
  } catch {
    // Best-effort: a bell must not fail a turn.
  }
}

// `claude-attn raise <session>` takes a session directly. raise-pid exists only
// because a Claude Code hook cannot know its own pane and must walk process
// ancestry to find it; we know ours. claude-attn is NOT modified.
export function raiseAttention(
  ctx: TmuxContext,
  deps: {
    session?: (socket: string, pane: string) => string | undefined;
    run?: (cmd: string, args: string[]) => void;
  } = {},
): void {
  const readSession = deps.session ?? sessionOfPane;
  const run =
    deps.run ??
    ((cmd: string, args: string[]) => {
      execFileSync(cmd, args, { stdio: "ignore" });
    });
  try {
    const session = readSession(ctx.socket, ctx.pane);
    if (!session) return;
    run(ATTN, ["raise", session]);
  } catch {
    // Best-effort: an attention flag must not fail a turn.
  }
}
