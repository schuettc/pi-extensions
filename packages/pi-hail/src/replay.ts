// Cursor-based catch-up (streaming spec §4.3). The cursor unit is an index into
// pi's IN-MEMORY entry list (sessionManager.getEntries(), which excludes the
// "session" header). We deliberately do NOT read pi's session FILE: at
// message_end extensions run BEFORE sessionManager.appendMessage persists the
// entry, and the file itself is written lazily (nothing until the first
// assistant message), so a file-line count is one short and unreliable early.
//
// entriesAfter is a PURE helper: given the entry array and a `since` cursor it
// returns, IN ORDER, the completed-message events AFTER that position — each
// stored {"type":"message", message} entry mapped to a
// {"type":"message_end", message} event and tagged with its ABSOLUTE 1-based
// cursor (since + i + 1, where i is the entry's index within the slice). Other
// entry types (custom, custom_message, compaction, model_change,
// thinking_level_change, session_info, …) are skipped but still consume a slice
// position, so cursors stay stable across replays.

export interface ReplayFrame {
  event: { type: "message_end"; message: unknown };
  cursor: number;
}

export function entriesAfter(entries: unknown[], since: number): ReplayFrame[] {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const frames: ReplayFrame[] = [];
  entries.slice(from).forEach((entry, i) => {
    const e = entry as { type?: string; message?: unknown } | null;
    if (e && e.type === "message" && e.message !== undefined) {
      frames.push({ event: { type: "message_end", message: e.message }, cursor: from + i + 1 });
    }
  });
  return frames;
}
