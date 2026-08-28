/**
 * quiet-tools: collapse bash tool chatter to one line per call.
 *
 * Re-registers the built-in bash tool (execution untouched — it IS the
 * built-in, via createBashToolDefinition) and overrides only the two render
 * slots. Collapsed (the default): the call renders as a single truncated
 * `$ command` line and the result as a single muted summary line. Expanded
 * (ctrl+o / app.tools.expand): both slots defer to the built-in renderer,
 * so the full command, streamed output, truncation warnings, and duration
 * come back exactly as stock pi shows them.
 *
 * Display-only by design: permission gating, auto-review, and the sandbox
 * all hook execution, which this file never touches.
 */

import {
  createBashToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

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
  const builtin = createBashToolDefinition(process.cwd());

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
