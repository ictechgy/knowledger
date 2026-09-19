import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { LocalVectorIndex, cosineSimilarity, developmentEmbedding } from '../../packages/storage/vector-index.ts';
import type { VectorIndexEntry } from '../../packages/storage/vector-index.ts';
import { PgVectorIndex } from '../../packages/storage/pgvector-index.ts';
import { demoFixtures, actorIdentity, PERSONAS } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { demoDefinition } from '../../examples/order-workflow/config.ts';

const fixtures = demoFixtures();
const sales = fixtures.revisions[0];
const actor = actorIdentity(PERSONAS[0]);

async function fixture(t: any, options: any = {}) {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  const service = new KnowledgerService(ledger, vault, demoDefinition(), undefined, options);
  await service.initialize();
  await seedDemo(service);
  t.after(() => { ledger.close(); vault.close(); });
  return { service, ledger, vault };
}

const entry = (index: number, embedding: readonly number[] = [1, 0, 0]): VectorIndexEntry => {
  const payload = fixtures.revisions[index].payload;
  return { document_id: payload.document_id, revision_digest: fixtures.revisions[index].revision_digest,
    context_id: payload.context_id, scope_id: payload.scope_id, usage_scope: payload.usage_scope, embedding };
};

test('LocalVectorIndex ranks by cosine similarity and filters by slot fields', () => {
  const index = new LocalVectorIndex();
  index.upsert(entry(0, [1, 0, 0]));
  index.upsert(entry(1, [0, 1, 0]));
  index.upsert(entry(2, [1, 1, 0]));
  const ranked = index.candidates({ embedding: [1, 0, 0], limit: 10 });
  assert.equal(ranked.length, 3);
  assert.equal(ranked[0]!.revision_digest, sales.revision_digest);
  const filtered = index.candidates({ embedding: [1, 0, 0], limit: 10, context_id: 'context-fulfillment' });
  assert.deepEqual(filtered.map(item => item.revision_digest), [fixtures.revisions[1].revision_digest]);
  assert.equal(index.candidates({ embedding: [1, 0, 0], limit: 10, usage_scope: 'missing/v1' }).length, 0);
});

test('LocalVectorIndex drops removed entries and rejects malformed input', () => {
  const index = new LocalVectorIndex();
  index.upsert(entry(0));
  assert.equal(index.size, 1);
  index.remove(sales.revision_digest);
  assert.equal(index.candidates({ embedding: [1, 0, 0], limit: 10 }).length, 0);
  index.upsert(entry(0));
  index.clear();
  assert.equal(index.size, 0);
  assert.throws(() => index.upsert(entry(0, [Number.NaN])), TypeError);
  assert.throws(() => index.candidates({ embedding: [], limit: 10 }), TypeError);
  assert.throws(() => index.candidates({ embedding: [1], limit: 0 }), TypeError);
  // 차원 불일치는 조용한 0점이 아니라 설정 오류다.
  assert.throws(() => cosineSimilarity([1, 0], [0]), TypeError);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.equal(developmentEmbedding('주문 완료 기준').length, 64);
});

test('PgVectorIndex guards its configuration and lazily requires the optional pg package', async () => {
  assert.throws(() => new PgVectorIndex({ connection: {}, table: 'bad-name!', indexVersion: 1 }), TypeError);
  assert.throws(() => new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 0 }), TypeError);
  const index = new PgVectorIndex({ connection: { connectionString: 'postgres://unused.invalid/kcl' }, table: 'kcl_vector_v1', indexVersion: 1 });
  await assert.rejects(index.upsert(entry(0, [Number.NaN])), TypeError);
  await index.close();
});

test('derived-scan mode enumerates verified revisions, marks results complete, and annotates eligibility', async t => {
  const f = await fixture(t);
  const result = await f.service.vectorSearch(actor, { query: '주문' });
  assert.equal(result.candidate_source, 'derived-scan');
  assert.equal(result.complete, true);
  assert.equal(result.total, fixtures.revisions.length);
  assert.ok(result.checkpoint && typeof result.checkpoint.block_hash === 'string');
  const byDocument = new Map(result.results.map((item: any) => [item.payload.document_id, item]));
  for (const revision of fixtures.revisions) assert.ok(byDocument.has(revision.payload.document_id), `missing ${revision.payload.document_id}`);
  for (const item of result.results) {
    assert.equal(typeof item.score, 'number');
    assert.equal(typeof item.revision_digest, 'string');
    if (item.payload.document_id === 'doc-review-invitation-001') {
      assert.equal(item.eligible, false);
      assert.equal(item.active_agreement, null);
    } else {
      assert.equal(item.eligible, true);
      assert.equal(item.active_agreement.status, 'active');
    }
  }
});

test('derived-scan mode respects scope filters', async t => {
  const f = await fixture(t);
  const result = await f.service.vectorSearch(actor, { query: '주문', context_id: 'context-settlement' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].payload.document_id, 'doc-settlement-accounting-definition-001');
  assert.equal((await f.service.vectorSearch(actor, { query: '주문', usage_scope: 'missing/v1' })).total, 0);
});

