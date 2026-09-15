import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseStrictJson } from '../fabric/canonical.ts';
import { readRuntimeScope, RUNTIME_SCOPE_FILE } from './runtime-scope.ts';
import { CONFIGURATION_SCOPE_FILE, readConfigurationScope, validateConfigurationBinding } from './configuration-scope.ts';
import type { ConfiguredRuntimeBinding } from './configuration-scope.ts';

export type RuntimeSnapshotMode = 'local' | 'fabric' | 'fabric-scoped' | 'configured-local' | 'configured-fabric';
export type RuntimeSnapshotOperation = 'backup' | 'restore';

export interface RuntimeSnapshotFile {
  name: string;
  size: number;
  sha256: string;
}

export interface RuntimeSnapshotSummary {
  operation: RuntimeSnapshotOperation;
  mode: RuntimeSnapshotMode;
  created_at: string;
  files: RuntimeSnapshotFile[];
  organization?: string;
  binding?: ConfiguredRuntimeBinding;
}

export interface RuntimeSnapshotOptions {
  dataDir: string;
  snapshotDir: string;
}

export class RuntimeSnapshotError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeSnapshotError';
    this.code = code;
  }
}

const MANIFEST_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
export const RUNTIME_SNAPSHOT_MAX_DATABASE_BYTES = 512 * 1024 * 1024;
const MAX_DATABASE_BYTES = RUNTIME_SNAPSHOT_MAX_DATABASE_BYTES;
const MAX_MANIFEST_BYTES = 64 * 1024;
const LEGACY_OUTBOX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}-outbox\.sqlite$/u;
const LOCAL_FILES = ['private-local.sqlite', 'shared-ledger.sqlite'] as const;
const FABRIC_CORE_FILES = ['fabric-projection.sqlite', 'private-local.sqlite'] as const;
const PROFILE_FILES: Record<'local', readonly string[]> = {
  local: LOCAL_FILES,
};

interface FileInventory extends RuntimeSnapshotFile {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface Manifest {
  version: 1 | 2 | 3;
  mode: RuntimeSnapshotMode;
  created_at: string;
  files: RuntimeSnapshotFile[];
  organization?: string;
  binding?: ConfiguredRuntimeBinding;
}

interface SnapshotProfile { mode: RuntimeSnapshotMode; names: readonly string[]; organization?: string; binding?: ConfiguredRuntimeBinding }

function snapshotProfile(mode: RuntimeSnapshotMode, organization?: string, outboxName?: string, binding?: ConfiguredRuntimeBinding): SnapshotProfile {
  if (mode === 'configured-local' || mode === 'configured-fabric') {
    if (!binding || (mode === 'configured-fabric' && !binding.organization)) fail('invalid_scope', 'Configured snapshot binding is invalid');
    return { mode, names: [CONFIGURATION_SCOPE_FILE, ...binding.databases], organization: binding.organization, binding };
  }
  if (mode === 'local') return { mode, names: PROFILE_FILES.local };
  if (mode === 'fabric') return { mode, names: [...FABRIC_CORE_FILES, ...(outboxName ? [outboxName] : [])] };
  if (!organization || !outboxName) fail('invalid_scope', 'Snapshot organization scope is invalid');
  return { mode, organization, names: [RUNTIME_SCOPE_FILE, ...FABRIC_CORE_FILES, outboxName] };
}

function scopeOrganization(directory: string): string | undefined {
  try { return readRuntimeScope(directory)?.organization; }
  catch { return fail('invalid_scope', 'Runtime scope binding is invalid'); }
}

interface OwnedStaging {
  path: string;
  dev: number;
  ino: number;
}

interface OwnedEntry {
  dev: number;
  ino: number;
}

function fail(code: string, message: string): never {
  throw new RuntimeSnapshotError(code, message);
}

function safePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || !isAbsolute(value)) {
    fail('invalid_path', `${label} path must be absolute`);
  }
  const path = resolve(value);
  if (path === parse(path).root) fail('invalid_path', `${label} path cannot be a filesystem root`);
  assertNoSymlinkPath(path, label);
  try {
    // Resolve parent aliases before containment checks (including macOS /var and /tmp).
    return existsSync(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
  } catch { return fail('path_error', `${label} parent directory must exist and be readable`); }
}

function assertNoSymlinkPath(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) fail('symlink_path', `${label} path is a symlink`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof RuntimeSnapshotError) throw error;
    fail('path_error', `${label} path cannot be inspected`);
  }
}

