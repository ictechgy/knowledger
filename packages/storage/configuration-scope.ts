import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { parseStrictJson } from "../fabric/canonical.ts";

export const CONFIGURATION_SCOPE_FILE = "project-binding.json";
export const CONFIGURATION_SCOPE_VERSION = 1 as const;

export interface ConfiguredRuntimeBinding {
  version: 1;
  workspace_id: string;
  channel_id: string;
  mode: "local-simulation" | "fabric";
  authority_digest: string;
  organization?: string;
  databases: string[];
}

export class ConfigurationScopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "ConfigurationScopeError"; this.code = code; }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OUTBOX_PATTERN = /^outbox-[a-f0-9]{64}\.sqlite$/u;
const LOCAL_DATABASES = ["private-local.sqlite", "shared-ledger.sqlite"] as const;
const MAX_DATABASES = 126;
const MAX_FILE_BYTES = 16 * 1024;

function fail(code: string, message: string): never { throw new ConfigurationScopeError(code, message); }

function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail("invalid_binding", `${label} is invalid`);
  return value;
}

function assertDatabases(value: unknown, mode: ConfiguredRuntimeBinding["mode"]): string[] {
  if (!Array.isArray(value) || value.length > MAX_DATABASES + 2 || value.some((name) => typeof name !== "string")) fail("invalid_databases", "Configured database list is invalid");
  const names = [...value] as string[];
  if (new Set(names).size !== names.length) fail("invalid_databases", "Configured database list contains duplicates");
  const expected = mode === "local-simulation"
    ? [...LOCAL_DATABASES]
    : names.filter((name) => OUTBOX_PATTERN.test(name));
  if (mode === "local-simulation" && (names.length !== expected.length || expected.some((name) => !names.includes(name)))) fail("invalid_databases", "Local database list is invalid");
  if (mode === "fabric" && (names.length < 3 || names.length > MAX_DATABASES + 2 || !names.includes("private-local.sqlite") || !names.includes("fabric-projection.sqlite") || expected.length !== names.length - 2)) fail("invalid_databases", "Fabric database list is invalid");
  for (const name of names) {
    if (name === "private-local.sqlite" || name === "shared-ledger.sqlite" || name === "fabric-projection.sqlite" || OUTBOX_PATTERN.test(name)) continue;
    fail("invalid_databases", "Configured database name is invalid");
  }
  return names;
}

export function validateConfigurationBinding(value: unknown): ConfiguredRuntimeBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_binding", "Configured runtime binding is invalid");
  const record = value as Record<string, unknown>;
  const allowed = ["authority_digest", "channel_id", "databases", "mode", "organization", "version", "workspace_id"];
  const keys = Object.keys(record).sort();
  const hasOrganization = record.organization !== undefined;
  const expectedKeys = hasOrganization ? allowed : allowed.filter((key) => key !== "organization");
  if (keys.join("\0") !== expectedKeys.sort().join("\0")) fail("invalid_binding", "Configured runtime binding fields are invalid");
  if (record.version !== CONFIGURATION_SCOPE_VERSION) fail("invalid_binding", "Configured runtime binding version is invalid");
  const workspaceId = assertId(record.workspace_id, "workspace_id");
  const channelId = assertId(record.channel_id, "channel_id");
  if (record.mode !== "local-simulation" && record.mode !== "fabric") fail("invalid_binding", "Configured runtime mode is invalid");
  if (record.mode === "fabric" && !hasOrganization) fail("invalid_binding", "Fabric runtime requires an organization binding");
  const organization = hasOrganization ? assertId(record.organization, "organization") : undefined;
  if (typeof record.authority_digest !== "string" || !DIGEST_PATTERN.test(record.authority_digest)) fail("invalid_binding", "Authority digest is invalid");
  const databases = assertDatabases(record.databases, record.mode);
  return { version: 1, workspace_id: workspaceId, channel_id: channelId, mode: record.mode, authority_digest: record.authority_digest, ...(organization ? { organization } : {}), databases };
}

