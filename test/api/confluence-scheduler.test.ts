import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';
import { keyFor } from '../../packages/domain/index.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { ConfluenceSyncRuntime } from '../../apps/api/confluence-sync.ts';

async function fixture(t: any, changes: any = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-confluence-scheduler-')); let dataDir = join(root, 'runtime'); const config = createProjectTemplate();
  let calls = 0; const owner = config.bootstrap_actor;
  const source = { source_id: 'confluence-scheduled', cloud_id: '11111111-1111-1111-1111-111111111111', pages: [{ page_id: '123', policy_id: 'policy-shared-guideline', policy_version: 1 }],
    getAccessToken: () => 'FAKE_TOKEN', allows: () => true, fetch: async () => { calls++; return new Response(JSON.stringify({ id: '123', status: 'current', title: 'Scheduled source', version: { number: 1 },
      body: { atlas_doc_format: { value: JSON.stringify({ version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Scheduled body' }] }] }) } } }), { headers: { 'content-type': 'application/json' } }); }, ...changes.source };
  const options = { confluenceSync: { pollMs: changes.pollMs ?? 0, sources: [{ owner: { org_id: owner.org_id, actor_id: owner.actor_id }, source, timeoutMs: changes.timeoutMs ?? 60000 }] } };
  let app = await createConfiguredApp(config, { dataDir, port: 0, ...options }); let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  return { get app() { return app; }, get dataDir() { return dataDir; }, get calls() { return calls; }, owner, source, close, options,
    run: () => app.service.confluenceSync!.runOnce(),
    resetDue() { const vault = (app.service as any).vault; const old = vault.get('source-schedule', source.source_id, owner); vault.replace('source-schedule', source.source_id, owner, { ...old, next_run_at: 0 }); },
    async restore() { await close(); const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir, snapshotDir }); dataDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir, snapshotDir }); app = await createConfiguredApp(config, { dataDir, port: 0, ...options }); closed = false; } };
}

test('scheduled collection creates private drafts, persists due times, and resumes without duplicate drafts after restore', async t => {
  const f = await fixture(t); const before = f.app.service.ledger.checkpoint();
  await Promise.all([f.run(), f.run()]); assert.equal(f.calls, 2); assert.equal((await f.app.service.listDrafts(f.owner, 20)).total, 1);
  await f.run(); assert.equal(f.calls, 2); const state = await f.app.service.sourceAutomations(f.owner); assert.equal(state.schedules[0].status, 'completed');
  await f.restore(); assert.deepEqual(await f.app.service.sourceAutomations(f.owner), state); await f.run(); assert.equal(f.calls, 2);
  f.resetDue(); await f.run(); assert.equal(f.calls, 4); assert.equal((await f.app.service.listDrafts(f.owner, 20)).total, 1); assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  assert.deepEqual((await f.app.service.sourceAutomations({ org_id: 'OrgTwoMSP', actor_id: 'maintainer', kind: 'human' })).schedules, []);
});

test('scheduled collection checks current serving policy before any credential or provider call', async t => {
  const f = await fixture(t); const read = f.app.service.ledger.read.bind(f.app.service.ledger);
  f.app.service.ledger.read = (key: string, at: any) => { const value = read(key, at); return key === keyFor.config() ? { ...value, serving_enabled: false } : value; };
  await f.run(); assert.equal(f.calls, 0); f.app.service.ledger.read = read;
  assert.equal((await f.app.service.sourceAutomations(f.owner)).schedules[0].status, 'failed');
});

test('timeout and shutdown prevent late token results from creating drafts', async t => {
  let release!: (value: string) => void; const f = await fixture(t, { timeoutMs: 20, source: { getAccessToken: () => new Promise(resolve => { release = resolve; }) } });
  await f.run(); release('FAKE_LATE_TOKEN'); await delay(5); assert.equal(f.calls, 0); assert.equal((await f.app.service.listDrafts(f.owner, 20)).total, 0);
  assert.equal((await f.app.service.sourceAutomations(f.owner)).schedules[0].last_code, 'CONFLUENCE_SYNC_CANCELLED');
});

test('shutdown while an import awaits refresh prevents a late private write', async t => {
  const f = await fixture(t); const original = f.app.service.importSourceMarkdown.bind(f.app.service);
  let release!: () => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  f.app.service.importSourceMarkdown = (...args: Parameters<typeof original>) => {
    f.app.service.ledger.refresh = () => { entered(); return new Promise<void>(resolve => { release = resolve; }); }; return original(...args);
  };
  const running = f.run(); await started; await f.close(); await running; release(); await delay(5); assert.equal(f.calls, 2);
  const store = new PrivateStore(join(f.dataDir, 'private-local.sqlite'));
  try { assert.equal(store.listDrafts(f.owner, 20).total, 0); } finally { store.close(); }
});

test('a second database handle cannot claim a source while collection holds its durable lease', async t => {
  let reached!: () => void; let release!: (value: string) => void; const entered = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture(t, { source: { getAccessToken: () => { reached(); return new Promise(resolve => { release = resolve; }); } } });
  const first = f.run(); await entered;
  const vault = new PrivateStore(join(f.dataDir, 'private-local.sqlite'));
  const runtime = new ConfluenceSyncRuntime(vault, (f.app.service.confluenceSync as any).context, f.options.confluenceSync);
  try { await runtime.runOnce(); assert.equal(f.calls, 0); await f.close(); await first; release('FAKE'); await delay(5); assert.equal(f.calls, 0); }
  finally { await runtime.close(); vault.close(); }
});

test('opt-in scheduler starts with the app and exposes only owner-scoped status', async t => {
  const f = await fixture(t, { pollMs: 5 }); const origin = await f.app.listen(0);
  for (let i = 0; i < 100 && !(await f.app.service.listDrafts(f.owner, 20)).total; i++) await delay(5);
  assert.equal((await f.app.service.listDrafts(f.owner, 20)).total, 1); await delay(10); assert.equal(f.calls, 2);
  assert.equal((await fetch(origin + '/v1/workspaces/knowledge/source-automations')).status, 401);
});