function assertDirectory(path: string, label: string, mustExist: boolean): void {
  assertNoSymlinkPath(path, label);
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('symlink_path', `${label} path is a symlink`);
    if (!stat.isDirectory()) fail('invalid_path', `${label} path is not a directory`);
  } catch (error) {
    if (error instanceof RuntimeSnapshotError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !mustExist) return;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail('missing_path', `${label} directory is missing`);
    fail('path_error', `${label} directory cannot be inspected`);
  }
}

function isNestedOrSame(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function assertDisjoint(first: string, second: string): void {
  if (isNestedOrSame(first, second) || isNestedOrSame(second, first)) fail('overlapping_paths', 'Source and destination paths overlap');
}

function isSqliteName(name: string): boolean {
  return name.endsWith('.sqlite');
}

function sidecarFor(name: string, allowed: readonly string[]): boolean {
  return allowed.some(base => name === `${base}-wal` || name === `${base}-shm` || name === `${base}-journal`);
}

function listSourceEntries(dataDir: string, allowed: readonly string[], allowLegacyOutboxes = false): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dataDir) as string[];
  } catch {
    fail('source_unreadable', 'Runtime data directory cannot be enumerated');
  }
  for (const name of entries) {
    if (sidecarFor(name, allowed)) fail('offline_required', 'Offline backup requires no SQLite WAL, SHM, or journal sidecar');
    if (isSqliteName(name) && !allowed.includes(name) && !(allowLegacyOutboxes && LEGACY_OUTBOX_PATTERN.test(name))) fail('unknown_database', 'Runtime database profile contains an unknown SQLite file');
    if (!allowed.includes(name)) continue;
    let stat;
    try { stat = lstatSync(join(dataDir, name)); } catch { fail('source_unreadable', 'Runtime database cannot be inspected'); }
    if (stat.isSymbolicLink()) fail('symlink_database', 'Runtime database path is a symlink');
    if (!stat.isFile()) fail('invalid_database', 'Runtime database is not a regular file');
  }
  return entries;
}

function detectMode(dataDir: string): SnapshotProfile {
  const configured = readConfigurationScope(dataDir);
  if (configured) {
    const mode = configured.mode === 'fabric' ? 'configured-fabric' : 'configured-local';
    const profile = snapshotProfile(mode, configured.organization, undefined, configured);
    const entries = listSourceEntries(dataDir, profile.names);
    const sqlite = entries.filter(isSqliteName).sort();
    const expected = [...configured.databases].sort();
    if (sqlite.length !== expected.length || sqlite.some((name, index) => name !== expected[index])) fail('unknown_database', 'Configured runtime contains an incomplete or foreign database profile');
    return profile;
  }
  const entries = listSourceEntries(dataDir, [...LOCAL_FILES, ...FABRIC_CORE_FILES], true);
  const sqlite = entries.filter(isSqliteName).sort();
  const organization = scopeOrganization(dataDir);
  if (organization) {
    const candidates = sqlite.filter((name) => name.startsWith(`${organization}-`) && LEGACY_OUTBOX_PATTERN.test(name));
    if (candidates.length !== 1) fail('unknown_database', 'Scoped runtime must contain exactly one organization outbox');
    const profile = snapshotProfile('fabric-scoped', organization, candidates[0]);
    const expected = profile.names.filter(isSqliteName).sort();
    if (sqlite.length !== expected.length || sqlite.some((name, index) => name !== expected[index])) fail('unknown_database', 'Scoped runtime contains an incomplete or foreign database profile');
    return profile;
  }
  const local = [...LOCAL_FILES].sort();
  if (sqlite.length === local.length && sqlite.every((name, index) => name === local[index])) return snapshotProfile('local');
  const outboxes = sqlite.filter((name) => LEGACY_OUTBOX_PATTERN.test(name));
  const fabric = [...FABRIC_CORE_FILES, ...outboxes].sort();
  if (outboxes.length >= 1 && outboxes.length <= 128 && sqlite.length === fabric.length && sqlite.every((name, index) => name === fabric[index])) return { mode: 'fabric', names: fabric };
  fail('unknown_database', 'Runtime database profile is missing, mixed, or incomplete');
}

