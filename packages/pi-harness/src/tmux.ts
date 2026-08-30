import { execFileSync } from "node:child_process";

export type TmuxContext = {
  socket: string;
  pane: string;
};

// $TMUX is "<socket-path>,<pid>,<session>". The socket NAME is the basename of
// the first field — the full path would put slashes into the state-file key,
// and the bare pane id would collide across servers, since pane ids are only
// unique per server and this machine runs one socket per project.
export function resolveTmux(env: NodeJS.ProcessEnv = process.env): TmuxContext | undefined {
  const tmuxEnv = env.TMUX;
  const pane = env.TMUX_PANE;
  if (!tmuxEnv || !pane) return undefined;
  const socketPath = tmuxEnv.split(",")[0];
  if (!socketPath) return undefined;
  const socket = socketPath.slice(socketPath.lastIndexOf("/") + 1);
  if (!socket) return undefined;
  return { socket, pane };
}

// Every tmux call is best-effort: a harness handler must never fail a session
// start, a turn, or a shutdown because the terminal did something unexpected.
export function tmux(socket: string, args: string[]): string | undefined {
  try {
    return execFileSync("tmux", ["-L", socket, ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

// The tmux SESSION name for a pane. @harness_session is a session option, not a
// pane one, because the consumer is a sibling pane (`scratch`) which cannot
// read the agent's environment.
export function sessionOfPane(socket: string, pane: string): string | undefined {
  const name = tmux(socket, ["display-message", "-p", "-t", pane, "#{session_name}"]);
  return name === "" ? undefined : name;
}

// The pane's tty, for the bell.
export function ttyOfPane(socket: string, pane: string): string | undefined {
  const tty = tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_tty}"]);
  return tty === "" ? undefined : tty;
}
