export type ChannelEvent = {
  source: string;
  content: string;
  meta: Record<string, string>;
};

const GUIDANCE_SENTINEL = "\n\n---\n";

// Strictness rises with index. An unknown intent sorts above every known
// one: a server that grows a new intent must not have it silently ranked
// as the least urgent thing in the batch.
const STRICTNESS = ["fyi", "reply-requested", "action-requested"];

export function splitGuidance(content: string): { body: string; guidance?: string } {
  const at = content.indexOf(GUIDANCE_SENTINEL);
  if (at < 0) return { body: content };
  return {
    body: content.slice(0, at),
    guidance: content.slice(at + GUIDANCE_SENTINEL.length),
  };
}

export function strictestIntent(intents: string[]): string | undefined {
  let best: string | undefined;
  let bestRank = -1;
  for (const intent of intents) {
    if (intent === "") continue;
    const known = STRICTNESS.indexOf(intent);
    const rank = known < 0 ? STRICTNESS.length : known;
    if (rank > bestRank) {
      bestRank = rank;
      best = intent;
    }
  }
  return best;
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// renderSummary is the VISIBLE half of a delivery: one short line per event
// (the first body line, which channel servers author as their own compact
// summary), deduplicated, capped at five. It is what the operator reads in
// the transcript, and what the model acts on in the rare race where the
// envelope's nextTurn queue drains only at a later prompt — so it must be
// able to stand alone, not just decorate.
export function renderSummary(source: string, events: ChannelEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    const { body } = splitGuidance(event.content);
    const first = body.split("\n").find((line) => line.trim() !== "");
    if (first !== undefined && !lines.includes(first)) lines.push(first);
  }
  if (lines.length === 0) return `[${source}] new channel activity`;
  const shown = lines.slice(0, 5);
  if (lines.length > shown.length) shown.push(`…and ${lines.length - shown.length} more`);
  return shown.join("\n");
}

export function renderBatch(source: string, events: ChannelEvent[]): string {
  const bodies: string[] = [];
  const guidance: string[] = [];
  const intents: string[] = [];

  for (const event of events) {
    const split = splitGuidance(event.content);
    if (split.body !== "") bodies.push(split.body);
    if (split.guidance !== undefined && !guidance.includes(split.guidance)) {
      guidance.push(split.guidance);
    }
    if (event.meta.intent) intents.push(event.meta.intent);
  }

  // Attributes describe the batch. A single event's identity facts
  // (thread_id, from, kind, doc, reason, …) are trustworthy verbatim. Once
  // more than one event is coalesced, those per-event facts no longer
  // describe "the" event — carrying event[0]'s thread_id while count says 3
  // is an actively false attribute an agent could act on — so only the
  // recomputed count and intent survive into a multi-event batch. The
  // body lines still carry each event's own facts.
  const attrs: Record<string, string> = events.length > 1 ? {} : { ...(events[0]?.meta ?? {}) };
  // "source" is reserved for the hardcoded server-name attribute below; a
  // meta key literally named `source` must not produce a duplicate.
  delete attrs.source;
  // A server may coalesce before we do: some servers send one push
  // representing several events and say how many in meta.count. Overwriting that with our
  // notification count tells the agent one thing arrived when three did, so
  // sum the servers' own counts and fall back to counting notifications only
  // for events that carry none.
  attrs.count = String(
    events.reduce((total, event) => {
      const declared = Number(event.meta.count);
      return total + (Number.isFinite(declared) && declared > 0 ? declared : 1);
    }, 0),
  );
  const strictest = strictestIntent(intents);
  if (strictest !== undefined) attrs.intent = strictest;
  else delete attrs.intent;

  const rendered = Object.entries(attrs)
    .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
    .join(" ");

  const parts = [bodies.join("\n")];
  if (guidance.length > 0) parts.push(guidance.join("\n\n"));

  return `<channel source="${escapeAttr(source)}" ${rendered}>\n${parts.join("\n\n---\n")}\n</channel>`;
}