function hashFile(path: string): { size: number; sha256: string; stat: Stats } {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = fstatSync(fd) as Stats;
    if (!stat.isFile() || stat.size > MAX_DATABASE_BYTES) fail('database_limit', 'SQLite database exceeds the offline snapshot size limit');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let total = 0;
    while (total < stat.size) {
      const read = readSync(fd, buffer, 0, Math.min(buffer.byteLength, stat.size - total), total);
      if (read <= 0) fail('source_unreadable', 'Runtime database ended while it was being read');
      hash.update(buffer.subarray(0, read));
      total += read;
    }
    return { size: stat.size, sha256: hash.digest('hex'), stat };
  } catch (error) {
    if (error instanceof RuntimeSnapshotError) throw error;
    return fail('source_unreadable', 'Runtime database cannot be read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function inventoryFile(dataDir: string, name: string): FileInventory {
  const path = join(dataDir, name);
  let linkStat;
  try { linkStat = lstatSync(path); } catch { fail('source_unreadable', 'Runtime database cannot be inspected'); }
  if (linkStat.isSymbolicLink()) fail('symlink_database', 'Runtime database path is a symlink');
  const digest = hashFile(path);
  if (digest.stat.dev !== linkStat.dev || digest.stat.ino !== linkStat.ino || digest.stat.size !== linkStat.size) {
    fail('source_changed', 'Runtime database changed during snapshot preparation');
  }
  return {
    name,
    size: digest.size,
    sha256: digest.sha256,
    dev: digest.stat.dev,
    ino: digest.stat.ino,
    mtimeMs: digest.stat.mtimeMs,
    ctimeMs: digest.stat.ctimeMs,
  };
}

function sqliteIntegrity(path: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: unknown } | undefined;
    if (row?.integrity_check !== 'ok') fail('sqlite_corrupt', 'SQLite integrity check failed');
  } catch (error) {
    if (error instanceof RuntimeSnapshotError) throw error;
    fail('sqlite_corrupt', 'SQLite integrity check failed');
  } finally {
    try { db?.close(); } catch { /* preserve the integrity error */ }
  }
}

function validateSourceDatabases(dataDir: string, profile: SnapshotProfile): FileInventory[] {
  const files = [...profile.names].sort();
  const inventory = files.map(name => inventoryFile(dataDir, name));
  for (const item of inventory) if (item.name !== RUNTIME_SCOPE_FILE && item.name !== CONFIGURATION_SCOPE_FILE) sqliteIntegrity(join(dataDir, item.name));
  if (!profile.binding && scopeOrganization(dataDir) !== profile.organization) fail('invalid_scope', 'Runtime scope does not match its snapshot profile');
  if (profile.binding) {
    const binding = readConfigurationScope(dataDir);
    if (!binding || JSON.stringify(binding) !== JSON.stringify(profile.binding)) fail('invalid_scope', 'Configured runtime binding does not match its snapshot profile');
  }
  listSourceEntries(dataDir, files);
  const afterIntegrity = files.map(name => inventoryFile(dataDir, name));
  for (const item of inventory) {
    const current = afterIntegrity.find(file => file.name === item.name);
    if (!current || !sameInventory(item, current)) fail('source_changed', 'Runtime database changed during integrity verification');
  }
  return afterIntegrity;
}

function sameInventory(before: FileInventory, after: FileInventory): boolean {
  return before.size === after.size && before.sha256 === after.sha256 && before.dev === after.dev && before.ino === after.ino && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function createOwnedDirectory(path: string, label: string): void {
  try {
    mkdirSync(path, { recursive: false, mode: 0o700 });
    chmodSync(path, 0o700);
  } catch {
    fail('destination_error', `${label} staging directory cannot be created`);
  }
}

function stagingPath(destination: string, label: string): OwnedStaging {
  const parent = dirname(destination);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = join(parent, `.${basename(destination)}.kcl-staging-${process.pid}-${Date.now()}-${attempt}`);
    if (!existsSync(candidate)) {
      createOwnedDirectory(candidate, label);
      const stat = lstatSync(candidate);
      return { path: candidate, dev: stat.dev, ino: stat.ino };
    }
  }
  fail('destination_error', `${label} staging directory cannot be reserved`);
}

function cleanOwnedStaging(staging: OwnedStaging, entries: Map<string, OwnedEntry>): void {
  try {
    const stat = lstatSync(staging.path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== staging.dev || stat.ino !== staging.ino || !basename(staging.path).includes('.kcl-staging-')) return;
    for (const [name, identity] of entries) {
      const path = join(staging.path, name);
      try {
        const file = lstatSync(path);
        if (file.isFile() && !file.isSymbolicLink() && file.dev === identity.dev && file.ino === identity.ino) rmSync(path, { force: false });
      } catch { /* leave unexpected or already removed entries in place */ }
    }
    try {
      if (readdirSync(staging.path).length === 0) rmdirSync(staging.path);
    } catch { /* never remove a staging directory we no longer own */ }
  } catch { /* cleanup is best effort and is limited to our staging path */ }
}

