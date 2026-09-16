import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';
import { ensureRuntimeScope, readRuntimeScope, RUNTIME_SCOPE_FILE } from '../../packages/storage/runtime-scope.ts';
import { ensureConfigurationScope, readConfigurationScope, CONFIGURATION_SCOPE_FILE, type ConfiguredRuntimeBinding } from '../../packages/storage/configuration-scope.ts';
import { getDevelopmentOrganization } from '../../examples/order-workflow/organizations.ts';

function tempDirectory(): string {
  return mkdtempSync(join(tmpdir(), 'knowledger-runtime-snapshot-'));
}

async function localFixture(root: string): Promise<string> {
  const dataDir = join(root, 'local-data');
  mkdirSync(dataDir, { mode: 0o700 });
  const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), 'channel-snapshot');
  const actor = { org_id: 'SalesMSP', actor_id: 'person-sales', kind: 'human' as const };
  await ledger.transact(actor, async ctx => { await ctx.put('kcl:v1:eligibility_epoch', 1); });
  ledger.close();
  const store = new PrivateStore(join(dataDir, 'private-local.sqlite'));
  store.put('command', 'command-1', actor, { command: 'draft', created_at: '2026-01-01T00:00:00.000Z' });
  store.close();
  writeFileSync(join(dataDir, '.runtime-state'), 'ignore me\n', { mode: 0o600 });
  writeFileSync(join(dataDir, '.env'), 'DO_NOT_READ=secret\n', { mode: 0o600 });
  writeFileSync(join(dataDir, 'service.cert'), 'DO_NOT_READ_CERT\n', { mode: 0o600 });
  return dataDir;
}

function sqliteFixture(path: string, marker: string): void {
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE fixture (marker TEXT NOT NULL);');
  db.prepare('INSERT INTO fixture VALUES (?)').run(marker);
  db.close();
  chmodSync(path, 0o600);
}

function fabricFixture(root: string): string {
  const dataDir = join(root, 'fabric-data');
  mkdirSync(dataDir, { mode: 0o700 });
  sqliteFixture(join(dataDir, 'fabric-projection.sqlite'), 'projection');
  sqliteFixture(join(dataDir, 'private-local.sqlite'), 'private');
  sqliteFixture(join(dataDir, 'SalesMSP-person-sales-owner-outbox.sqlite'), 'sales');
  sqliteFixture(join(dataDir, 'FulfillmentMSP-person-fulfillment-owner-outbox.sqlite'), 'fulfillment');
  sqliteFixture(join(dataDir, 'SettlementMSP-person-settlement-owner-outbox.sqlite'), 'settlement');
  return dataDir;
}

function scopedFabricFixture(root: string): string {
  const dataDir = join(root, 'scoped-fabric-data');
  ensureRuntimeScope(dataDir, getDevelopmentOrganization('SalesMSP'));
  for (const name of ['fabric-projection.sqlite', 'private-local.sqlite', 'SalesMSP-person-sales-owner-outbox.sqlite']) sqliteFixture(join(dataDir, name), 'scoped fixture');
  return dataDir;
}

function configuredFabricFixture(root: string, organizations = 2): { dataDir: string; binding: ConfiguredRuntimeBinding } {
  const dataDir = join(root, `configured-fabric-${organizations}`);
  const outboxes = Array.from({ length: organizations }, (_, index) => `outbox-${String(index + 1).padStart(64, '0')}.sqlite`);
  const binding: ConfiguredRuntimeBinding = {
    version: 1, workspace_id: 'workspace-generic', channel_id: 'channel-generic', mode: 'fabric', authority_digest: `sha256:${'b'.repeat(64)}`,
    organization: organizations === 2 ? 'OrgTwo' : 'OrgFour', databases: ['private-local.sqlite', 'fabric-projection.sqlite', ...outboxes],
  };
  ensureConfigurationScope(dataDir, binding);
  sqliteFixture(join(dataDir, 'private-local.sqlite'), 'private');
  sqliteFixture(join(dataDir, 'fabric-projection.sqlite'), 'projection');
  for (const name of outboxes) sqliteFixture(join(dataDir, name), 'outbox');
  return { dataDir, binding };
}

