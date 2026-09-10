// Presence → status-line copy (spec §4). Maps the daemon's phone presence list
// to exactly the words the person sees in pi's status line. Pure; no I/O.

import type { Phone } from "./protocol.ts";

/**
 * Classify phone presence into the spec's status-line string:
 * any `driving` → "phone is working"; else any `connected` → "phone connected";
 * else (empty list, or all `offline`) → "offline".
 */
export function presenceToStatus(phones: Phone[]): string {
  if (phones.some((p) => p.state === "driving")) return "phone is working";
  if (phones.some((p) => p.state === "connected")) return "phone connected";
  return "offline";
}