function copyExclusive(source: string, destination: string): OwnedEntry {
  try {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, 0o600);
    const stat = lstatSync(destination);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('copy_failed', 'Runtime database copy failed');
    syncPath(destination);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return fail('copy_failed', 'Runtime database copy failed');
  }
}

function writeExclusive(path: string, content: string): OwnedEntry {
  try {
    writeFileSync(path, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(path, 0o600);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) fail('manifest_failed', 'Snapshot manifest cannot be written');
    syncPath(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return fail('manifest_failed', 'Snapshot manifest cannot be written');
  }
}

function validateCopiedFile(path: string, expected: RuntimeSnapshotFile): void {
  const actual = hashFile(path);
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) fail('copy_corrupt', 'Copied runtime database does not match its source hash');
  if (expected.name === RUNTIME_SCOPE_FILE) {
    if (!scopeOrganization(dirname(path))) fail('invalid_scope', 'Snapshot scope binding is missing');
  } else if (expected.name !== CONFIGURATION_SCOPE_FILE) sqliteIntegrity(path);
}

function buildManifest(profile: SnapshotProfile, files: FileInventory[]): Manifest {
  return {
    version: profile.binding ? 3 : profile.organization ? 2 : MANIFEST_VERSION,
    mode: profile.mode,
    ...(profile.organization && !profile.binding ? { organization: profile.organization } : {}),
    ...(profile.binding ? { binding: profile.binding } : {}),
    created_at: new Date().toISOString(),
    files: files.map(({ name, size, sha256 }) => ({ name, size, sha256 })),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readManifest(snapshotDir: string): Manifest {
  const manifestPath = join(snapshotDir, MANIFEST_NAME);
  let manifestStat;
  try { manifestStat = lstatSync(manifestPath); } catch { fail('manifest_missing', 'Snapshot manifest is missing'); }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) fail('manifest_schema', 'Snapshot manifest is not a regular file');
  if (manifestStat.size > MAX_MANIFEST_BYTES) fail('manifest_limit', 'Snapshot manifest exceeds the size limit');
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd) as Stats;
    if (!opened.isFile() || opened.dev !== manifestStat.dev || opened.ino !== manifestStat.ino || opened.size > MAX_MANIFEST_BYTES) fail('manifest_schema', 'Snapshot manifest changed during read');
    bytes = readFileSync(fd);
  } catch (error) {
    if (error instanceof RuntimeSnapshotError) throw error;
    fail('manifest_missing', 'Snapshot manifest cannot be read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail('manifest_limit', 'Snapshot manifest exceeds the size limit');
  let value: unknown;
  try { value = parseStrictJson(bytes); } catch { fail('manifest_json', 'Snapshot manifest JSON is invalid'); }
  if (!isPlainObject(value)) fail('manifest_schema', 'Snapshot manifest fields are invalid');
  const configured = value.mode === 'configured-local' || value.mode === 'configured-fabric';
  const scoped = value.mode === 'fabric-scoped';
  const expectedManifestKeys = configured ? ['binding', 'created_at', 'files', 'mode', 'version'] : scoped ? ['created_at', 'files', 'mode', 'organization', 'version'] : ['created_at', 'files', 'mode', 'version'];
  if (Object.keys(value).sort().join(',') !== expectedManifestKeys.sort().join(',')) fail('manifest_schema', 'Snapshot manifest fields are invalid');
  if (typeof value.created_at !== 'string' || !Array.isArray(value.files)) fail('manifest_schema', 'Snapshot manifest fields are invalid');
  let profile: SnapshotProfile;
  if (configured) {
    if (value.version !== 3 || !isPlainObject(value.binding)) fail('manifest_schema', 'Configured snapshot binding is missing');
    let binding: ConfiguredRuntimeBinding;
    try { binding = validateConfigurationBinding(value.binding); } catch { fail('manifest_schema', 'Configured snapshot binding is invalid'); }
    if ((value.mode === 'configured-fabric') !== (binding.mode === 'fabric')) fail('manifest_schema', 'Configured snapshot mode does not match its binding');
    profile = snapshotProfile(value.mode as RuntimeSnapshotMode, binding.organization, undefined, binding);
  } else {
    if (typeof value.mode !== 'string' || !['local', 'fabric', 'fabric-scoped'].includes(value.mode) || value.version !== (scoped ? 2 : 1)) fail('manifest_schema', 'Snapshot manifest fields are invalid');
    if (scoped && typeof value.organization !== 'string') fail('manifest_schema', 'Snapshot organization must be an identifier');
    profile = scoped ? { mode: 'fabric-scoped', names: [], organization: value.organization as string } : value.mode === 'fabric' ? { mode: 'fabric', names: [] } : snapshotProfile('local');
  }
  const files: RuntimeSnapshotFile[] = [];
  for (const item of value.files) {
    if (!isPlainObject(item) || Object.keys(item).sort().join(',') !== 'name,sha256,size' || typeof item.name !== 'string' || typeof item.size !== 'number' || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_DATABASE_BYTES || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) fail('manifest_schema', 'Snapshot manifest file entry is invalid');
    if (basename(item.name) !== item.name || item.name.includes('/') || item.name.includes('\\')) fail('manifest_path', 'Snapshot manifest contains a path traversal name');
    if (files.some(file => file.name === item.name)) fail('manifest_schema', 'Snapshot manifest contains duplicate files');
    files.push({ name: item.name, size: item.size, sha256: item.sha256 });
  }
  if (scoped) {
    const outboxes = files.map((file) => file.name).filter((name) => LEGACY_OUTBOX_PATTERN.test(name));
    if (outboxes.length !== 1) fail('manifest_schema', 'Scoped snapshot must contain one organization outbox');
    profile = snapshotProfile('fabric-scoped', value.organization as string, outboxes[0]);
  } else if (value.mode === 'fabric') {
    const outboxes = files.map((file) => file.name).filter((name) => LEGACY_OUTBOX_PATTERN.test(name));
    if (outboxes.length < 1 || outboxes.length > 128) fail('manifest_schema', 'Fabric snapshot outbox profile is invalid');
    profile = snapshotProfile('fabric', undefined, undefined, undefined);
    profile = { mode: 'fabric', names: [...FABRIC_CORE_FILES, ...outboxes] };
  }
  const expected = [...profile.names].sort();
  const names = files.map(file => file.name).sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) fail('manifest_schema', 'Snapshot manifest database profile is incomplete or mixed');
  return { version: profile.binding ? 3 : scoped ? 2 : 1, mode: profile.mode, ...(profile.organization ? { organization: profile.organization } : {}), ...(profile.binding ? { binding: profile.binding } : {}), created_at: value.created_at, files: files.sort((a, b) => a.name.localeCompare(b.name)) };
}