test('organization-scoped backup preserves the binding and refuses another organization after restore', async t => {
  const root = tempDirectory(); t.after(() => cleanup(root));
  const source = scopedFabricFixture(root); const snapshot = join(root, 'scoped-snapshot'); const restored = join(root, 'scoped-restored');
  const result = createRuntimeSnapshot({ dataDir: source, snapshotDir: snapshot });
  assert.equal(result.mode, 'fabric-scoped');
  assert.equal(result.organization, 'SalesMSP');
  assert.equal(result.files.length, 4);
  assert.ok(result.files.some(file => file.name === RUNTIME_SCOPE_FILE));
  restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: restored });
  assert.equal(readRuntimeScope(restored)?.organization, 'SalesMSP');
  ensureRuntimeScope(restored, getDevelopmentOrganization('SalesMSP'));
  assert.throws(() => ensureRuntimeScope(restored, getDevelopmentOrganization('SettlementMSP')));
  assert.throws(() => ensureRuntimeScope(restored));
  const manifestPath = join(snapshot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.organization = 'FulfillmentMSP';
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'wrong-org-restore') }));
});

test('a scoped directory cannot be silently backed up as an unscoped Fabric profile', async t => {
  const root = tempDirectory(); t.after(() => cleanup(root));
  const source = scopedFabricFixture(root);
  sqliteFixture(join(source, 'FulfillmentMSP-person-fulfillment-owner-outbox.sqlite'), 'foreign organization');
  sqliteFixture(join(source, 'SettlementMSP-person-settlement-owner-outbox.sqlite'), 'foreign organization');
  assert.throws(() => createRuntimeSnapshot({ dataDir: source, snapshotDir: join(root, 'must-not-publish') }));
  assert.equal(existsSync(join(root, 'must-not-publish')), false);
});

test('configured Fabric snapshots preserve a generic two or four organization binding exactly', async t => {
  const root = tempDirectory(); t.after(() => cleanup(root));
  for (const organizations of [2, 4]) {
    const fixture = configuredFabricFixture(root, organizations);
    const snapshot = join(root, `configured-snapshot-${organizations}`);
    const restored = join(root, `configured-restored-${organizations}`);
    const backup = createRuntimeSnapshot({ dataDir: fixture.dataDir, snapshotDir: snapshot });
    assert.equal(backup.mode, 'configured-fabric');
    assert.deepEqual(backup.binding, fixture.binding);
    const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as { version: number; binding: ConfiguredRuntimeBinding; files: { name: string }[] };
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.binding, fixture.binding);
    assert.equal(manifest.files.some(file => file.name === CONFIGURATION_SCOPE_FILE), true);
    const restoredSummary = restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: restored });
    assert.equal(restoredSummary.mode, 'configured-fabric');
    assert.deepEqual(readConfigurationScope(restored), fixture.binding);
    ensureConfigurationScope(restored, fixture.binding);
  }
});

