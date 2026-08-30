export type ModelRef = { provider: string; id: string };

// The direct anthropic provider is metered "extra usage"; claude-bridge is the
// plan-quota route. model_select is observational (returns void), so the gate
// cannot veto — it decides a revert target that index.ts applies via setModel.
export const METERED_PROVIDER = "anthropic";

export function decideMetered(opts: {
  selected: ModelRef;
  previous?: ModelRef;
  override: boolean;
  defaultSafe: ModelRef;
}): { revertTo: ModelRef; reason: string } | undefined {
  if (opts.override) return undefined;
  if (opts.selected.provider !== METERED_PROVIDER) return undefined;
  // Revert to the previous model only if it was itself safe; otherwise the
  // configured default. Never revert to another metered model — that would loop.
  const safePrev = opts.previous && opts.previous.provider !== METERED_PROVIDER ? opts.previous : undefined;
  const revertTo = safePrev ?? opts.defaultSafe;
  return {
    revertTo,
    reason: `the direct ${METERED_PROVIDER} provider is metered extra usage; staying on ${revertTo.provider}. Set PI_ALLOW_METERED_ANTHROPIC=1 to override.`,
  };
}
