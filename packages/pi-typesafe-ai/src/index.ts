import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CredentialStore, resolveTypeSafeDir, validateApiKey } from "./credentials.ts";
import { promptSecret as defaultPromptSecret } from "./masked-input.ts";
export * from "./credentials.ts";
export * from "./client.ts";
export * from "./bundle.ts";
export { MaskedInput, promptSecret, type MaskedInputOptions } from "./masked-input.ts";

export interface TypeSafeExtensionDeps {
  store?: CredentialStore;
  promptSecret?: (ctx: ExtensionCommandContext, title: string) => Promise<string | undefined>;
}

export function createTypeSafeExtension(pi: ExtensionAPI, deps: TypeSafeExtensionDeps = {}): void {
  const store = deps.store ?? new CredentialStore({ dir: resolveTypeSafeDir() });
  const promptSecret = deps.promptSecret ?? defaultPromptSecret;
  pi.registerCommand("typesafe", {
    description: "Manage the TypeSafe (Jev) API key: setup | status | logout",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const sub = (args || "").trim().split(/\s+/)[0] || "status";
      if (sub === "status") {
        const s = await store.inspect();
        ctx.ui.notify(s.configured ? `TypeSafe key configured (${s.path})` : `TypeSafe key not configured (${s.path})${s.problem ? ` — ${s.problem}` : ""}`, s.configured ? "info" : "warning");
        return;
      }
      if (sub === "logout") {
        const ok = await ctx.ui.confirm("TypeSafe", "Delete the stored TypeSafe key?");
        if (!ok) return;
        ctx.ui.notify((await store.clear()) ? "TypeSafe key deleted." : "No TypeSafe key was stored.", "info");
        return;
      }
      if (sub === "setup") {
        const existing = await store.inspect();
        if (existing.configured) {
          const replace = await ctx.ui.confirm("TypeSafe", "A TypeSafe key is already stored. Replace it?");
          if (!replace) { ctx.ui.notify("Kept the existing TypeSafe key.", "info"); return; }
        }
        const raw = await promptSecret(ctx, "Paste your TypeSafe API key");
        if (raw === undefined) { ctx.ui.notify("Cancelled — key unchanged.", "info"); return; }
        const v = validateApiKey(raw);
        if (!v.ok) { ctx.ui.notify(`Not stored: ${v.reason}`, "warning"); return; }
        await store.write(v.key, { replaceExisting: true });
        ctx.ui.notify("TypeSafe key stored.", "info");
        return;
      }
      ctx.ui.notify("usage: /typesafe setup | status | logout", "warning");
    },
  });
}

export default function (pi: ExtensionAPI): void { createTypeSafeExtension(pi); }
