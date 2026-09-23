import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { validateApiKey, type CredentialStatus, type CredentialStore } from "./credentials.ts";
import { MaskedInput } from "./masked-input.ts";

// The settings panel a bare `/typesafe` opens. It copies creel's popup
// (tackle/internal/creel/tui.go): a rounded border 56 columns wide with two
// columns of padding, a bold title, dim labels, and a dim key-hint footer.
// Colors come from the pi theme so it follows the user's theme.

export const BOX_WIDTH = 56;
const PADDING = 2;

/** The subset of pi's Theme the panel uses. */
export interface PanelTheme {
  fg(color: "accent" | "border" | "dim" | "muted" | "success" | "error" | "warning" | "text", text: string): string;
  bold(text: string): string;
}

export function renderBox(opts: { title: string; body: string[]; footer: string; width: number; theme: PanelTheme }): string[] {
  const { theme } = opts;
  const outer = Math.max(PADDING * 2 + 4, Math.min(BOX_WIDTH, opts.width));
  const inner = outer - 2 - PADDING * 2;
  const border = (text: string) => theme.fg("border", text);
  const row = (content: string) => {
    const fitted = truncateToWidth(content, inner, "…");
    const pad = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
    return `${border("│")}${" ".repeat(PADDING)}${fitted}${pad}${" ".repeat(PADDING)}${border("│")}`;
  };
  const body = [theme.bold(opts.title), "", ...opts.body, "", theme.fg("dim", opts.footer)];
  return [
    border(`╭${"─".repeat(outer - 2)}╮`),
    ...body.map(row),
    border(`╰${"─".repeat(outer - 2)}╯`),
  ];
}

export type ConnectionResult = { ok: true; latencyMs: number; model?: string } | { ok: false; reason: string };

export interface TypeSafePanelOptions {
  store: Pick<CredentialStore, "inspect" | "write" | "clear">;
  /** The model the Jev client uses by default (display only). */
  model: string;
  testConnection: () => Promise<ConnectionResult>;
  theme: PanelTheme;
  requestRender: () => void;
  onClose: () => void;
}

type RowId = "key" | "model" | "test" | "remove";
const ROWS: ReadonlyArray<{ id: RowId; label: string; help: string }> = [
  { id: "key", label: "API key", help: "Set or replace the key Jev uses. Stored in your pi agent directory (0600); it is never shown." },
  { id: "model", label: "Model", help: "The model the client calls by default. The permission reviewer's model is set in its kempt profile." },
  { id: "test", label: "Test connection", help: "Run one tiny Jev evaluation with the stored key and report the latency." },
  { id: "remove", label: "Remove key", help: "Delete the stored key. Jev calls fail closed until a new key is set." },
];
const LABEL_WIDTH = 17;

export class TypeSafePanel implements Component {
  #opts: TypeSafePanelOptions;
  #selected = 0;
  #mode: "list" | "enterKey" | "confirmRemove" = "list";
  #status: CredentialStatus | undefined;
  #test: "not run" | "testing" | ConnectionResult = "not run";
  #message: { kind: "ok" | "error"; text: string } | undefined;
  #input: MaskedInput | undefined;
  #pending: Promise<void> = Promise.resolve();

  constructor(opts: TypeSafePanelOptions) {
    this.#opts = opts;
    this.#run(() => this.#refresh());
  }