test('configured restore rejects a changed authority binding without publishing a destination', async t => {
  const root = tempDirectory(); t.after(() => cleanup(root));
  const fixture = configuredFabricFixture(root, 2);
  const snapshot = join(root, 'configured-tampered-snapshot');
  createRuntimeSnapshot({ dataDir: fixture.dataDir, snapshotDir: snapshot });
  const manifestPath = join(snapshot, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { binding: ConfiguredRuntimeBinding };
  manifest.binding = { ...manifest.binding, authority_digest: `sha256:${'c'.repeat(64)}` };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const destination = join(root, 'configured-tampered-restore');
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: destination }), /binding|authority|invalid/i);
  assert.equal(existsSync(destination), false);
});

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function startBackupChild(dataDir: string, snapshotDir: string): {
  child: ReturnType<typeof spawn>;
  spawned: Promise<void>;
  result: Promise<{ code: number | null; stdout: string; stderr: string }>;
} {
  const script = `
    import { createRuntimeSnapshot } from ${JSON.stringify(join(process.cwd(), 'packages/storage/runtime-snapshot.ts'))};
    process.stdin.once('data', async () => {
      try {
        await createRuntimeSnapshot({ dataDir: process.env.KNOWLEDGER_SNAPSHOT_DATA, snapshotDir: process.env.KNOWLEDGER_SNAPSHOT_OUT });
        process.stdout.write('ok\\n');
      } catch (error) {
        process.stderr.write(String(error?.code ?? 'snapshot_failed') + '\\n');
        process.exitCode = 1;
      }
    });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, KNOWLEDGER_SNAPSHOT_DATA: dataDir, KNOWLEDGER_SNAPSHOT_OUT: snapshotDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  const spawned = new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, spawned, result };
}

test('backs up a local runtime profile with only whitelisted databases', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  const snapshotDir = join(root, 'local-snapshot');
  const summary = await createRuntimeSnapshot({ dataDir, snapshotDir });
  assert.equal(summary.mode, 'local');
  assert.equal(summary.operation, 'backup');
  assert.deepEqual(summary.files.map(file => file.name), ['private-local.sqlite', 'shared-ledger.sqlite']);
  assert.deepEqual(readdirSync(snapshotDir).sort(), ['manifest.json', 'private-local.sqlite', 'shared-ledger.sqlite']);
  assert.equal(lstatSync(snapshotDir).mode & 0o777, 0o700);
  for (const file of summary.files) assert.equal(lstatSync(join(snapshotDir, file.name)).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(join(snapshotDir, 'manifest.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(manifest.mode, 'local');
  assert.deepEqual(Object.keys(manifest).sort(), ['created_at', 'files', 'mode', 'version']);
  assert.equal(JSON.stringify(manifest).includes('DO_NOT_READ'), false);
});

test('backs up and restores a Fabric profile and preserves database content', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = fabricFixture(root);
  const snapshot = join(root, 'snapshot');
  const target = join(root, 'restored');
  const backup = await createRuntimeSnapshot({ dataDir: source, snapshotDir: snapshot });
  const restored = await restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: target });
  assert.equal(backup.mode, 'fabric');
  assert.equal(restored.mode, 'fabric');
  assert.equal(restored.operation, 'restore');
  for (const file of backup.files) {
    assert.equal(readFileSync(join(target, file.name)).toString('hex'), readFileSync(join(source, file.name)).toString('hex'));
    const db = new DatabaseSync(join(target, file.name), { readOnly: true });
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    db.close();
  }
});

test('rejects sidecars, unknown or mixed SQLite profiles before reading secrets', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  writeFileSync(join(dataDir, 'shared-ledger.sqlite-wal'), 'busy');
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(root, 'sidecar-snapshot') }), /offline|sidecar|wal/i);
  rmSync(join(dataDir, 'shared-ledger.sqlite-wal'));
  for (const suffix of ['-shm', '-journal']) rmSync(join(dataDir, `shared-ledger.sqlite${suffix}`), { force: true });
  writeFileSync(join(dataDir, 'unknown.sqlite'), 'not a database');
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(root, 'unknown-snapshot') }), /profile|sqlite|unknown/i);
  rmSync(join(dataDir, 'unknown.sqlite'));
  writeFileSync(join(dataDir, 'fabric-projection.sqlite'), 'not a database');
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(root, 'mixed-snapshot') }), /profile|mixed/i);
  assert.equal(readFileSync(join(dataDir, '.env'), 'utf8'), 'DO_NOT_READ=secret\n');
});

test('refuses a live read-only source while its WAL sidecar is active', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  const live = new DatabaseSync(join(dataDir, 'shared-ledger.sqlite'));
  live.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE; CREATE TABLE live_wal (marker TEXT); INSERT INTO live_wal VALUES (\'open\');');
  try {
    assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(root, 'live-wal-snapshot') }), /offline|sidecar|wal/i);
  } finally {
    try { live.exec('ROLLBACK'); } catch { /* preserve the source refusal */ }
    live.close();
  }
});

test('rejects symlink databases, nested output paths, and existing destinations', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  const real = join(root, 'real.sqlite');
  sqliteFixture(real, 'symlink');
  rmSync(join(dataDir, 'private-local.sqlite'));
  symlinkSync(real, join(dataDir, 'private-local.sqlite'));
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(root, 'symlink-snapshot') }), /symlink|symbolic/i);
  rmSync(join(dataDir, 'private-local.sqlite'));
  const nested = join(dataDir, 'inside-snapshot');
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: nested }), /nested|overlap|path/i);
  const existing = join(root, 'existing');
  mkdirSync(existing, { mode: 0o700 });
  assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir: existing }), /exist/i);
});

test('detects a source mutation after the first copy and leaves no destination behind', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  const snapshotDir = join(root, 'snapshot');
  const sourcePath = join(dataDir, 'shared-ledger.sqlite');
  const original = readFileSync(sourcePath);
  let copies = 0;
  const originalCopy = fs.copyFileSync.bind(fs);
  const copyMock = mock.method(fs, 'copyFileSync', (source, destination, mode) => {
    const result = originalCopy(source, destination, mode);
    copies += 1;
    if (copies === 1) appendFileSync(sourcePath, Buffer.from('source mutation after first copy'));
    return result;
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir }), /changed|offline|sidecar/i);
  } finally {
    copyMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(copies, 2);
  assert.equal(existsSync(snapshotDir), false);
  assert.equal(readdirSync(root).some(name => name.includes('.knowledger-staging-')), false);
  assert.notDeepEqual(readFileSync(sourcePath), original);
});

test('rejects corrupt or tampered manifests, hashes, path traversal, and unknown snapshot files', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = await localFixture(root);
  const snapshot = join(root, 'snapshot');
  await createRuntimeSnapshot({ dataDir: source, snapshotDir: snapshot });
  const manifestPath = join(snapshot, 'manifest.json');
  const valid = readFileSync(manifestPath, 'utf8');
  writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(valid), mode: ['local'] }));
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-array-mode') }), /manifest/i);
  writeFileSync(manifestPath, valid);
  const secret = join(root, 'secret.env');
  writeFileSync(secret, 'DO_NOT_READ=secret\n', { mode: 0o600 });
  rmSync(manifestPath);
  symlinkSync(secret, manifestPath);
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-manifest-symlink') }), /symlink|manifest/i);
  rmSync(manifestPath);
  writeFileSync(manifestPath, `${valid}${' '.repeat(65 * 1024)}`);
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-manifest-large') }), /size|manifest/i);
  writeFileSync(manifestPath, valid);
  writeFileSync(join(snapshot, 'extra.txt'), 'unexpected', { mode: 0o600 });
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-extra') }), /unknown|unexpected|snapshot/i);
  rmSync(join(snapshot, 'extra.txt'));
  writeFileSync(manifestPath, valid.replace('"private-local.sqlite"', '"../private-local.sqlite"'));
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-traversal') }), /path|name|manifest/i);
  writeFileSync(manifestPath, valid);
  const dbPath = join(snapshot, 'private-local.sqlite');
  writeFileSync(dbPath, Buffer.concat([readFileSync(dbPath), Buffer.from('tamper')]));
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-hash') }), /hash|size|corrupt/i);
  writeFileSync(dbPath, readFileSync(join(source, 'private-local.sqlite')));
  writeFileSync(manifestPath, valid.replace('{"version":1', '{"version":1,"version":1'));
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: join(root, 'target-duplicate') }), /duplicate|manifest|json/i);
});

test('cleans only owned staging files when a later copy fails', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const dataDir = await localFixture(root);
  const snapshotDir = join(root, 'failed-copy-snapshot');
  let copies = 0;
  const originalCopy = fs.copyFileSync.bind(fs);
  const copyMock = mock.method(fs, 'copyFileSync', (source, destination, mode) => {
    copies += 1;
    if (copies === 2) throw new Error('forced copy failure');
    return originalCopy(source, destination, mode);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createRuntimeSnapshot({ dataDir, snapshotDir }), /copy|failed/i);
  } finally {
    copyMock.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(copies, 2);
  assert.equal(existsSync(snapshotDir), false);
  assert.equal(readdirSync(root).some(name => name.includes('.knowledger-staging-')), false);
});

test('rejects symlink snapshot paths and never publishes a partial restore', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = await localFixture(root);
  const realSnapshot = join(root, 'real-snapshot');
  await createRuntimeSnapshot({ dataDir: source, snapshotDir: realSnapshot });
  const symlinkSnapshot = join(root, 'symlink-snapshot');
  symlinkSync(realSnapshot, symlinkSnapshot);
  assert.throws(() => restoreRuntimeSnapshot({ snapshotDir: symlinkSnapshot, dataDir: join(root, 'restore') }), /symlink|symbolic/i);
  assert.equal(existsSync(join(root, 'restore')), false);
});

test('manifest hashes match copied files and use safe bounded fields', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = await localFixture(root);
  const snapshot = join(root, 'snapshot');
  const summary = await createRuntimeSnapshot({ dataDir: source, snapshotDir: snapshot });
  const parsed = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8')) as { files: { name: string; size: number; sha256: string }[] };
  for (const file of parsed.files) {
    const bytes = readFileSync(join(snapshot, file.name));
    assert.equal(file.size, bytes.byteLength);
    assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
  }
  assert.deepEqual(summary.files, parsed.files);
});

test('publishes one destination under concurrent child-process backup attempts and preserves the race loser', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = await localFixture(root);
  const snapshot = join(root, 'concurrent-snapshot');
  const first = startBackupChild(source, snapshot);
  const second = startBackupChild(source, snapshot);
  await Promise.all([first.spawned, second.spawned]);
  first.child.stdin?.write('go\n');
  second.child.stdin?.write('go\n');
  first.child.stdin?.end();
  second.child.stdin?.end();
  const results = await Promise.all([first.result, second.result]);
  assert.deepEqual(results.map(result => result.code).sort(), [0, 1]);
  assert.equal(results.filter(result => result.stdout.includes('ok')).length, 1);
  assert.equal(results.filter(result => result.stderr.includes('destination')).length, 1);
  assert.deepEqual(readdirSync(snapshot).sort(), ['manifest.json', 'private-local.sqlite', 'shared-ledger.sqlite']);
  assert.equal(readdirSync(root).some(name => name.includes('.knowledger-staging-')), false);
  const restored = join(root, 'concurrent-restored');
  await restoreRuntimeSnapshot({ snapshotDir: snapshot, dataDir: restored });
  for (const name of ['private-local.sqlite', 'shared-ledger.sqlite']) assert.deepEqual(readFileSync(join(restored, name)), readFileSync(join(source, name)));
});

test('rejects an output nested through a parent symlink alias without rejecting the alias itself', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  const source = await localFixture(root);
  const sourceParentAlias = join(root, 'source-parent-alias');
  symlinkSync(root, sourceParentAlias);
  const snapshot = join(sourceParentAlias, 'local-data', 'inside-snapshot');
  assert.throws(() => createRuntimeSnapshot({ dataDir: source, snapshotDir: snapshot }), /overlap|nested|path/i);
  assert.deepEqual(readdirSync(source).sort(), ['.env', '.runtime-state', 'private-local.sqlite', 'service.cert', 'shared-ledger.sqlite']);
  assert.equal(existsSync(snapshot), false);
});

test('backs up and restores through the CLI using relative paths from a synthetic cwd', async t => {
  const root = tempDirectory();
  t.after(() => cleanup(root));
  await localFixture(root);
  const cli = join(process.cwd(), 'tools/runtime-snapshot.ts');
  const backup = spawnSync(process.execPath, [cli, 'backup', '--data', 'local-data', '--out', 'relative-snapshot'], { cwd: root, encoding: 'utf8' });
  assert.equal(backup.status, 0, backup.stderr);
  const backupSummary = JSON.parse(backup.stdout) as { mode: string; operation: string; files: unknown[] };
  assert.equal(backupSummary.mode, 'local');
  assert.equal(backupSummary.operation, 'backup');
  assert.equal(backupSummary.files.length, 2);
  const restore = spawnSync(process.execPath, [cli, 'restore', '--snapshot', 'relative-snapshot', '--out', 'relative-restored'], { cwd: root, encoding: 'utf8' });
  assert.equal(restore.status, 0, restore.stderr);
  const restoreSummary = JSON.parse(restore.stdout) as { mode: string; operation: string; files: unknown[] };
  assert.equal(restoreSummary.mode, 'local');
  assert.equal(restoreSummary.operation, 'restore');
  assert.equal(restoreSummary.files.length, 2);
  for (const name of ['private-local.sqlite', 'shared-ledger.sqlite']) assert.deepEqual(readFileSync(join(root, 'local-data', name)), readFileSync(join(root, 'relative-restored', name)));
});
