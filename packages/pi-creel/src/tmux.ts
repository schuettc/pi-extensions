// tmux context resolution, mirrored from pi-harness. Duplicated rather than
// cross-imported so pi-creel stays a standalone package (the same choice the
// other packages in this monorepo make).

export type TmuxContext = {
  socket: string;
  pane: string;
};

// $TMUX is "<socket-path>,<pid>,<session>". The socket NAME is the basename of
// the first field; tmux is addressed as `tmux -L <name>`.
export function resolveTmux(
  env: NodeJS.ProcessEnv = process.env,
): TmuxContext | undefined {
  const tmuxEnv = env.TMUX;
  const pane = env.TMUX_PANE;
  if (!tmuxEnv || !pane) return undefined;
  const socketPath = tmuxEnv.split(",")[0];
  if (!socketPath) return undefined;
  const socket = socketPath.slice(socketPath.lastIndexOf("/") + 1);
  if (!socket) return undefined;
  return { socket, pane };
}
