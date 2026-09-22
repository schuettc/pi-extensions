// Adapted from legacybridge-tech/pi-typesafe-jev (src/config.ts), MIT License,
// © 2025 pi-typesafe-jev authors.
export const TYPESAFE_CONFIG_DIR_NAME = "typesafe";
export const TYPESAFE_CONFIG_FILE_NAME = "config.json";
export const CONFIG_VERSION = 1;
export const CONFIG_DIR_MODE = 0o700;
export const CONFIG_FILE_MODE = 0o600;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_API_KEY_CHARS = 4096;

export class TypeSafeConfigError extends Error {
  constructor(message: string) { super(message); this.name = "TypeSafeConfigError"; }
}

export type ApiKeyValidation = { ok: true; key: string } | { ok: false; reason: string };

export function validateApiKey(value: string): ApiKeyValidation {
  const key = value.trim();
  if (key.length === 0) return { ok: false, reason: "the value was empty" };
  if (key.length > MAX_API_KEY_CHARS) return { ok: false, reason: `the value is longer than ${MAX_API_KEY_CHARS} characters` };
  for (let i = 0; i < key.length; i += 1) {
    const code = key.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return { ok: false, reason: "the value contains whitespace, a control character, or a non-ASCII character" };
  }
  return { ok: true, key };
}
