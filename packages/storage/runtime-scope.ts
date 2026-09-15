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
} from 'node:fs';
import { join, resolve, parse } from 'node:path';
import { parseStrictJson } from '../fabric/canonical.ts';

export const RUNTIME_SCOPE_FILE = 'runtime-scope.json';
export const RUNTIME_SCOPE_VERSION = 1 as const;
export const RUNTIME_SCOPE_LEDGER = 'fabric-test-network' as const;

export interface RuntimeScopeOrganization {
  org_id: string;
  key_id: string;
  channel_id: string;
}

export interface RuntimeScope {
  version: 1;
  ledger: 'fabric-test-network';
  channel_id: string;
  organization: string;
}

export class RuntimeScopeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeScopeError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RuntimeScopeError(code, message);
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/u;
function validId(value: unknown): value is string { return typeof value === 'string' && ID_PATTERN.test(value); }

function absoluteDataDir(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 4096) fail('invalid_path', 'Runtime data directory is invalid');
  const dataDir = resolve(raw);
  if (dataDir === parse(dataDir).root) fail('invalid_path', 'A filesystem root cannot be a runtime data directory');
  try {
    const stat = lstatSync(dataDir);
    if (stat.isSymbolicLink()) fail('symlink_path', 'Runtime data directory cannot be a symlink');
    if (!stat.isDirectory()) fail('invalid_path', 'Runtime data path is not a directory');
  } catch (error) {
    if (error instanceof RuntimeScopeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('path_error', 'Runtime data directory cannot be inspected');
    try { mkdirSync(dataDir, { recursive: true, mode: 0o700 }); } catch { fail('path_error', 'Runtime data directory cannot be created'); }
    try {
      const stat = lstatSync(dataDir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('symlink_path', 'Runtime data directory cannot be a symlink');
    } catch { fail('path_error', 'Runtime data directory cannot be inspected'); }
  }
  return realpathSync(dataDir);
}

function scopeFromValue(value: unknown): RuntimeScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_scope', 'Runtime scope binding is invalid');
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== ['channel_id', 'ledger', 'organization', 'version'].join('\0')) fail('invalid_scope', 'Runtime scope binding is invalid');
  if (record.version !== RUNTIME_SCOPE_VERSION || record.ledger !== RUNTIME_SCOPE_LEDGER || !validId(record.channel_id) || !validId(record.organization)) fail('invalid_scope', 'Runtime scope binding is invalid');
  return { version: 1, ledger: 'fabric-test-network', channel_id: record.channel_id, organization: record.organization };
}

function readScopeFile(dataDir: string): RuntimeScope | undefined {
  const path = join(dataDir, RUNTIME_SCOPE_FILE);
  let stat;
  try { stat = lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    fail('scope_unreadable', 'Runtime scope binding cannot be inspected');
  }
  if (stat!.isSymbolicLink()) fail('symlink_scope', 'Runtime scope binding cannot be a symlink');
  if (!stat!.isFile() || stat!.size > 16 * 1024) fail('invalid_scope', 'Runtime scope binding is invalid');
  if ((stat!.mode & 0o777) !== 0o600) fail('scope_permissions', 'Runtime scope binding permissions are invalid');
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > 16 * 1024) fail('invalid_scope', 'Runtime scope binding changed during read');
    bytes = readFileSync(fd);
    if (bytes.length > 16 * 1024) fail('invalid_scope', 'Runtime scope binding is invalid');
  } catch { fail('scope_unreadable', 'Runtime scope binding cannot be read'); }
  finally { if (fd !== undefined) closeSync(fd); }
  try { return scopeFromValue(parseStrictJson(bytes)); } catch (error) {
    if (error instanceof RuntimeScopeError) throw error;
    fail('invalid_scope', 'Runtime scope binding is invalid');
  }
}