test('external index proposes candidates that are re-verified at the checkpoint and marks the page incomplete', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  index.upsert(entry(0, [1, 0, 0]));
  index.upsert(entry(1, [0.5, 0.5, 0]));
  index.upsert({ ...entry(2), revision_digest: 'a'.repeat(64) });
  const result = await f.service.vectorSearch(actor, { query: 'anything' });
  assert.equal(result.candidate_source, 'external-index');
  assert.equal(result.complete, false);
  assert.equal(result.total, 2, 'the unverifiable index digest must be dropped');
  assert.equal(result.results[0].revision_digest, sales.revision_digest);
  assert.equal(result.results[0].score, 1);
  assert.equal(result.results[0].eligible, true);
  assert.ok(result.results[1].score < 1);
});

test('required document refs resolve from verified ledger state even when the index is empty', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'unrelated', document_ids: ['doc-sales-order-definition-001'] });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].revision_digest, sales.revision_digest);
  assert.equal(result.results[0].score, null);
  assert.equal(result.results[0].eligible, true);
});

test('an empty index page is not proof that no knowledge exists', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything' });
  assert.equal(result.total, 0);
  assert.equal(result.complete, false);
  assert.equal(result.candidate_source, 'external-index');
});

test('eligibility is re-verified: an index candidate whose agreement was withdrawn is reported ineligible', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  index.upsert(entry(0));
  await f.service.changeAgreement(actor, 'agreement-sales-001', 'withdraw', { reason: 'vector test withdrawal', command_id: 'withdraw-vector-1' });
  const result = await f.service.vectorSearch(actor, { query: '주문' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].eligible, false);
  assert.equal(result.results[0].active_agreement, null);
  assert.equal(typeof result.results[0].reason, 'string');
});

test('vector search pages follow the cursor and reject invalid input', async t => {
  const f = await fixture(t);
  const first = await f.service.vectorSearch(actor, { query: '주문', limit: 2 });
  assert.equal(first.results.length, 2);
  const second = await f.service.vectorSearch(actor, { query: '주문', limit: 2, cursor: first.next_cursor });
  assert.equal(second.results.length, 2);
  assert.deepEqual(new Set([...first.results, ...second.results].map((item: any) => item.revision_digest)).size, 4);
  await assert.rejects(f.service.vectorSearch(actor, { query: 'x'.repeat(1001) }), (error: any) => error.code === 'INVALID_INPUT');
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q', document_ids: ['bad id!'] }), (error: any) => error.code === 'INVALID_INPUT');
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q', context_id: 'x'.repeat(101) }), (error: any) => error.code === 'INVALID_INPUT');
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q', cursor: 'forged' }), (error: any) => error.code === 'INVALID_CURSOR');
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q', context_id: '' }), (error: any) => error.code === 'INVALID_INPUT');
});

test('scope filters are re-verified against the revision slot, not the index tag', async t => {
  // 색인 태그가 요청 범위에 맞게 붙었어도, 검증된 개정본의 slot이 다르면 결과에서 버린다.
  const index = new LocalVectorIndex();
  index.upsert({ ...entry(0), context_id: 'context-fulfillment' });
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything', context_id: 'context-fulfillment' });
  assert.equal(result.total, 0, 'a mistagged index entry must not leak an out-of-scope revision');
});

test('required refs stay pinned ahead of scored candidates on small pages', async t => {
  const index = new LocalVectorIndex();
  index.upsert(entry(1, [1, 0, 0]));
  index.upsert(entry(2, [0.9, 0.1, 0]));
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything', document_ids: ['doc-sales-order-definition-001'], limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].revision_digest, sales.revision_digest, 'the required ref must not sink off the first page');
  assert.equal(result.results[0].score, null);
});

test('an unavailable external index fails closed with INDEX_UNAVAILABLE', async t => {
  const down = { candidates: () => { throw new Error('connection refused'); } };
  const f = await fixture(t, { vectorIndex: down, embedQuery: () => [1, 0, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }), (error: any) => error.code === 'INDEX_UNAVAILABLE' && error.status === 503);
});

test('the service refuses an external index without a matching query embedder', async t => {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  t.after(() => { ledger.close(); vault.close(); });
  assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { vectorIndex: new LocalVectorIndex() }), /embedQuery/);
  assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { embedRevision: () => [1] }), /embedQuery/);
});

test('rebuildVectorIndex repopulates the index only from verified revisions', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  index.upsert({ ...entry(0), revision_digest: 'b'.repeat(64) }); // 원장에 없는 낡은 행
  const rebuilt = await f.service.rebuildVectorIndex(actor);
  assert.equal(rebuilt.indexed, fixtures.revisions.length);
  assert.equal(index.size, fixtures.revisions.length, 'clear must drop the stale digest before reinsertion');
  const ranked = index.candidates({ embedding: [1, 0, 0], limit: 50 });
  assert.ok(ranked.every(candidate => fixtures.revisions.some((revision: any) => revision.revision_digest === candidate.revision_digest)));
  await assert.rejects(fixture(t).then(f2 => f2.service.rebuildVectorIndex(actor)), (error: any) => error.code === 'UNSUPPORTED_ACTION');
});
