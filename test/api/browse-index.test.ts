import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { KclService } from '../../apps/api/service.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any, size = 60) {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-browse-index-'));
  const config = createProjectTemplate(); const actor = config.bootstrap_actor; const policy = config.genesis.policies[0];
  let app = await createConfiguredApp(config, { dataDir: directory, port: 0 });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const revisions = []; let sequence = 0;
  const publish = async (documentId: string, parent?: string) => {
    const draft = await app.service.draft(actor, { document_id: documentId, context_id: policy.context_id,
      scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: `Browse fixture ${++sequence}`,
      body_markdown: '# 검색 한글 😀 I İ literal %_\nBODY_INDEX_CANARY', ...(parent ? { base_revision_digest: parent } : {}) });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `index-publish-${sequence}` });
    return draft.revision;
  };
  for (let index = 0; index < size; index++) revisions.push(await publish(index === 0 ? policy.document_id : `doc-browse-${index}`));
  return { get app() { return app; }, directory, actor, config, policy, revisions, publish,
    async reopen() { await app.close(); app = await createConfiguredApp(config, { dataDir: directory, port: 0 }); } };
}

function observeWork(service: KclService) {
  const ledger = service.ledger;
  const entries = ledger.entries.bind(ledger), read = ledger.read.bind(ledger), creation = ledger.checkpointForStateCreation.bind(ledger);
  const work = { wholeRows: 0, revisionReads: 0, creationReads: 0 };
  ledger.entries = (prefix, at) => { const result = entries(prefix, at); if (['revision', 'proposal', 'agreement'].some(kind => prefix === `kcl:v1:${kind}:`)) work.wholeRows += result.length; return result; };
  ledger.read = (key, at) => { if (key.startsWith('kcl:v1:revision:')) work.revisionReads++; return read(key, at); };
  ledger.checkpointForStateCreation = key => { work.creationReads++; return creation(key); };
  return { work, reset() { work.wholeRows = work.revisionReads = work.creationReads = 0; },
    close() { ledger.entries = entries; ledger.read = read; ledger.checkpointForStateCreation = creation; } };
}

test('indexed pages load canonical values proportional to the page, including after unrelated fences', async t => {
  const f = await fixture(t); const service = f.app.service; const probe = observeWork(service); t.after(() => probe.close());
  const page = await service.overview(f.actor, { limit: 5 });
  assert.equal(page.documents.length, 5); assert.equal(page.documents_total, 60);
  assert.equal(probe.work.wholeRows, 0, 'page selection must not materialize every public record');
  assert.ok(probe.work.revisionReads <= 10); assert.ok(probe.work.creationReads <= 5);
  probe.reset();
  await service.ledger.execute(f.actor, { command_id: 'index-unrelated-fence', type: 'fence', input: { nonce: 'index-unrelated-fence' } });
  const second = await service.overview(f.actor, { limit: 5, cursor: page.next_cursor! });
  assert.deepEqual(second.checkpoint, page.checkpoint); assert.equal(second.documents.length, 5);
  assert.equal(probe.work.wholeRows, 0); assert.ok(probe.work.revisionReads <= 10); assert.ok(probe.work.creationReads <= 5);
  probe.reset();
  const exact = await service.revisionView(f.actor, f.revisions[0].revision_digest);
  assert.equal(exact.payload.body_markdown, f.revisions[0].payload.body_markdown);
  assert.equal(probe.work.wholeRows, 0); assert.ok(probe.work.revisionReads <= 3);
});

