import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ChannelServerDef = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

function readServers(path: string): Record<string, ChannelServerDef> {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A malformed file must not take the session down; the connection
    // layer surfaces "no channels configured" instead.
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const servers = (parsed as { channelServers?: unknown }).channelServers;
  if (typeof servers !== "object" || servers === null) return {};

  const out: Record<string, ChannelServerDef> = {};
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const def = value as Partial<ChannelServerDef>;
    if (typeof def.command !== "string" || def.command === "") continue;
    out[name] = { command: def.command, ...(def.args ? { args: def.args } : {}),
      ...(def.env ? { env: def.env } : {}), ...(def.cwd ? { cwd: def.cwd } : {}) };
  }
  return out;
}

export function loadChannelConfig(opts: { home: string; cwd: string }): Record<string, ChannelServerDef> {
  const global = readServers(join(opts.home, ".pi", "agent", "channels.json"));
  const project = readServers(join(opts.cwd, ".pi", "channels.json"));
  return { ...global, ...project };
}
