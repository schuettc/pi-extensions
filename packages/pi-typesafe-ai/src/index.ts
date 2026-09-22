import { CredentialStore, resolveTypeSafeDir, validateApiKey } from "./credentials.ts";
export * from "./credentials.ts";
export * from "./client.ts";
export * from "./bundle.ts";

export interface TypeSafeExtensionDeps { store?: CredentialStore }

export function createTypeSafeExtension(pi: any, deps: TypeSafeExtensionDeps = {}): void {
  const store = deps.store ?? new CredentialStore({ dir: resolveTypeSafeDir() });
  pi.registerCommand("typesafe", {
    description: "Manage the TypeSafe (Jev) API key: setup | status | logout",
    handler: async (args: string, ctx: any) => {
      const sub = (args || "").trim().split(/\s+/)[0] || "status";
      if (sub === "status") {
        const s = await store.inspect();
        ctx.ui.notify(s.configured ? `TypeSafe key configured (${s.path})` : `TypeSafe key not configured (${s.path})${s.problem ? ` — ${s.problem}` : ""}`, s.configured ? "info" : "warn");
        return;
      }
      if (sub === "logout") {
        const ok = await ctx.ui.confirm?.({ message: "Delete the stored TypeSafe key?" }) ?? true;
        if (!ok) return;
        ctx.ui.notify((await store.clear()) ? "TypeSafe key deleted." : "No TypeSafe key was stored.", "info");
        return;
      }
      if (sub === "setup") {
        const existing = await store.inspect();
        if (existing.configured) {
          const replace = await ctx.ui.confirm?.({ message: "A TypeSafe key is already stored. Replace it?" }) ?? true;
          if (!replace) { ctx.ui.notify("Kept the existing TypeSafe key.", "info"); return; }
        }
        const raw = await ctx.ui.input({ message: "Paste the TypeSafe API key (input is NOT masked):" });
        const v = validateApiKey(String(raw ?? ""));
        if (!v.ok) { ctx.ui.notify(`Not stored: ${v.reason}`, "warn"); return; }
        await store.write(v.key, { replaceExisting: true });
        ctx.ui.notify("TypeSafe key stored.", "info");
        return;
      }
      ctx.ui.notify("usage: /typesafe setup | status | logout", "warn");
    },
  });
}

export default function (pi: any): void { createTypeSafeExtension(pi); }
