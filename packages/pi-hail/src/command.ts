// The `/hail` slash command (spec §4.5): show/hide this session on the phone.
// Pure over an injected Session and notifier so it is unit-testable.
import type { Session } from "./session.ts";

const USAGE = "usage: /hail show | hide";

export function runHailCommand(
  args: string,
  session: Session | undefined,
  notify: (msg: string) => void,
): void {
  const action = args.trim().toLowerCase();
  if (action !== "show" && action !== "hide") {
    notify(USAGE);
    return;
  }
  if (!session || !session.requestVisibility(action === "show")) {
    notify("hail: this pi is not connected to the hail daemon.");
    return;
  }
  notify(action === "show" ? "hail: asking to show this session on your phone…" : "hail: hiding this session from your phone…");
}
