import { homedir } from "node:os";
import { decideMetered, METERED_PROVIDER } from "./gate.ts";
import type { ModelRef } from "./gate.ts";
import { appendPolicy, loadProse } from "./prose.ts";

type Deps = {
  env?: NodeJS.ProcessEnv;
  appendPolicy?: (systemPrompt: string, prose: string[]) => string;
  loadProse?: (opts: { home: string }) => string[];
};

// Every handler is best-effort: it sits directly on a pi lifecycle event, and
// a guardrail that fails a model switch or a turn start over its own bug is
// worse than no guardrail at all.
function safe(fn: () => void | Promise<void>): void {
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // Best-effort: nothing here may escape into pi.
  }
}

export function createGuardrails(pi: any, deps: Deps = {}): void {
  const env = deps.env ?? process.env;
  const applyPolicy = deps.appendPolicy ?? appendPolicy;
  const readProse = deps.loadProse ?? loadProse;

  // Revert target of last resort, captured from the session's starting
  // model. CRITICAL: this must never be a metered model — the rig's default
  // is the local, non-metered llama.cpp provider, so ctx.model at
  // session_start being anthropic should be impossible by rig design. Guard
  // it anyway: if it ever is, leave defaultSafe unset rather than let the
  // gate revert TO a metered model, which would loop/defeat it entirely.
  let defaultSafe: ModelRef | undefined;

  pi.on("session_start", (_event: unknown, ctx: any) => safe(() => {
    const model = ctx?.model;
    if (!model) return;
    if (model.provider === METERED_PROVIDER) {
      // Should be impossible by rig design; log and leave defaultSafe unset
      // so the gate falls back to leaving the selection alone instead of
      // reverting to a metered model.
      ctx.ui?.notify?.(
        `guardrails: session started on the metered ${METERED_PROVIDER} provider; no safe default captured`,
        "warning",
      );
      return;
    }
    defaultSafe = { provider: model.provider, id: model.id };
  }));

  pi.on("model_select", (event: any, ctx: any) => safe(async () => {
    // Exact match only: PI_ALLOW_METERED_ANTHROPIC=0/false/off must NOT enable
    // metered billing. Any value other than "1" leaves the guardrail armed.
    const override = (env as any).PI_ALLOW_METERED_ANTHROPIC === "1";
    // With no captured baseline, a non-metered previousModel is still a valid
    // revert target. Only when there is no safe target at all do we bail —
    // and then loudly, never silently leaving the user on the metered provider.
    const previous = event.previousModel;
    const safePrevious =
      previous && previous.provider !== METERED_PROVIDER ? previous : undefined;
    const fallback = defaultSafe ?? safePrevious;
    if (!fallback) {
      if (!override && event.model?.provider === METERED_PROVIDER) {
        ctx.ui?.notify?.(
          `guardrails: the session is on the metered ${event.model.provider}/${event.model.id} provider and there is no safe revert target — switch models manually.`,
          "error",
        );
      }
      return;
    }
    const decision = decideMetered({
      selected: event.model,
      previous,
      override,
      defaultSafe: fallback,
    });
    if (!decision) return;
    // Attempt the revert FIRST and only notify success once it actually
    // happened. Notifying "reverted, staying on <safe>" before confirming
    // the switch landed would tell the user they're safe while the metered
    // model is still active on a registry miss, a false setModel result, or
    // a thrown error — a guardrail that reports success while silently
    // failing is worse than one that visibly fails.
    let reverted = false;
    try {
      const model = ctx.modelRegistry?.find?.(decision.revertTo.provider, decision.revertTo.id);
      // Belt and braces: the safety invariant is verifiable right here at the
      // sole setModel call site, not only by tracing gate.ts. If the target is
      // somehow metered, fall through to the "no safe target" failure notify.
      if (model && model.provider !== METERED_PROVIDER && decision.revertTo.provider !== METERED_PROVIDER) {
        reverted = Boolean(await pi.setModel(model));
      }
    } catch {
      reverted = false;
    }
    if (reverted) {
      ctx.ui?.notify?.(decision.reason, "warning");
    } else {
      ctx.ui?.notify?.(
        `guardrails: the session is on the metered ${event.model.provider}/${event.model.id} provider and the automatic revert to ${decision.revertTo.provider}/${decision.revertTo.id} FAILED — switch models manually.`,
        "error",
      );
    }
  }));

  pi.on("before_agent_start", (event: { systemPrompt?: string }) => {
    try {
      const prose = readProse({ home: homedir() });
      return { systemPrompt: applyPolicy(event.systemPrompt ?? "", prose) };
    } catch {
      // Best-effort: a broken policy block must never break turn start.
      return { systemPrompt: event.systemPrompt ?? "" };
    }
  });
}

export default function (pi: any) {
  createGuardrails(pi);
}
