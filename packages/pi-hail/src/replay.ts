// Cursor-based catch-up (streaming spec §4.3). Reads pi's session file (JSONL)
// and returns, IN ORDER, the completed-message events AFTER a cursor position
// (a count of session-file entries), each mapped from a stored
// {"type":"message", message} entry to a {"type":"message_end", message} event.
// Other entry types (session, custom, custom_message, compaction, model_change,
// thinking_level_change, session_info) are skipped. File order is used as-is
// (append-only; parentId branch structure is not reconstructed).
//
// Best-effort by contract: a missing/unreadable/corrupt file returns whatever
// parsed (or []) and never throws.

import { readFileSync } from "node:fs";

export function readSessionEntriesAfter(
  sessionFile: string,
  cursor: number,
): { events: unknown[]; cursor: number } {
  let raw: string;
  try {
    raw = readFileSync(sessionFile, "utf8");
  } catch {
    return { events: [], cursor: 0 };
  }
  const entries: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip a partial/corrupt line.
    }
  }
  const from = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const events: unknown[] = [];
  for (const entry of entries.slice(from)) {
    const e = entry as { type?: string; message?: unknown } | null;
    if (e && e.type === "message" && e.message !== undefined) {
      events.push({ type: "message_end", message: e.message });
    }
  }
  return { events, cursor: entries.length };
}