function absoluteDataDir(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) fail("invalid_path", "Runtime data directory is invalid");
  const path = resolve(raw);
  if (path === parse(path).root) fail("invalid_path", "A filesystem root cannot be a runtime data directory");
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("invalid_path", "Runtime data directory is invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("invalid_path", "Runtime data directory cannot be inspected");
    try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch { fail("invalid_path", "Runtime data directory cannot be created"); }
  }
  try { return realpathSync(path); } catch { fail("invalid_path", "Runtime data directory cannot be resolved"); }
}

function readBindingFile(dataDir: string): ConfiguredRuntimeBinding | undefined {
  const path = join(dataDir, CONFIGURATION_SCOPE_FILE);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail("scope_unreadable", "Configured runtime binding cannot be inspected");
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o777) !== 0o600) fail("invalid_binding", "Configured runtime binding file is invalid");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_FILE_BYTES) fail("invalid_binding", "Configured runtime binding changed during read");
    return validateConfigurationBinding(parseStrictJson(readFileSync(fd)));
  } catch (error) {
    if (error instanceof ConfigurationScopeError) throw error;
    fail("invalid_binding", "Configured runtime binding cannot be read");
  } finally { if (fd !== undefined) closeSync(fd); }
}

function allowedEntries(binding: ConfiguredRuntimeBinding): Set<string> {
  // Offline restore retains its provenance manifest; it grants no runtime authority.
  const names = new Set([CONFIGURATION_SCOPE_FILE, "manifest.json", ...binding.databases]);
  for (const name of binding.databases) for (const suffix of ["-wal", "-shm", "-journal"]) names.add(`${name}${suffix}`);
  return names;
}

function validateEntries(dataDir: string, binding: ConfiguredRuntimeBinding): void {
  let entries: string[];
  try { entries = readdirSync(dataDir) as string[]; } catch { fail("scope_unreadable", "Configured runtime directory cannot be enumerated"); }
  const allowed = allowedEntries(binding);
  for (const name of entries) {
    if (!allowed.has(name)) fail("foreign_runtime_file", "Runtime data directory contains a file outside its configuration scope");
    const stat = lstatSync(join(dataDir, name));
    if (stat.isSymbolicLink() || !stat.isFile()) fail("invalid_runtime_file", "Runtime data entries must be regular files");
  }
}

function writeBinding(dataDir: string, binding: ConfiguredRuntimeBinding): void {
  const path = join(dataDir, CONFIGURATION_SCOPE_FILE);
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, `${JSON.stringify(binding)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    chmodSync(path, 0o600);
    const directoryFd = openSync(dataDir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("scope_race", "Configured runtime binding already exists");
    fail("scope_write_failed", "Configured runtime binding cannot be written");
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function ensureConfigurationScope(dataDir: string, rawBinding: ConfiguredRuntimeBinding): void {
  const binding = validateConfigurationBinding(rawBinding);
  const directory = absoluteDataDir(dataDir);
  const entries = readdirSync(directory) as string[];
  const current = readBindingFile(directory);
  if (!current) {
    if (entries.length !== 0) fail("legacy_runtime_not_adopted", "A configured runtime may bind only a new empty data directory");
    try { chmodSync(directory, 0o700); } catch { fail("scope_permissions", "Runtime data directory permissions cannot be secured"); }
    writeBinding(directory, binding);
    return;
  }
  if (JSON.stringify(current) !== JSON.stringify(binding)) fail("binding_mismatch", "Configured runtime binding differs from the existing binding");
  if ((lstatSync(directory).mode & 0o777) !== 0o700) fail("scope_permissions", "Configured runtime directory must be owner-only");
  validateEntries(directory, current);
}

export function readConfigurationScope(dataDir: string): ConfiguredRuntimeBinding | undefined {
  const path = resolve(dataDir);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new ConfigurationScopeError("invalid_path", "Runtime data path is invalid");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new ConfigurationScopeError("invalid_path", "Runtime data path is invalid");
  return readBindingFile(realpathSync(path));
}
