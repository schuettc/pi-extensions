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
//
// CRITICAL — replay only the roles that stream LIVE. pi's
// _flushPendingBashMessages (agent-session.js) persists {"type":"message",
// role:"bashExecution"} entries via appendMessage WITHOUT emitting message_end,
// so those never reach a phone through the live stream. If replay resent every
// {"type":"message"} entry, a catch-up would show bash results the live stream
// never sent. So we only replay message entries whose role also streams live
// (user | assistant | toolResult | system) and skip every other entry
// (bashExecution role, custom_message, compaction, …) while it still occupies
// its slice index, keeping cursor = since + i + 1 each emitted entry's true
// position.

export interface ReplayFrame {
  event: { type: "message_end"; message: unknown };
  cursor: number;
}

// Message roles pi streams live via a message_end emit. Kept in lockstep with
// the live-forward rule so replay and live cursors agree for the same entries.
const LIVE_ROLES = new Set(["user", "assistant", "toolResult", "system"]);

export function entriesAfter(entries: unknown[], since: number): ReplayFrame[] {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const frames: ReplayFrame[] = [];
  entries.slice(from).forEach((entry, i) => {
    const e = entry as { type?: string; message?: { role?: string } } | null;
    if (e && e.type === "message" && e.message !== undefined) {
      const role = e.message?.role;
      if (role !== undefined && LIVE_ROLES.has(role)) {
        frames.push({ event: { type: "message_end", message: e.message }, cursor: from + i + 1 });
      }
    }
  });
  return frames;
}
