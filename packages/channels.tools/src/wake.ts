import { renderBatch, renderSummary } from "./envelope.ts";
import type { ChannelEvent } from "./envelope.ts";

export type Delivery = {
  // The model-facing XML envelope — full bodies, guidance, meta attributes.
  envelope: string;
  // The human-facing short form — what the transcript shows.
  summary: string;
};

export type Wake = {
  onEvent(event: ChannelEvent): void;
  onAgentStart(): void;
  onAgentSettled(): void;
  onSessionStart(): void;
  onReady(): void;
  pendingCount(): number;
};

export function createWake(opts: { deliver: (delivery: Delivery) => void; log?: (message: string) => void }): Wake {
  // Insertion order of this Map is the delivery order across sources.
  let buffer = new Map<string, ChannelEvent[]>();
  let busy = false;
  let ready = false;

  function pendingCount(): number {
    let n = 0;
    for (const [, events] of buffer) n += events.length;
    return n;
  }

  function flush(): void {
    if (buffer.size === 0) return;
    const batches = buffer;
    buffer = new Map();
    for (const [source, events] of batches) {
      if (events.length === 0) continue;
      try {
        opts.deliver({ envelope: renderBatch(source, events), summary: renderSummary(source, events) });
      } catch (error) {
        // This runs synchronously inside the OS stream callback chain
        // (stdout 'data' -> dispatch -> onEvent -> flush -> deliver ->
        // pi.sendUserMessage). A throw here must not escape: uncaught, it kills
        // the pi process from inside an EventEmitter callback. And because
        // `buffer` was already swapped out above, one bad delivery must not
        // stop the loop — the next source's events would otherwise be
        // discarded along with it, which is exactly the silent-mail-loss
        // failure this component exists to prevent.
        opts.log?.(`delivery to ${source} failed: ${String(error)}`);
      }
    }
  }

  return {
    onEvent(event) {
      const events = buffer.get(event.source) ?? [];
      events.push(event);
      buffer.set(event.source, events);
      // The gate must be open AND no turn running. `ready` is set when
      // session_start finishes, never on first settle: agent_settled only
      // fires after an agent run, so a session whose first event is inbound
      // mail would otherwise never settle and never deliver.
      if (ready && !busy) flush();
    },
    onAgentStart() {
      busy = true;
    },
    onAgentSettled() {
      busy = false;
      if (ready) flush();
    },
    onSessionStart() {
      busy = false;
      ready = false;
      buffer = new Map();
    },
    onReady() {
      ready = true;
      if (!busy) flush();
    },
    pendingCount,
  };
}
