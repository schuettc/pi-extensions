import type { JevClient } from "./client.ts";

export interface Bundle<T> {
  id: string;
  questions: unknown;
  map: (answers: Record<string, unknown>) => T;
}

export async function evaluateBundle<T>(
  client: JevClient,
  bundle: Bundle<T>,
  state: unknown,
  opts: { model?: string; timeoutMs?: number } = {},
): Promise<{ value: T; answers: Record<string, unknown>; usage?: unknown; latencyMs: number }> {
  const { answers, usage, latencyMs } = await client.evaluate(state, bundle.questions, opts);
  return { value: bundle.map(answers), answers, usage, latencyMs };
}