function allowedEntries(scope: RuntimeScope, keyId: string): Set<string> {
  const outbox = `${scope.organization}-${keyId}-outbox.sqlite`;
  const databases = ['fabric-projection.sqlite', 'private-local.sqlite', outbox];
  const names = new Set([RUNTIME_SCOPE_FILE, 'manifest.json', ...databases]);
  for (const name of databases) for (const suffix of ['-wal', '-shm', '-journal']) names.add(`${name}${suffix}`);
  return names;
}

function validateEntries(dataDir: string, scope: RuntimeScope, keyId: string): void {
  const allowed = allowedEntries(scope, keyId);
  let entries: string[];
  try { entries = readdirSync(dataDir) as string[]; } catch { fail('scope_unreadable', 'Runtime data directory cannot be enumerated'); }
  for (const name of entries) {
    if (!allowed.has(name)) fail('foreign_runtime_file', 'Runtime data directory contains a file outside its organization scope');
    let stat;
    try { stat = lstatSync(join(dataDir, name)); } catch { fail('scope_unreadable', 'Runtime data entry cannot be inspected'); }
    if (stat!.isSymbolicLink()) fail('symlink_runtime_file', 'Runtime data entries cannot be symbolic links');
    if (!stat!.isFile()) fail('invalid_runtime_file', 'Runtime data entries must be regular files');
  }
}

function writeInitialScope(dataDir: string, organization: RuntimeScopeOrganization): RuntimeScope {
  if (!validId(organization.org_id) || !validId(organization.key_id) || !validId(organization.channel_id)) fail('invalid_scope', 'Runtime scope descriptor is invalid');
  const scope: RuntimeScope = { version: 1, ledger: 'fabric-test-network', channel_id: organization.channel_id, organization: organization.org_id };
  const path = join(dataDir, RUNTIME_SCOPE_FILE);
  const payload = `${JSON.stringify(scope)}\n`;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeFileSync(fd, payload, { encoding: 'utf8' });
    fsyncSync(fd);
    chmodSync(path, 0o600);
    const directoryFd = openSync(dataDir, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') fail('scope_race', 'Runtime scope binding already exists');
    fail('scope_write_failed', 'Runtime scope binding cannot be written');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return scope;
}

/** Validate or atomically create the organization binding before runtime files are opened. */
export function ensureRuntimeScope(dataDir: string, organization?: RuntimeScopeOrganization): void {
  const requested = organization === undefined ? undefined : organization;
  if (requested && (!validId(requested.org_id) || !validId(requested.key_id) || !validId(requested.channel_id))) fail('invalid_scope', 'Runtime scope descriptor is invalid');
  const directory = absoluteDataDir(dataDir);
  const entries = readdirSync(directory) as string[];
  const bound = readScopeFile(directory);
  if (!requested) {
    if (bound) fail('scoped_runtime_requires_organization', 'A scoped runtime requires its organization');
    return;
  }
  if (!bound) {
    if (entries.length !== 0) fail('legacy_runtime_not_adopted', 'A scoped runtime may bind only a new empty data directory');
    try { chmodSync(directory, 0o700); } catch { fail('scope_permissions', 'Runtime data directory permissions cannot be secured'); }
    writeInitialScope(directory, requested);
    return;
  }
  if (bound.organization !== requested.org_id || bound.channel_id !== requested.channel_id) fail('organization_mismatch', 'Runtime scope belongs to another organization or channel');
  if ((lstatSync(directory).mode & 0o777) !== 0o700) fail('scope_permissions', 'Scoped runtime directory must be owner-only');
  validateEntries(directory, bound, requested.key_id);
}

/** Read only the public binding. Missing data directories or bindings return undefined. */
export function readRuntimeScope(dataDir: string): RuntimeScope | undefined {
  const directory = resolve(dataDir);
  let stat;
  try { stat = lstatSync(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new RuntimeScopeError('invalid_path', 'Runtime data path is invalid');
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RuntimeScopeError('invalid_path', 'Runtime data path is invalid');
  return readScopeFile(realpathSync(directory));
}
