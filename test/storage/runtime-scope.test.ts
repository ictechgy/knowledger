import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEVELOPMENT_ORGANIZATIONS,
  getDevelopmentOrganization,
} from '../../examples/order-workflow/organizations.ts';
import {
  ensureRuntimeScope,
  readRuntimeScope,
  RUNTIME_SCOPE_FILE,
} from '../../packages/storage/runtime-scope.ts';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';

function fixture(): string {
  return mkdtempSync(join(tmpdir(), 'kcl-runtime-scope-'));
}

function outboxName(index = 0): string {
  const organization = DEVELOPMENT_ORGANIZATIONS[index];
  return `${organization.org_id}-${organization.key_id}-outbox.sqlite`;
}

test('development organization descriptors are fixed and reject untrusted values', () => {
  assert.deepEqual(DEVELOPMENT_ORGANIZATIONS.map(value => value.peer_port), [17051, 18051, 19051]);
  assert.equal(getDevelopmentOrganization('SalesMSP').subject, 'dev-sales-owner');
  assert.equal(getDevelopmentOrganization('FulfillmentMSP').peer_port, 18051);
  assert.throws(() => getDevelopmentOrganization('ExternalMSP'), /organization/i);
  assert.throws(() => getDevelopmentOrganization({ org_id: 'SalesMSP', peer_port: 9999 }), /organization/i);
  assert.equal(Object.isFrozen(DEVELOPMENT_ORGANIZATIONS), true);
  assert.equal(Object.isFrozen(getDevelopmentOrganization('SalesMSP')), true);
});

test('scoped data cannot be opened through the unauthenticated local application', async t => {
  const directory = fixture(); t.after(() => rmSync(directory, {recursive:true, force:true}));
  ensureRuntimeScope(directory, getDevelopmentOrganization('SalesMSP'));
  await assert.rejects(createApp({ dataDir: directory }), /organization/i);
  assert.equal(existsSync(join(directory, 'shared-ledger.sqlite')), false);
  let closed = false;
  await assert.rejects(createApp({ dataDir: directory, organization: getDevelopmentOrganization('SalesMSP'),
    ledger: { mode:'fabric-test-network', close() { closed=true; } } as any }), /authenticated/i);
  assert.equal(closed, true);
});

test('scope checks preserve existing unscoped directory permissions and reject filesystem roots', t => {
  const directory = fixture(); t.after(() => rmSync(directory, {recursive:true, force:true}));
  chmodSync(directory, 0o755);
  ensureRuntimeScope(directory);
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
  assert.throws(() => ensureRuntimeScope('/'), /root/i);
});

test('legacy scoped descriptors require an explicit channel', () => {
  const dataDir = fixture();
  try {
    assert.throws(() => ensureRuntimeScope(dataDir, { org_id: 'OrgA', key_id: 'actor-a' } as any), /scope|channel|invalid/i);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('scoped startup binds an empty directory before runtime databases are opened', () => {
  const dataDir = fixture();
  try {
    ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[0]);
    assert.deepEqual(readRuntimeScope(dataDir), {
      version: 1,
      ledger: 'fabric-test-network',
      channel_id: 'kcl-demo',
      organization: 'SalesMSP',
    });
    assert.equal(readFileSync(join(dataDir, RUNTIME_SCOPE_FILE), 'utf8'), '{"version":1,"ledger":"fabric-test-network","channel_id":"kcl-demo","organization":"SalesMSP"}\n');
    assert.equal(lstatSync(dataDir).mode & 0o777, 0o700);
    assert.equal(lstatSync(join(dataDir, RUNTIME_SCOPE_FILE)).mode & 0o777, 0o600);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('same organization can restart, while downgrade and cross-organization reuse fail', () => {
  const dataDir = fixture();
  try {
    ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[0]);
    writeFileSync(join(dataDir, 'fabric-projection.sqlite'), 'projection');
    writeFileSync(join(dataDir, 'private-local.sqlite'), 'private');
    writeFileSync(join(dataDir, outboxName()), 'outbox');
    writeFileSync(join(dataDir, 'private-local.sqlite-wal'), 'sidecar');
    assert.doesNotThrow(() => ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[0]));
    assert.throws(() => ensureRuntimeScope(dataDir), /scoped|organization/i);
    assert.throws(() => ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[1]), /organization/i);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('scoped startup never adopts a nonempty legacy directory', () => {
  const dataDir = fixture();
  try {
    writeFileSync(join(dataDir, 'fabric-projection.sqlite'), 'legacy');
    assert.throws(() => ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[0]), /empty|adopt|legacy/i);
    assert.equal(existsScope(dataDir), false);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

test('foreign files, symlinks, malformed JSON, and duplicate fields are rejected by the scope gate', () => {
  const foreign = fixture();
  try {
    ensureRuntimeScope(foreign, DEVELOPMENT_ORGANIZATIONS[0]);
    writeFileSync(join(foreign, outboxName(1)), 'foreign outbox');
    assert.throws(() => ensureRuntimeScope(foreign, DEVELOPMENT_ORGANIZATIONS[0]), /foreign|scope/i);
  } finally { rmSync(foreign, { recursive: true, force: true }); }

  const malformed = fixture();
  try {
    writeFileSync(join(malformed, RUNTIME_SCOPE_FILE), '{"version":1,"version":1,"ledger":"fabric-test-network","channel_id":"kcl-demo","organization":"SalesMSP"}');
    assert.throws(() => ensureRuntimeScope(malformed, DEVELOPMENT_ORGANIZATIONS[0]), /scope|invalid/i);
  } finally { rmSync(malformed, { recursive: true, force: true }); }

  const linked = fixture();
  const target = join(linked, 'scope-target.json');
  try {
    writeFileSync(target, JSON.stringify({ version: 1, ledger: 'fabric-test-network', channel_id: 'kcl-demo', organization: 'SalesMSP' }));
    symlinkSync(target, join(linked, RUNTIME_SCOPE_FILE));
    assert.throws(() => ensureRuntimeScope(linked, DEVELOPMENT_ORGANIZATIONS[0]), /symlink|scope/i);
  } finally { rmSync(linked, { recursive: true, force: true }); }
});

test('a failed initial network start may restart with the existing binding', () => {
  const dataDir = fixture();
  try {
    ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[2]);
    assert.doesNotThrow(() => ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[2]));
    assert.throws(() => ensureRuntimeScope(dataDir, DEVELOPMENT_ORGANIZATIONS[0]), /organization/i);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

function existsScope(dataDir: string): boolean {
  try { lstatSync(join(dataDir, RUNTIME_SCOPE_FILE)); return true; } catch { return false; }
}
