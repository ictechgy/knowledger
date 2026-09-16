import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createDevelopmentClient } from '../../packages/connectors/development-client.ts';
import { loadMarkdownSourceManifest, readMarkdownSource } from '../../packages/connectors/filesystem-markdown.ts';
import { syncMarkdownSource } from '../../packages/connectors/sync-markdown.ts';

const execFileAsync = promisify(execFile);

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-sync-source-test-'));
  const source = join(root, 'source');
  const file = join(source, 'guides', 'handbook.md');
  const manifestPath = join(root, 'manifest.json');
  const config = createProjectTemplate(['FirstMSP', 'SecondMSP'], 'sync-workspace');
  const app = await createConfiguredApp(config, { dataDir: join(root, 'runtime'), port: 0 });
  const server = await app.listen(0);
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirForFile(file);
  const writeManifest = () => writeFileSync(manifestPath, JSON.stringify({ version: 1, source_id: 'repository-guides', files: [{ path: 'guides/handbook.md', policy_id: 'policy-shared-guideline', policy_version: 1, title: 'Handbook' }] }), { mode: 0o600 });
  writeManifest();
  const client = await createDevelopmentClient({ baseUrl: server, workspaceId: 'sync-workspace', orgId: 'FirstMSP', actorId: 'maintainer' });
  const snapshot = async () => readMarkdownSource({ root: source, manifest: loadMarkdownSourceManifest(manifestPath) });
  return { root, source, file, app, client, snapshot, writeManifest };
}

function mkdirForFile(path: string): void {
  const directory = path.slice(0, path.lastIndexOf('/'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

test('development client handshakes a local session and syncs only changed files', async t => {
  const api = await fixture(t);
  writeFileSync(api.file, '\uFEFF# Handbook\r\n\r\nFirst snapshot.\r\n', { mode: 0o600 });
  const first = await syncMarkdownSource(api.client, await api.snapshot());
  assert.equal(first.counts.imported, 1);
  const events = api.app.service.ledger.events(0, 1000).length;
  const noop = await syncMarkdownSource(api.client, await api.snapshot());
  assert.deepEqual(noop.counts, { imported: 0, unchanged: 0, skipped: 1, removed: 0 });
  assert.equal(noop.source.version, first.source.version);
  const cli = await execFileAsync(process.execPath, ['tools/kb-sync.ts', '--root', api.source, '--manifest', join(api.root, 'manifest.json'), '--server', api.client.baseUrl, '--workspace', 'sync-workspace', '--org', 'FirstMSP', '--actor', 'maintainer'], { cwd: process.cwd() });
  assert.deepEqual(JSON.parse(cli.stdout), { imported: 0, unchanged: 0, skipped: 1, removed: 0, version: first.source.version });
  writeFileSync(api.file, '# Updated snapshot\n', { mode: 0o600 });
  const changed = await syncMarkdownSource(api.client, await api.snapshot());
  assert.equal(changed.counts.imported, 1);
  assert.equal(changed.source.version, first.source.version + 1);
  assert.equal(api.app.service.ledger.events(0, 1000).length, events);
});

test('sync reconciles deleted files before uploads and keeps source state actor-private', async t => {
  const api = await fixture(t);
  writeFileSync(api.file, '# Initial\n', { mode: 0o600 });
  const first = await syncMarkdownSource(api.client, await api.snapshot());
  unlinkSync(api.file);
  const removed = await syncMarkdownSource(api.client, await api.snapshot());
  assert.equal(removed.counts.removed, 1);
  assert.equal(removed.source.version, first.source.version + 1);
  const foreign = await createDevelopmentClient({ baseUrl: api.client.baseUrl, workspaceId: 'sync-workspace', orgId: 'SecondMSP', actorId: 'maintainer' });
  writeFileSync(api.file, '# Foreign owner\n', { mode: 0o600 });
  const other = await syncMarkdownSource(foreign, await api.snapshot());
  assert.equal(other.counts.imported, 1);
  assert.equal(other.source.source_id, removed.source.source_id);
  assert.notEqual(other.source.entries[0].draft_id, removed.source.entries[0].draft_id);
});

test('sync stops on a CAS conflict without issuing an upload or retry', async t => {
  const api = await fixture(t);
  writeFileSync(api.file, '# Initial\n', { mode: 0o600 });
  const first = await syncMarkdownSource(api.client, await api.snapshot());
  unlinkSync(api.file);
  const snapshot = await api.snapshot();
  const calls: string[] = [];
  const fake = { request: async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path === '/sources/repository-guides') return first.source as T;
    throw Object.assign(new Error('CAS'), { status: 409, code: 'SOURCE_VERSION_CONFLICT' });
  } };
  await assert.rejects(() => syncMarkdownSource(fake, snapshot), error => { assert.equal((error as any).status, 409); return true; });
  assert.deepEqual(calls, ['/sources/repository-guides', '/sources/repository-guides/reconcile']);
});

test('development client rejects OIDC or wrong actor/workspace during handshake', async t => {
  const api = await fixture(t);
  await assert.rejects(() => createDevelopmentClient({ baseUrl: api.client.baseUrl, workspaceId: 'wrong-workspace', orgId: 'FirstMSP', actorId: 'maintainer' }));
  await assert.rejects(() => createDevelopmentClient({ baseUrl: api.client.baseUrl, workspaceId: 'sync-workspace', orgId: 'UnknownMSP', actorId: 'maintainer' }));
  await assert.rejects(() => createDevelopmentClient({ baseUrl: 'https://example.com', workspaceId: 'sync-workspace', orgId: 'FirstMSP', actorId: 'maintainer' }));
  await assert.rejects(
    () => execFileAsync(process.execPath, ['tools/kb-sync.ts', '--root', api.source, '--manifest', join(api.root, 'does-not-exist.json'), '--server', api.client.baseUrl, '--workspace', 'sync-workspace', '--org', 'UnknownMSP', '--actor', 'maintainer'], { cwd: process.cwd() }),
    error => { assert.match(String((error as any).stderr), /HANDSHAKE_FAILED/); assert.doesNotMatch(String((error as any).stderr), /does-not-exist/); return true; },
  );
});

test('sync rejects incomplete or remapped snapshots before making any API request',async t=>{
  const api=await fixture(t);writeFileSync(api.file,'# Snapshot');const snapshot=await api.snapshot();let calls=0;
  const client={request:async<T>()=>{calls++;return {} as T;}};
  await assert.rejects(syncMarkdownSource(client,{...snapshot,files:[],missing_paths:[]}));
  const changed=structuredClone(snapshot);changed.files[0].mapping={...changed.files[0].mapping,title:'Not the manifest title'};
  await assert.rejects(syncMarkdownSource(client,changed));assert.equal(calls,0);
});