test('search cursor pages reuse bounded ID matches without rescanning the corpus and preserve JS substring semantics', async t => {
  const f = await fixture(t); const service = f.app.service;
  const first = await service.search(f.actor, { query: 'BODY_INDEX_CANARY', limit: 5 });
  const probe = observeWork(service); t.after(() => probe.close());
  const second = await service.search(f.actor, { query: 'BODY_INDEX_CANARY', limit: 5, cursor: first.next_cursor! });
  assert.equal(second.total, 60); assert.equal(second.results.length, 5);
  assert.equal(probe.work.wholeRows, 0); assert.ok(probe.work.revisionReads <= 10, 'a cached search page must not re-read all candidate bodies');
  for (const query of ['', '한', '검색', '%_', '\n', 'i', 'İ', '😀', 'not-present']) {
    const expected = f.revisions.filter(revision => `${revision.payload.title}\n${revision.payload.body_markdown}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).length;
    const result = await service.search(f.actor, { query }); assert.equal(result.total, expected, `query ${JSON.stringify(query)}`);
  }
  await assert.rejects(service.search(f.actor, { query: '\ud83d' }), (error: any) => error.code === 'INVALID_INPUT');
  for (const field of ['context_id', 'scope_id', 'usage_scope']) {
    const result = await service.search(f.actor, { query: 'BODY_INDEX_CANARY', [field]: 'missing-scope' });
    assert.equal(result.total, 0, `search must respect ${field}`);
  }
  const original = await service.search(f.actor, { query: '%_', limit: 5 });
  await f.publish('doc-after-search');
  assert.equal((await service.search(f.actor, { query: '%_', limit: 5, cursor: original.next_cursor! })).total, 60);
  assert.equal((await service.search(f.actor, { query: '%_' })).total, 61);
});

function withoutCursors(value: any): any {
  if (Array.isArray(value)) return value.map(withoutCursors);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, key.endsWith('cursor') ? Boolean(item) : withoutCursors(item)]));
  return value;
}

test('indexed API equals verified scanning fallback and reopens without index persistence', async t => {
  const f = await fixture(t, 8); const service = f.app.service;
  const proxy = new Proxy(service.ledger, { get(target, key) { if (key === 'queryBrowse') return undefined; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const vault = new PrivateStore(':memory:'); t.after(() => vault.close());
  const scan = new KclService(proxy, vault, service.definition); await scan.initialize();
  const original = f.revisions[0];
  const proposal = await service.propose(f.actor, { command_id: 'index-propose', revision_digest: original.revision_digest, policy_id: f.policy.policy_id, policy_version: 1 });
  await f.publish(original.payload.document_id, original.revision_digest);
  for (const method of [() => service.overview(f.actor, { limit: 3 }), () => service.revisionHistory(f.actor, original.revision_digest), () => service.revisionView(f.actor, original.revision_digest), () => service.search(f.actor, { query: '한' })].entries()) {
    const alternatives = [() => scan.overview(f.actor, { limit: 3 }), () => scan.revisionHistory(f.actor, original.revision_digest), () => scan.revisionView(f.actor, original.revision_digest), () => scan.search(f.actor, { query: '한' })];
    assert.deepEqual(withoutCursors(await method[1]()), withoutCursors(await alternatives[method[0]]()));
  }
  assert.equal((await service.getProposal(f.actor, proposal.result.proposal_id)).revision_digest, original.revision_digest);
  const before = await service.overview(f.actor); await f.reopen();
  assert.deepEqual(withoutCursors(await f.app.service.overview(f.actor)), withoutCursors(before));
});

test('indexed candidates cannot hide a missing or corrupted selected canonical revision', async t => {
  const f = await fixture(t, 3); const page = await f.app.service.overview(f.actor);
  const key = keyFor.revision(page.documents[0].revision_digest);
  const db = new DatabaseSync(join(f.directory, 'shared-ledger.sqlite'));
  db.prepare('DELETE FROM projection_history WHERE state_key = ?').run(key); db.close();
  await assert.rejects(f.app.service.overview(f.actor), /integrity|원장|개정|projection/i);
});

test('cached browse references retain historical status while fresh withdrawal is withheld', async t => {
  const f = await fixture(t, 2); const service = f.app.service; const revision = f.revisions[0];
  const proposal = await service.propose(f.actor, { revision_digest: revision.revision_digest, policy_id: f.policy.policy_id, policy_version: 1, command_id: 'indexed-activation-proposal' });
  for (const { org_id, actor_id, kind } of f.config.identities) await service.decide({ org_id, actor_id, kind }, proposal.result.proposal_id,
    { decision: 'approve', rationale: 'Synthetic indexed review', command_id: 'indexed-approve-' + org_id });
  const active = await service.activate(f.actor, proposal.result.proposal_id, { expected_active_agreement_id: null, command_id: 'indexed-activate' });
  const page = await service.overview(f.actor, { limit: 1 }); assert.ok(page.next_cursor);
  await service.search(f.actor, { query: 'BODY_INDEX_CANARY', limit: 1 });
  await service.changeAgreement(f.actor, active.result.agreement_id, 'withdraw', { reason: 'Index regression fixture', command_id: 'indexed-withdraw' });
  const old = await service.overview(f.actor, { limit: 1, cursor: page.next_cursor! });
  assert.equal(old.documents[0].revision_digest, revision.revision_digest); assert.equal(old.documents[0].eligible, true);
  const fresh = await service.revisionView(f.actor, revision.revision_digest);
  assert.equal(fresh.eligible, false); assert.equal(fresh.agreement.status, 'withdrawn'); assert.equal(fresh.active_agreement, null);
  const resolved = await service.resolve(f.actor, { document_ids: [f.policy.document_id], context_id: f.policy.context_id, scope_id: f.policy.scope_id, usage_scope: f.policy.usage_scope });
  assert.equal(resolved.status, 'withheld');
});
