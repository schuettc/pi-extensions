import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MASK = "•";
const DEFAULT_HINT = "enter save · esc cancel · ctrl+u clear";

export interface MaskedInputOptions {
  title: string;
  hint?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  requestRender: () => void;
}

function isPrintable(text: string): boolean {
  if (text.length === 0 || text.startsWith("\x1b")) return false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return true;
}

/**
 * Single-line secret entry. The typed value is held privately and never
 * rendered — only one mask character per code point is shown.
 */
export class MaskedInput implements Component {
  #value = "";
  #opts: MaskedInputOptions;

  constructor(opts: MaskedInputOptions) {
    this.#opts = opts;
  }

  render(width: number): string[] {
    const count = [...this.#value].length;
    return [
      truncateToWidth(this.#opts.title, width),
      truncateToWidth(`> ${MASK.repeat(count)}`, width),
      truncateToWidth(this.#opts.hint ?? DEFAULT_HINT, width),
    ];
  }

  handleInput(data: string): void {
    const pasteAt = data.indexOf(PASTE_START);
    if (pasteAt !== -1) {
      const rest = data.slice(pasteAt + PASTE_START.length);
      const endAt = rest.indexOf(PASTE_END);
      const pasted = (endAt === -1 ? rest : rest.slice(0, endAt)).replace(/[\r\n]/g, "");
      this.#append(pasted);
      return;
    }
    if (matchesKey(data, "enter") || data === "\n") {
      this.#opts.onSubmit(this.#value);
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.#opts.onCancel();
      return;
    }
    if (matchesKey(data, "backspace")) {
      const chars = [...this.#value];
      if (chars.length === 0) return;
      chars.pop();
      this.#value = chars.join("");
      this.#opts.requestRender();
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      if (this.#value === "") return;
      this.#value = "";
      this.#opts.requestRender();
      return;
    }
    // Under the Kitty keyboard protocol plain characters arrive as CSI-u sequences.
    const kitty = data.startsWith("\x1b") ? decodeKittyPrintable(data) : undefined;
    this.#append(kitty ?? data);
  }

  invalidate(): void {}

  #append(text: string): void {
    if (!isPrintable(text)) return;
    this.#value += text;
    this.#opts.requestRender();
  }
}

/** Prompt for a secret with a masked field. Resolves `undefined` on cancel or when no TUI is available. */
export async function promptSecret(ctx: ExtensionCommandContext, title: string): Promise<string | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/typesafe setup requires the interactive pi TUI (masked key entry).", "warning");
    return undefined;
  }
  return ctx.ui.custom<string | undefined>((tui, _theme, _kb, done) =>
    new MaskedInput({
      title,
      onSubmit: (v) => done(v),
      onCancel: () => done(undefined),
      requestRender: () => tui.requestRender(),
    }),
  );
}
