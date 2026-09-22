// Adapted from legacybridge-tech/pi-typesafe-jev (src/config.ts), MIT License,
// © 2025 pi-typesafe-jev authors.
import { randomBytes } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

export interface StoredCredentials {
  version: number;
  apiKey: string;
}

export interface CredentialStatus {
  configured: boolean;
  /** Absolute path of the credential file. Safe to show the user. */
  path: string;
  /** Set when the file exists but could not be read as valid credentials. */
  problem?: string;
}

export interface CredentialStoreOptions {
  /** Directory owned by this extension, for example `<pi agent dir>/typesafe`. */
  dir: string;
  dirMode?: number;
  fileMode?: number;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function describeFsError(error: unknown): string {
  const code = errorCode(error);
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
  } catch {
    // Windows and some filesystems cannot open a directory handle; the
    // rename above is still atomic, so this is best effort.
    return;
  }
  try {
    await handle.sync();
  } catch {
    // Best effort only.
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Resolve the extension-owned credential directory: `<pi agent dir>/typesafe`.
 * Honors PI_CODING_AGENT_DIR, then falls back to `~/.pi/agent`.
 */
export function resolveTypeSafeDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const agentDir = env.PI_CODING_AGENT_DIR && env.PI_CODING_AGENT_DIR.trim()
    ? env.PI_CODING_AGENT_DIR
    : join(home, ".pi", "agent");
  return join(agentDir, TYPESAFE_CONFIG_DIR_NAME);
}

export class CredentialStore {
  readonly dir: string;
  readonly file: string;
  private readonly dirMode: number;
  private readonly fileMode: number;

  constructor(options: CredentialStoreOptions) {
    if (typeof options.dir !== "string" || options.dir.trim().length === 0) {
      throw new TypeSafeConfigError("the credential directory must not be empty");
    }
    this.dir = options.dir;
    this.file = join(options.dir, TYPESAFE_CONFIG_FILE_NAME);
    this.dirMode = options.dirMode ?? CONFIG_DIR_MODE;
    this.fileMode = options.fileMode ?? CONFIG_FILE_MODE;
  }

