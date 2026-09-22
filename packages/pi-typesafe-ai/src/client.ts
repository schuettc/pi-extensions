import { TypeSafeClient } from "@typesafe-ai/sdk";
import { CredentialStore, TypeSafeConfigError } from "./credentials.ts";

export type { ChoiceResponse, ScoreResponse, NoulResponse, SystemOneResult, Questions } from "@typesafe-ai/sdk";

type SystemOneLike = (req: { state: unknown; questions: unknown; model: string }) => Promise<{ answers: Record<string, unknown>; usage?: unknown }>;

export interface JevClientOptions {
  credentials: CredentialStore;
  env?: NodeJS.ProcessEnv;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  baseURL?: string;
  clientFactory?: (cfg: { apiKey: string; timeout: number; baseURL?: string }) => { systemOne: SystemOneLike };
}

export class JevClient {
  private readonly credentials: CredentialStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly baseURL?: string;
  private readonly clientFactory: NonNullable<JevClientOptions["clientFactory"]>;

  constructor(o: JevClientOptions) {
    this.credentials = o.credentials;
    this.env = o.env ?? process.env;
    this.defaultModel = o.defaultModel ?? "jev-latest";
    this.defaultTimeoutMs = o.defaultTimeoutMs ?? 8000;
    this.baseURL = o.baseURL;
    this.clientFactory = o.clientFactory ?? ((cfg) => new TypeSafeClient({
      apiKey: cfg.apiKey, timeout: cfg.timeout, retry: { maxRetries: 0 },
      ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
    }) as unknown as { systemOne: SystemOneLike });
  }

  private async resolveKey(): Promise<string | undefined> {
    const stored = await this.credentials.read();
    if (stored?.apiKey) return stored.apiKey;
    const env = this.env.TYPESAFE_API_KEY;
    return env && env.trim() ? env.trim() : undefined;
  }

  async isConfigured(): Promise<boolean> {
    try { return (await this.resolveKey()) !== undefined; } catch { return false; }
  }

  async evaluate(state: unknown, questions: unknown, opts: { model?: string; timeoutMs?: number } = {}): Promise<{ answers: Record<string, unknown>; usage?: unknown; latencyMs: number }> {
    const apiKey = await this.resolveKey();
    if (!apiKey) throw new TypeSafeConfigError("no TypeSafe API key configured (run /typesafe setup)");
    // Construct per call: the key + timeout are resolved fresh each call, so a
    // re-keyed credential file (or changed timeout) takes effect without restart.
    const client = this.clientFactory({ apiKey, timeout: opts.timeoutMs ?? this.defaultTimeoutMs, baseURL: this.baseURL });
    const started = Date.now();
    const res = await client.systemOne({ state, questions, model: opts.model ?? this.defaultModel });
    return { answers: res.answers, usage: res.usage, latencyMs: Date.now() - started };
  }
}
