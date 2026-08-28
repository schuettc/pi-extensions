import type { McpToolDef } from "./connection.ts";

export function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  // $schema and additionalProperties are stripped because pi's validator
  // treats the object as a typebox schema; real servers ship
  // additionalProperties:false, which is the case this guards.
  const { $schema: _s, additionalProperties: _a, ...rest } = schema as Record<string, unknown>;
  return rest;
}

export function resolveToolNames(
  connections: Array<{ name: string; tools: McpToolDef[] }>,
  builtins: string[],
): {
  resolved: Array<{ server: string; original: string; registered: string }>;
  dropped: Array<{ server: string; original: string; reason: string }>;
} {
  const builtinSet = new Set(builtins);
  const taken = new Set(builtins);
  const resolved: Array<{ server: string; original: string; registered: string }> = [];
  const dropped: Array<{ server: string; original: string; reason: string }> = [];
  for (const conn of connections) {
    for (const tool of conn.tools) {
      // Unprefixed by default: channel servers already self-namespace, and
      // their instructions name these tools literally. Prefix only on a real
      // clash, so at most one server's documentation is ever wrong.
      let registered = tool.name;
      if (taken.has(registered)) registered = `${conn.name.replace(/[^A-Za-z0-9_]/g, "_")}_${tool.name}`;
      if (taken.has(registered)) {
        // Attribute the drop to whatever the *final* (possibly prefixed) name
        // actually collided with — builtins never change, but `taken` grows
        // as servers are processed, so this must be checked against the
        // original builtin set, not the flag from the unprefixed check above.
        const reason = builtinSet.has(registered)
          ? `prefixed name "${registered}" still collides with a builtin tool`
          : `prefixed name "${registered}" collides with another server's registered tool`;
        dropped.push({ server: conn.name, original: tool.name, reason });
        continue;
      }
      taken.add(registered);
      resolved.push({ server: conn.name, original: tool.name, registered });
    }
  }
  return { resolved, dropped };
}

export function toTextContent(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
} {
  const r = (typeof result === "object" && result !== null ? result : {}) as {
    content?: unknown;
    isError?: unknown;
  };
  const blocks = Array.isArray(r.content) ? r.content : [];
  const content = blocks.map((block) => {
    const b = (typeof block === "object" && block !== null ? block : {}) as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") return { type: "text" as const, text: b.text };
    return { type: "text" as const, text: `[${String(b.type ?? "unknown")} content omitted]` };
  });
  if (content.length === 0) content.push({ type: "text" as const, text: "(no content)" });
  return { content, isError: r.isError === true };
}
