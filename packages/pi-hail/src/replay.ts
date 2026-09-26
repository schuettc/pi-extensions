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
// (user | assistant | toolResult | system) and skip every non-live entry
// (bashExecution role, compaction, …) while it still occupies its slice index,
// keeping cursor = since + i + 1 each emitted entry's true position.
//
// The "custom" role is special: pi emits a LIVE message_end for it
// (agent-session.js), then persists it via appendCustomMessageEntry as a
// {"type":"custom_message", customType, content, display, details} entry — NOT a
// {"type":"message"} entry. Because the live path forwards it (custom is in
// PERSISTED_ROLES), replay MUST reproduce it too, mapping the custom_message
// entry back to the live shape {role:"custom", customType, content, display,
// details}. Otherwise a catch-up would silently drop a custom message the phone
// already saw live.

export interface ReplayFrame {
  event: { type: "message_end"; message: unknown };
  cursor: number;
}

// Roles carried on a stored {"type":"message"} entry that also stream live.
const MESSAGE_ROLES = new Set(["user", "assistant", "toolResult", "system"]);

// SINGLE SOURCE of the roles pi both streams live at message_end AND persists
// (agent-session.js). The live-forward gate (Session.forwardEvent) imports this
// exact set, and entriesAfter reproduces the same roles below — the message
// roles via {"type":"message"} entries plus "custom" via {"type":"custom_message"}
// entries — so the live and replay coverage can never drift.
export const PERSISTED_ROLES: ReadonlySet<string> = new Set([...MESSAGE_ROLES, "custom"]);

// A PURE cap over already-computed replay frames. Given the frames from
// entriesAfter (each carrying its true absolute cursor) and a `limit`, keep only
// the LAST `limit` frames and report how many were dropped plus the absolute
// cursor of the last dropped frame — so the daemon can advance its stored cursor
// past the whole skipped range via a single trimmed marker. `limit` 0 (or any
// non-positive) means "no limit": keep everything, skipped 0. When nothing is
// dropped, lastSkippedCursor is 0. Kept frames retain their true cursors.
export function trimFrames(
  frames: ReplayFrame[],
  limit: number,
): { kept: ReplayFrame[]; skipped: number; lastSkippedCursor: number } {
  if (!Number.isFinite(limit) || limit <= 0 || frames.length <= limit) {
    return { kept: frames, skipped: 0, lastSkippedCursor: 0 };
  }
  const skipped = frames.length - limit;
  return {
    kept: frames.slice(skipped),
    skipped,
    lastSkippedCursor: frames[skipped - 1].cursor,
  };
}

export function entriesAfter(entries: unknown[], since: number): ReplayFrame[] {
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  const frames: ReplayFrame[] = [];
  entries.slice(from).forEach((entry, i) => {
    const cursor = from + i + 1;
    const e = entry as { type?: string; message?: { role?: string } } | null;
    if (!e || typeof e.type !== "string") return;

    if (e.type === "message" && e.message !== undefined) {
      const role = e.message?.role;
      if (role !== undefined && MESSAGE_ROLES.has(role)) {
        frames.push({ event: { type: "message_end", message: e.message }, cursor });
      }
      return;
    }

    // A persisted custom message streamed live as role "custom": reconstruct the
    // live message_end shape so replay matches what the phone already received.
    if (e.type === "custom_message") {
      const c = entry as {
        customType?: unknown;
        content?: unknown;
        display?: unknown;
        details?: unknown;
      };
      frames.push({
        event: {
          type: "message_end",
          message: {
            role: "custom",
            customType: c.customType,
            content: c.content,
            display: c.display,
            details: c.details,
          },
        },
        cursor,
      });
    }
  });
  return frames;
}