  /** Resolves once any in-flight action (load, save, test) has finished. */
  idle(): Promise<void> {
    return this.#pending;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { theme } = this.#opts;
    const body: string[] = [];
    if (this.#mode === "enterKey" && this.#input) {
      const [prompt, field] = this.#input.render(BOX_WIDTH);
      body.push(theme.fg("dim", prompt ?? ""), theme.fg("accent", field ?? ""));
    } else if (this.#mode === "confirmRemove") {
      body.push(theme.fg("warning", "Delete the stored key? y/N"));
    } else {
      ROWS.forEach((row, index) => {
        const active = index === this.#selected;
        const pointer = active ? theme.fg("accent", "→ ") : "  ";
        const label = row.label.padEnd(LABEL_WIDTH);
        body.push(`${pointer}${active ? theme.fg("accent", label) : theme.fg("text", label)}${this.#value(row.id)}`);
      });
      body.push("");
      for (const line of wrapTextWithAnsi(ROWS[this.#selected]!.help, BOX_WIDTH - 2 - PADDING * 2)) {
        body.push(theme.fg("dim", line));
      }
    }
    if (this.#message) {
      body.push("", this.#message.kind === "ok"
        ? theme.fg("success", `✓ ${this.#message.text}`)
        : theme.fg("error", `✗ ${this.#message.text}`));
    }
    return renderBox({ title: "🔑 typesafe · Jev", body, footer: this.#footer(), width, theme });
  }

  handleInput(data: string): void {
    if (this.#mode === "enterKey") {
      this.#input?.handleInput(data);
      return;
    }
    if (this.#mode === "confirmRemove") {
      const yes = data === "y" || data === "Y";
      this.#mode = "list";
      if (yes) {
        this.#run(async () => {
          const removed = await this.#opts.store.clear();
          this.#test = "not run";
          this.#message = { kind: "ok", text: removed ? "Key deleted." : "No key was stored." };
          await this.#refresh();
        });
      } else {
        this.#message = { kind: "ok", text: "Kept the stored key." };
      }
      this.#opts.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#opts.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.#selected = (this.#selected + ROWS.length - 1) % ROWS.length;
      this.#message = undefined;
    } else if (matchesKey(data, "down") || data === "j") {
      this.#selected = (this.#selected + 1) % ROWS.length;
      this.#message = undefined;
    } else if (matchesKey(data, "enter") || data === "\n" || data === " ") {
      this.#activate(ROWS[this.#selected]!.id);
    } else {
      return;
    }
    this.#opts.requestRender();
  }

  #activate(id: RowId): void {
    this.#message = undefined;
    if (id === "key") {
      this.#mode = "enterKey";
      this.#input = new MaskedInput({
        title: this.#status?.configured ? "Paste a new TypeSafe API key (replaces the stored one)" : "Paste your TypeSafe API key",
        onSubmit: (value) => this.#saveKey(value),
        onCancel: () => { this.#mode = "list"; this.#input = undefined; this.#opts.requestRender(); },
        requestRender: () => this.#opts.requestRender(),
      });
    } else if (id === "test") {
      this.#test = "testing";
      this.#run(async () => {
        try {
          this.#test = await this.#opts.testConnection();
        } catch {
          this.#test = { ok: false, reason: "the test failed unexpectedly" };
        }
      });
    } else if (id === "remove") {
      if (this.#status?.configured) this.#mode = "confirmRemove";
      else this.#message = { kind: "error", text: "No key is stored." };
    }
  }

  #saveKey(raw: string): void {
    const checked = validateApiKey(raw);
    if (!checked.ok) {
      this.#message = { kind: "error", text: `Not stored: ${checked.reason}` };
      this.#opts.requestRender();
      return;
    }
    this.#mode = "list";
    this.#input = undefined;
    this.#run(async () => {
      await this.#opts.store.write(checked.key, { replaceExisting: true });
      this.#test = "not run";
      this.#message = { kind: "ok", text: "Key stored." };
      await this.#refresh();
    });
  }

  #value(id: RowId): string {
    const { theme } = this.#opts;
    if (id === "key") {
      if (!this.#status) return theme.fg("dim", "…");
      if (this.#status.configured) return theme.fg("success", "configured");
      return theme.fg("warning", this.#status.problem ? `not usable: ${this.#status.problem}` : "not set");
    }
    if (id === "model") {
      const reported = typeof this.#test === "object" && this.#test.ok && this.#test.model;
      return theme.fg("accent", reported && reported !== this.#opts.model ? `${this.#opts.model} → ${reported}` : this.#opts.model);
    }
    if (id === "test") {
      if (this.#test === "not run") return theme.fg("dim", "not run");
      if (this.#test === "testing") return theme.fg("dim", "testing…");
      return this.#test.ok
        ? theme.fg("success", `ok · ${this.#test.latencyMs}ms`)
        : theme.fg("error", `✗ ${this.#test.reason}`);
    }
    return "";
  }

  #footer(): string {
    if (this.#mode === "enterKey") return "enter save · esc back · ctrl+u clear";
    if (this.#mode === "confirmRemove") return "y delete · any other key keeps it";
    return "↑↓ select · enter change · esc close";
  }

  async #refresh(): Promise<void> {
    this.#status = await this.#opts.store.inspect();
  }

  #run(action: () => Promise<void>): void {
    this.#pending = this.#pending
      .then(action)
      .catch(() => { this.#message = { kind: "error", text: "Something went wrong; nothing was changed." }; })
      .finally(() => this.#opts.requestRender());
  }
}