function validateSnapshotFiles(snapshotDir: string, manifest: Manifest): void {
  let entries: string[];
  try { entries = readdirSync(snapshotDir, { encoding: 'utf8' }); } catch { fail('snapshot_unreadable', 'Snapshot directory cannot be enumerated'); }
  const expected = [MANIFEST_NAME, ...manifest.files.map(file => file.name)].sort();
  const actual = [...entries].sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) fail('snapshot_files', 'Snapshot contains unknown or missing files');
  for (const file of manifest.files) {
    const path = join(snapshotDir, file.name);
    let stat;
    try { stat = lstatSync(path); } catch { fail('snapshot_unreadable', 'Snapshot database cannot be inspected'); }
    if (stat.isSymbolicLink()) fail('symlink_database', 'Snapshot database path is a symlink');
    if (!stat.isFile()) fail('snapshot_files', 'Snapshot database is not a regular file');
    validateCopiedFile(path, file);
  }
  if (manifest.binding) {
    const binding = readConfigurationScope(snapshotDir);
    if (!binding || JSON.stringify(binding) !== JSON.stringify(manifest.binding)) fail('invalid_scope', 'Snapshot binding and manifest configuration differ');
  } else if (scopeOrganization(snapshotDir) !== manifest.organization) fail('invalid_scope', 'Snapshot binding and manifest organizations differ');
}

function ensureDestinationMissing(path: string, label: string): void {
  assertNoSymlinkPath(path, label);
  if (existsSync(path)) fail('destination_exists', `${label} destination already exists`);
}

function syncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function publishStaging(staging: OwnedStaging, destination: string, label: string): void {
  let reservation: Stats | undefined;
  try {
    syncPath(staging.path);
    mkdirSync(destination, { recursive: false, mode: 0o700 });
    chmodSync(destination, 0o700);
    reservation = lstatSync(destination);
    if (!reservation.isDirectory() || reservation.isSymbolicLink()) fail('destination_race', `${label} destination could not be reserved safely`);
    const current = lstatSync(destination);
    if (current.dev !== reservation.dev || current.ino !== reservation.ino || readdirSync(destination).length !== 0) fail('destination_race', `${label} destination changed before publish`);
    renameSync(staging.path, destination);
    syncPath(dirname(destination));
  } catch (error) {
    if (error instanceof RuntimeSnapshotError) throw error;
    fail('destination_race', `${label} destination could not be published safely`);
  } finally {
    if (reservation) {
      try {
        const current = lstatSync(destination);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === reservation.dev && current.ino === reservation.ino && readdirSync(destination).length === 0) rmdirSync(destination);
      } catch { /* never remove a raced or replaced destination */ }
    }
  }
}

export function createRuntimeSnapshot({ dataDir: rawDataDir, snapshotDir: rawSnapshotDir }: RuntimeSnapshotOptions): RuntimeSnapshotSummary {
  const dataDir = safePath(rawDataDir, 'Data');
  const snapshotDir = safePath(rawSnapshotDir, 'Snapshot');
  assertDirectory(dataDir, 'Data', true);
  assertDirectory(snapshotDir, 'Snapshot', false);
  ensureDestinationMissing(snapshotDir, 'Snapshot');
  assertDisjoint(dataDir, snapshotDir);
  const profile = detectMode(dataDir);
  const before = validateSourceDatabases(dataDir, profile);
  const manifest = buildManifest(profile, before);
  const staging = stagingPath(snapshotDir, 'Snapshot');
  const owned = new Map<string, OwnedEntry>();
  try {
    for (const file of manifest.files) owned.set(file.name, copyExclusive(join(dataDir, file.name), join(staging.path, file.name)));
    listSourceEntries(dataDir, profile.names);
    const after = validateSourceDatabases(dataDir, profile);
    for (const item of before) {
      const current = after.find(file => file.name === item.name);
      if (!current || !sameInventory(item, current)) fail('source_changed', 'Runtime database changed during snapshot');
    }
    for (const file of manifest.files) validateCopiedFile(join(staging.path, file.name), file);
    owned.set(MANIFEST_NAME, writeExclusive(join(staging.path, MANIFEST_NAME), JSON.stringify(manifest)));
    publishStaging(staging, snapshotDir, 'Snapshot');
    return { operation: 'backup', mode: profile.mode, ...(profile.organization ? { organization: profile.organization } : {}), ...(profile.binding ? { binding: profile.binding } : {}), created_at: manifest.created_at, files: manifest.files.map(file => ({ ...file })) };
  } finally {
    cleanOwnedStaging(staging, owned);
  }
}

export function restoreRuntimeSnapshot({ snapshotDir: rawSnapshotDir, dataDir: rawDataDir }: RuntimeSnapshotOptions): RuntimeSnapshotSummary {
  const snapshotDir = safePath(rawSnapshotDir, 'Snapshot');
  const dataDir = safePath(rawDataDir, 'Data');
  assertDirectory(snapshotDir, 'Snapshot', true);
  ensureDestinationMissing(dataDir, 'Data');
  assertDisjoint(snapshotDir, dataDir);
  const manifest = readManifest(snapshotDir);
  validateSnapshotFiles(snapshotDir, manifest);
  const staging = stagingPath(dataDir, 'Data');
  const owned = new Map<string, OwnedEntry>();
  try {
    for (const file of manifest.files) owned.set(file.name, copyExclusive(join(snapshotDir, file.name), join(staging.path, file.name)));
    const currentManifest = manifest.files.map(file => ({ ...file }));
    for (const file of currentManifest) validateCopiedFile(join(staging.path, file.name), file);
    validateSnapshotFiles(snapshotDir, manifest);
    owned.set(MANIFEST_NAME, writeExclusive(join(staging.path, MANIFEST_NAME), JSON.stringify(manifest)));
    publishStaging(staging, dataDir, 'Data');
    return { operation: 'restore', mode: manifest.mode, ...(manifest.organization ? { organization: manifest.organization } : {}), ...(manifest.binding ? { binding: manifest.binding } : {}), created_at: manifest.created_at, files: currentManifest };
  } finally {
    cleanOwnedStaging(staging, owned);
  }
}
