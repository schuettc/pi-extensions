// The `/hail` slash command (streaming spec §4.5): connect/disconnect this
// session on the phone. Pure over an injected Session and notifier so it is
// unit-testable.
import type { Session } from "./session.ts";

const USAGE = "usage: /hail connect | disconnect";

export function runHailCommand(
  args: string,
  session: Session | undefined,
  notify: (msg: string) => void,
): void {
  const action = args.trim().toLowerCase();
  if (action !== "connect" && action !== "disconnect") {
    notify(USAGE);
    return;
  }
  if (!session || !session.requestConnection(action === "connect")) {
    notify("hail: this pi is not connected to the hail daemon.");
    return;
  }
  notify(
    action === "connect"
      ? "hail: connecting this session to your phone…"
      : "hail: disconnecting this session from your phone…",
  );
}
