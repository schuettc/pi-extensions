// C4 wire protocol: newline-delimited JSON, one object per line, over the
// daemon's Unix control socket. Types below mirror the C4 wire reference
// verbatim. The three functions are pure (no I/O).

export type PresenceState = "connected" | "driving" | "offline";

export interface Phone {
  deviceId: string;
  name: string;
  state: PresenceState;
}

/** Extension → daemon, first line: `session.register` args. */
export interface RegisterArgs {
  sessionId: string;
  project: string;
  work: string;
  dir: string;
  piVersion: string;
  extensionVersion: string;
  /** Which identity rule produced project/work (spec §4.1). Omitted by 0.1.x. */
  identity?: "hail" | "proj" | "fallback";
  /** Present (true) only when the session is tmux-hosted. */
  tmux?: boolean;
  tmuxSocket?: string;
  tmuxSession?: string;
  tmuxPane?: string;
}

/** Daemon's reply to `session.register`. */
export type RegisterReply =
  | {
      ok: true;
      data: {
        hostId: string;
        daemonVersion: string;
        accepted: boolean;
        have?: number;
      };
    }
  | { ok: false; error: string };

/** Extension → daemon, one JSON object per line after register. */
export type Outbound =
  | { event: unknown }
  | { turn: "start" | "end" }
  | { lock: "held" | "released" }
  | { exit: { code: number } }
  | { refused: { requestId: string; reason: "turn_running" } };

/** Daemon → extension, one JSON object per line after register. */
export type Inbound =
  | { prompt: { text: string; from: string; requestId: string } }
  | { presence: { phones: Phone[] } }
  | { answer: { requestId: string; value: unknown } }
  | { ctl: "stop" };

/** Serialize an object to a single NDJSON line (JSON + trailing newline). */
export function encodeLine(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

/** Parse a single trimmed NDJSON line. Throws on a blank line. */
export function decodeLine(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new Error("decodeLine: blank line");
  }
  return JSON.parse(trimmed);
}

/**
 * Split a buffer on newlines, returning complete lines (non-empty) and the
 * trailing partial line as `rest`.
 */
export function splitFrames(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.length > 0), rest };
}
