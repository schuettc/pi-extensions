/**
 * pi-quiet: this rig's bash tool registration.
 *
 * Re-registers the built-in bash tool via pi's own createBashToolDefinition
 * and owns three things about it:
 *
 *  1. Rendering. Collapsed (the default): the call renders as a single
 *     truncated `$ command` line and the result as a single muted summary
 *     line. Expanded (ctrl+o / app.tools.expand): both slots defer to the
 *     built-in renderer, so the full command, streamed output, truncation
 *     warnings, and duration come back exactly as stock pi shows them.
 *  2. pi's shell settings. The built-in is constructed with
 *     settings.shellCommandPrefix and settings.shellPath, as pi itself does;
 *     a re-registration that passed nothing silently dropped both.
 *  3. Session identity. A spawn hook copies pi's per-command PI_SESSION_ID
 *     into AGENT_SESSION_ID, the harness-neutral name tools read — see
 *     bash-options.ts for why that must be per command and never process.env.
 *
 * Execution is still the built-in: permission gating, auto-review, and the
 * sandbox all hook execution, which this file never replaces.
 */

import {
  createBashToolDefinition,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { buildBashOptions } from "./bash-options.ts";

function firstLine(command: string): { line: string; more: number } {
  const lines = command.split("\n");
  return { line: lines[0] ?? "", more: lines.length - 1 };
}

function resultText(result: { content?: { type: string; text?: string }[] }): string {
  return (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

export default function quietTools(pi: ExtensionAPI) {
  const cwd = process.cwd();
  // Global settings only. pi decides project-settings trust itself and does
  // not expose that decision to extensions; honouring an untrusted repo's
  // .pi/settings.json here would let it prepend a shell prefix to every
  // command, so this reads what pi reads for a project it has not trusted.
  const settings = SettingsManager.create(cwd, undefined, { projectTrusted: false });
  const builtin = createBashToolDefinition(cwd, buildBashOptions(settings));

  pi.registerTool({
    ...builtin,

    renderCall(args: any, theme: any, context: any) {
      if (context.expanded && builtin.renderCall) {
        return builtin.renderCall(args, theme, context);
      }
      const command = typeof args?.command === "string" ? args.command : "...";
      const { line, more } = firstLine(command.trim());
      const suffix = more > 0 ? theme.fg("muted", ` (+${more} lines)`) : "";
      // Text handles width truncation; keep the line itself short anyway so
      // narrow panes stay one visual row.
      const shown = line.length > 200 ? `${line.slice(0, 200)}…` : line;
      return new Text(
        theme.fg("toolTitle", theme.bold(`$ ${shown}`)) + suffix,
        0,
        0,
      );
    },

    renderResult(result: any, options: any, theme: any, context: any) {
      if (options.expanded && builtin.renderResult) {
        return builtin.renderResult(result, options, theme, context);
      }
      if (options.isPartial) {
        return new Text(theme.fg("muted", "  … running"), 0, 0);
      }
      const text = resultText(result).trim();
      const lineCount = text ? text.split("\n").length : 0;
      const status = result.isError ? theme.fg("error", "error") : "ok";
      const tail = text ? text.split("\n").at(-1) ?? "" : "";
      const tailShown = tail.length > 120 ? `${tail.slice(0, 120)}…` : tail;
      const summary =
        lineCount <= 1
          ? `  → ${status}${tailShown ? theme.fg("toolOutput", ` · ${tailShown}`) : ""}`
          : `  → ${status} · ${lineCount} lines${tailShown ? theme.fg("toolOutput", ` · … ${tailShown}`) : ""}`;
      return new Text(theme.fg("muted", summary), 0, 0);
    },
  });
}