  /** Read stored credentials, or undefined when no key has been configured. */
  async read(): Promise<StoredCredentials | undefined> {
    if ((await this.requireOwnedDir("read")) === "missing") return undefined;
    const text = await this.readFileSafely();
    if (text === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TypeSafeConfigError(`${this.file} is not valid JSON`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new TypeSafeConfigError(`${this.file} must contain a JSON object`);
    }
    const record = parsed as Record<string, unknown>;
    if (record.version !== CONFIG_VERSION) {
      throw new TypeSafeConfigError(
        `${this.file} has an unsupported version (expected ${CONFIG_VERSION})`,
      );
    }
    if (typeof record.apiKey !== "string") {
      throw new TypeSafeConfigError(`${this.file} does not contain a string "apiKey" field`);
    }
    const validation = validateApiKey(record.apiKey);
    if (!validation.ok) {
      throw new TypeSafeConfigError(`${this.file} contains an unusable "apiKey" field: ${validation.reason}`);
    }
    return { version: CONFIG_VERSION, apiKey: validation.key };
  }

  async write(apiKey: string, options: { replaceExisting?: boolean } = {}): Promise<void> {
    const validation = validateApiKey(apiKey);
    if (!validation.ok) {
      throw new TypeSafeConfigError(`refusing to store the API key: ${validation.reason}`);
    }
    await this.ensureOwnedDir();
    const stats = await this.lstatTarget();
    if (stats?.isSymbolicLink()) {
      throw new TypeSafeConfigError(
        `refusing to write ${this.file}: it is a symbolic link, and replacing it could destroy the link target's owner's file`,
      );
    }
    if (stats && !stats.isFile()) {
      throw new TypeSafeConfigError(`refusing to write ${this.file}: it is not a regular file`);
    }
    if (stats && options.replaceExisting !== true) {
      throw new TypeSafeConfigError(
        `refusing to overwrite the existing ${this.file}; pass replaceExisting to replace it`,
      );
    }
    const payload = `${JSON.stringify({ version: CONFIG_VERSION, apiKey: validation.key }, null, 2)}\n`;
    await this.writeAtomically(payload);
  }

  async clear(): Promise<boolean> {
    if ((await this.requireOwnedDir("delete")) === "missing") return false;
    const stats = await this.lstatTarget();
    if (!stats) return false;
    if (stats.isSymbolicLink()) {
      throw new TypeSafeConfigError(`refusing to delete ${this.file}: it is a symbolic link`);
    }
    if (!stats.isFile()) {
      throw new TypeSafeConfigError(`refusing to delete ${this.file}: it is not a regular file`);
    }
    try {
      await unlink(this.file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw new TypeSafeConfigError(`could not delete ${this.file}: ${describeFsError(error)}`);
    }
    await syncDirectory(this.dir);
    return true;
  }

  async inspect(): Promise<CredentialStatus> {
    try {
      const credentials = await this.read();
      return credentials ? { configured: true, path: this.file } : { configured: false, path: this.file };
    } catch (error) {
      return {
        configured: false,
        path: this.file,
        problem: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async lstatTarget(): Promise<Stats | undefined> {
    try {
      return await lstat(this.file);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new TypeSafeConfigError(`cannot inspect ${this.file}: ${describeFsError(error)}`);
    }
  }

  private async lstatDir(): Promise<Stats | undefined> {
    try {
      return await lstat(this.dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new TypeSafeConfigError(`cannot inspect ${this.dir}: ${describeFsError(error)}`);
    }
  }

  private async assertOwnedDir(action: "read" | "write" | "delete", stats: Stats): Promise<void> {
    if (stats.isSymbolicLink()) {
      throw new TypeSafeConfigError(
        `refusing to ${action} ${this.file}: ${this.dir} is a symbolic link, and this extension only uses its own directory`,
      );
    }
    if (!stats.isDirectory()) {
      throw new TypeSafeConfigError(
        `refusing to ${action} ${this.file}: ${this.dir} is not a directory`,
      );
    }
  }

  private async requireOwnedDir(action: "read" | "delete"): Promise<"missing" | "present"> {
    const stats = await this.lstatDir();
    if (!stats) return "missing";
    await this.assertOwnedDir(action, stats);
    return "present";
  }

  private async ensureOwnedDir(): Promise<void> {
    const existing = await this.lstatDir();
    if (existing) {
      await this.assertOwnedDir("write", existing);
    } else {
      try {
        await mkdir(this.dir, { recursive: true, mode: this.dirMode });
      } catch (error) {
        if (errorCode(error) !== "EEXIST") {
          throw new TypeSafeConfigError(`could not prepare ${this.dir}: ${describeFsError(error)}`);
        }
      }
      const created = await this.lstatDir();
      if (!created) {
        throw new TypeSafeConfigError(`could not prepare ${this.dir}`);
      }
      await this.assertOwnedDir("write", created);
    }
    await this.applyDirMode();
  }

  private async applyDirMode(): Promise<void> {
    const flags =
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.dir, flags);
    } catch {
      const stats = await this.lstatDir();
      if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new TypeSafeConfigError(
          `refusing to use ${this.dir}: it is not a directory owned by this extension`,
        );
      }
      return;
    }
    try {
      await handle.chmod(this.dirMode);
    } catch (error) {
      throw new TypeSafeConfigError(`could not secure ${this.dir}: ${describeFsError(error)}`);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async readFileSafely(): Promise<string | undefined> {
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
    let handle: FileHandle;
    try {
      handle = await open(this.file, flags);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return undefined;
      if (code === "ELOOP") {
        throw new TypeSafeConfigError(
          `refusing to read ${this.file}: it is a symbolic link, and following it could expose the key`,
        );
      }
      throw new TypeSafeConfigError(`cannot read ${this.file}: ${describeFsError(error)}`);
    }
    try {
      const stats = await handle.stat();
      if (stats.isSymbolicLink()) {
        throw new TypeSafeConfigError(
          `refusing to read ${this.file}: it is a symbolic link, and following it could expose the key`,
        );
      }
      if (!stats.isFile()) {
        throw new TypeSafeConfigError(`refusing to read ${this.file}: it is not a regular file`);
      }
      if (stats.size > MAX_CONFIG_BYTES) {
        throw new TypeSafeConfigError(`${this.file} is larger than ${MAX_CONFIG_BYTES} bytes`);
      }
      const text = await handle.readFile({ encoding: "utf8" });
      if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
        throw new TypeSafeConfigError(`${this.file} is larger than ${MAX_CONFIG_BYTES} bytes`);
      }
      return text;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  private async writeAtomically(payload: string): Promise<void> {
    const tempPath = join(
      this.dir,
      `.${TYPESAFE_CONFIG_FILE_NAME}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    let handle: FileHandle;
    try {
      handle = await open(tempPath, "wx", this.fileMode);
    } catch (error) {
      throw new TypeSafeConfigError(`could not create a temporary file in ${this.dir}: ${describeFsError(error)}`);
    }
    try {
      try {
        await handle.writeFile(payload, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tempPath, this.fileMode);
      await rename(tempPath, this.file);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw new TypeSafeConfigError(`could not replace ${this.file}: ${describeFsError(error)}`);
    }
    await syncDirectory(this.dir);
  }
}
