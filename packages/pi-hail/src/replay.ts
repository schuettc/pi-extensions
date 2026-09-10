// Replay-after-reconnect (C4, deliverable 4). Reads pi's own session file
// (JSONL — one JSON entry per line) and returns the entries after the daemon's
// `have` cursor so device sequence numbers stay continuous. The Session wraps
// each returned entry as a live `{ event }` frame, exactly matching live
// forwarding (`send({ event: piEvent })`), so the phone's history has no hole.
//
// Best-effort by contract: a missing, unreadable, or partially-corrupt file
// returns whatever could be parsed (or `[]`) and NEVER throws — replay must
// never block pi.

import { readFileSync } from "node:fs";

/**
 * Read pi's session file and return, IN ORDER, the entries whose 1-based index
 * is greater than `sinceSeq` (i.e. `entries.slice(sinceSeq)`). Each entry is a
 * pi rpc event object; the caller wraps it as `{ event }`.
 *
 * A plain JSONL line read is used deliberately (dependency-light and robust to
 * partial corruption). Never throws.
 */
export function readSessionEvents(sessionFile: string, sinceSeq: number): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    // Missing/unreadable file → nothing to replay, best-effort.
    return [];
  }

  const entries: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a partially-written / corrupt line rather than crashing.
    }
  }

  const from = Number.isFinite(sinceSeq) && sinceSeq > 0 ? sinceSeq : 0;
  return entries.slice(from);
}
