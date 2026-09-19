import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { LocalVectorIndex, cosineSimilarity, developmentEmbedding } from '../../packages/storage/vector-index.ts';
import type { VectorIndexEntry } from '../../packages/storage/vector-index.ts';
import { PgVectorIndex } from '../../packages/storage/pgvector-index.ts';
import { demoFixtures, actorIdentity, PERSONAS, BOOTSTRAP_ACTOR, demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo, createDemoApp } from '../../examples/order-workflow/application.ts';

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

test('PgVectorIndex guards its configuration and entry shapes', async () => {
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
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  index.upsert(entry(0, [1, 0, 0]));
  index.upsert(entry(1, [0.5, 0.5, 0]));
  // 형식은 유효하지만 원장에 없는 다이제스트 — 형식 필터가 아니라 재검증에서 버려져야 한다.
  index.upsert({ ...entry(2), revision_digest: `sha256:${'a'.repeat(64)}` });
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
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'unrelated', document_ids: ['doc-sales-order-definition-001'] });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].revision_digest, sales.revision_digest);
  assert.equal(result.results[0].score, null);
  assert.equal(result.results[0].eligible, true);
});

test('an empty index page is not proof that no knowledge exists', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything' });
  assert.equal(result.total, 0);
  assert.equal(result.complete, false);
  assert.equal(result.candidate_source, 'external-index');
});

test('eligibility is re-verified: an index candidate whose agreement was withdrawn is reported ineligible', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
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
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything', context_id: 'context-fulfillment' });
  assert.equal(result.total, 0, 'a mistagged index entry must not leak an out-of-scope revision');
});

test('required refs stay pinned ahead of scored candidates on small pages', async t => {
  const index = new LocalVectorIndex();
  index.upsert(entry(1, [1, 0, 0]));
  index.upsert(entry(2, [0.9, 0.1, 0]));
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'anything', document_ids: ['doc-sales-order-definition-001'], limit: 1 });
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].revision_digest, sales.revision_digest, 'the required ref must not sink off the first page');
  assert.equal(result.results[0].score, null);
});

test('an unavailable external index fails closed with INDEX_UNAVAILABLE', async t => {
  const down = { candidates: () => { throw new Error('connection refused'); } };
  const f = await fixture(t, { vectorIndex: down, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }), (error: any) => error.code === 'INDEX_UNAVAILABLE' && error.status === 503);
});

test('the service refuses an external index without a matching query embedder', async t => {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  t.after(() => { ledger.close(); vault.close(); });
  assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { vectorIndex: new LocalVectorIndex() }), /embedQuery/);
  assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { embedRevision: () => [1] }), /embedQuery/);
  // embedQuery만 주어지면 embedRevision이 개발용 64차원으로 조용히 채워진다 — 쌍으로만 받는다.
  assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { embedQuery: () => [1, 0, 0] }), /together/);
});

test('rebuildVectorIndex repopulates the index only from verified revisions', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  index.upsert({ ...entry(0), revision_digest: `sha256:${'b'.repeat(64)}` }); // 원장에 없는 낡은 행
  // 전수 스캔·전체 교체를 유발하므로 배포 운영자(bootstrap actor)만 실행할 수 있다.
  await assert.rejects(f.service.rebuildVectorIndex(actor), (error: any) => error.code === 'FORBIDDEN');
  const rebuilt = await f.service.rebuildVectorIndex(BOOTSTRAP_ACTOR);
  assert.equal(rebuilt.indexed, fixtures.revisions.length);
  assert.equal(index.size, fixtures.revisions.length, 'replaceAll must drop the stale digest atomically');
  const ranked = index.candidates({ embedding: [1, 0, 0], limit: 50 });
  assert.ok(ranked.every(candidate => fixtures.revisions.some((revision: any) => revision.revision_digest === candidate.revision_digest)));
  await assert.rejects(fixture(t).then(f2 => f2.service.rebuildVectorIndex(BOOTSTRAP_ACTOR)), (error: any) => error.code === 'UNSUPPORTED_ACTION');
});

test('index configuration errors are reported non-retryable, not as retryable 503', async t => {
  const misconfigured = { candidates: () => { throw new TypeError('Embedding dimensions do not match'); } };
  const f = await fixture(t, { vectorIndex: misconfigured, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }), (error: any) => error.code === 'INDEX_MISCONFIGURED' && error.status === 500 && !error.retryable);
  const invalidEmbedding = await fixture(t, { vectorIndex: new LocalVectorIndex(), embedQuery: () => [Number.NaN], embedRevision: () => [1] });
  await assert.rejects(invalidEmbedding.service.vectorSearch(actor, { query: 'q' }), (error: any) => error.code === 'INDEX_MISCONFIGURED' && !error.retryable);
});

test('malformed index rows are dropped before they can disturb ranking', async t => {
  const messy = { candidates: () => ([
    { revision_digest: 'not-a-digest', score: 0.9 },
    { revision_digest: sales.revision_digest, score: Number.NaN },
    { revision_digest: sales.revision_digest, score: 0.5 },
  ]) };
  const f = await fixture(t, { vectorIndex: messy, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'q' });
  assert.equal(result.total, 1);
  assert.equal(result.results[0].revision_digest, sales.revision_digest);
  assert.equal(result.results[0].score, 0.5);
});

test('an index change between pages invalidates the cursor instead of skipping rows', async t => {
  const index = new LocalVectorIndex();
  index.upsert(entry(0, [1, 0, 0]));
  index.upsert(entry(1, [0.9, 0.1, 0]));
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const first = await f.service.vectorSearch(actor, { query: 'anything', limit: 1 });
  assert.equal(first.results.length, 1);
  assert.ok(first.next_cursor);
  index.upsert(entry(2, [0.8, 0.2, 0])); // 페이지 사이의 색인 변경
  await assert.rejects(f.service.vectorSearch(actor, { query: 'anything', limit: 1, cursor: first.next_cursor }),
    (error: any) => error.code === 'INVALID_CURSOR');
  const stable = await f.service.vectorSearch(actor, { query: 'anything', limit: 1 });
  const second = await f.service.vectorSearch(actor, { query: 'anything', limit: 1, cursor: stable.next_cursor });
  assert.equal(second.results.length, 1, 'an unchanged index keeps the cursor valid');
});

test('a superseded revision stays visible but is reported ineligible', async t => {
  const index = new LocalVectorIndex();
  index.upsert(entry(0));
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const policy = fixtures.policies[0];
  const draft = await f.service.draft(actor, { document_id: sales.payload.document_id, base_revision_digest: sales.revision_digest,
    context_id: sales.payload.context_id, scope_id: sales.payload.scope_id, usage_scope: sales.payload.usage_scope,
    title: '주문 정의 v2', body_markdown: '# superseding revision' });
  const preview = await f.service.preview(actor, { draft_id: draft.draft_id });
  await f.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'publish-supersede' });
  const proposed = await f.service.propose(actor, { revision_digest: preview.revision_digest, policy_id: policy.policy_id, policy_version: 1, command_id: 'propose-supersede' });
  await f.service.decide(actor, proposed.result.proposal_id, { decision: 'approve', rationale: 'supersede', command_id: 'decide-supersede' });
  await f.service.activate(actor, proposed.result.proposal_id, { expected_active_agreement_id: 'agreement-sales-001', command_id: 'activate-supersede' });
  const result = await f.service.vectorSearch(actor, { query: 'anything', document_ids: [sales.payload.document_id] });
  const stale = result.results.find((item: any) => item.revision_digest === sales.revision_digest);
  assert.ok(stale, 'the superseded digest is still a verified revision');
  assert.equal(stale.eligible, false, 'a superseded agreement must not grant eligibility');
});

test('PgVectorIndex issues version-scoped SQL through an injectable client', async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    on: () => {}, connect: async () => {}, end: async () => {},
    query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return { rows: [] }; },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 7,
    pg: { Client: function () { return client; } } });
  await index.candidates({ embedding: [1, 0, 0], limit: 5, context_id: 'context-sales' });
  // HNSW는 ef_search까지만 후보를 훑는다 — 요청 한도까지 돌려받으려면 올려야 하는데,
  // 세션 전역 설정이 한도 다른 동시 호출과 섞이지 않게 트랜잭션 LOCAL로 묶는다.
  assert.equal(calls[0]!.text, 'BEGIN');
  assert.match(calls[1]!.text, /set_config\('hnsw\.ef_search', \$1, true\)/);
  assert.deepEqual(calls[1]!.values, ['5']);
  const select = calls[2]!;
  assert.match(select.text, /index_version = \$2/);
  assert.match(select.text, /context_id = \$3/);
  assert.match(select.text, /LIMIT \$4/);
  assert.deepEqual(select.values, ['[1,0,0]', 7, 'context-sales', 5]);
  assert.equal(calls[3]!.text, 'COMMIT');

  await index.upsert(entry(0));
  const insert = calls.at(-1)!;
  assert.match(insert.text, /ON CONFLICT \(revision_digest, index_version\)/);
  assert.equal(insert.values.at(-1), 7);

  await index.remove(sales.revision_digest);
  const remove = calls.at(-1)!;
  assert.match(remove.text, /revision_digest = \$1 AND index_version = \$2/);
  assert.deepEqual(remove.values, [sales.revision_digest, 7]);

  calls.length = 0;
  await index.replaceAll([entry(0), entry(1)]);
  assert.equal(calls[0]!.text, 'BEGIN');
  assert.match(calls[1]!.text, /DELETE FROM kcl_vector_v1 WHERE index_version = \$1/);
  assert.equal(calls.at(-1)!.text, 'COMMIT');
  // 두 항목은 200행 배치 한도 안이라 다중행 INSERT 한 번으로 묶인다.
  assert.equal(calls.length, 4, 'begin + delete + one batched insert + commit in one transaction');
  assert.match(calls[2]!.text, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6::vector,\$7\),\(\$8/);

  await index.close();
});

test('PgVectorIndex retries after a failed connection attempt', async () => {
  let attempts = 0;
  const client = {
    on: () => {}, end: async () => {},
    connect: async () => { attempts++; if (attempts === 1) throw new Error('connection refused'); },
    query: async () => ({ rows: [] }),
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  await assert.rejects(index.candidates({ embedding: [1], limit: 1 }), /connection refused/);
  // 거부된 연결 프라미스는 남지 않는다 — 다음 호출이 재연결해야 한다.
  await index.candidates({ embedding: [1], limit: 1 });
  assert.equal(attempts, 2);
  await index.close();
});

test('PgVectorIndex reports a missing pg module as permanent and rethrows other loader failures', async () => {
  // 주입된 로더로 환경과 무관하게 결정한다 — pg가 설치된 CI에서도 같은 경로를 검증한다.
  const missing = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pgLoader: () => Promise.reject(Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' })) });
  await assert.rejects(missing.candidates({ embedding: [1], limit: 1 }),
    (error: any) => error instanceof TypeError && /optional "pg" package/.test(error.message));
  // 모듈 부재가 아닌 로더 실패는 그대로 다시 던져 원인을 보존한다.
  const broken = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pgLoader: () => Promise.reject(new SyntaxError('corrupt pg install')) });
  await assert.rejects(broken.candidates({ embedding: [1], limit: 1 }), /corrupt pg install/);
});

test('PgVectorIndex translates pgvector shape rejections into permanent TypeErrors', async () => {
  const client = {
    on: () => {}, connect: async () => {}, end: async () => {},
    query: async (text: string) => {
      // 트랜잭션 경계·세션 설정은 통과하고 후보 SELECT에서만 차원 오류를 던진다.
      if (!/embedding <=>/.test(text)) return { rows: [] };
      const error: any = new Error('different vector dimensions 3 and 64');
      error.code = '22000';
      throw error;
    },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  await assert.rejects(index.candidates({ embedding: [1, 0, 0], limit: 5 }),
    (error: any) => error instanceof TypeError && /request shape or schema/.test(error.message));
});

test('PgVectorIndex treats missing schema and privilege errors as permanent too', async () => {
  const calls: string[] = [];
  const client = {
    on: () => {}, connect: async () => {}, end: async () => {},
    query: async (text: string) => {
      calls.push(text);
      if (!/embedding <=>/.test(text)) return { rows: [] };
      throw Object.assign(new Error('relation "kcl_vector_v1" does not exist'), { code: '42P01' });
    },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  // 테이블 부재(42P01)는 재시도로 해소되지 않는 설정 오류다 — TypeError로 변환돼야 한다.
  await assert.rejects(index.candidates({ embedding: [1], limit: 1 }),
    (error: any) => error instanceof TypeError && /request shape or schema/.test(error.message));
  assert.ok(calls.some(text => text === 'ROLLBACK'), 'the aborted read transaction is rolled back');
});

test('an over-limit adapter result is truncated to the candidate bound', async t => {
  // 200개까지만 후보가 된다 — 뒤쪽 40행에만 유효 다이제스트를 넣어 절단을 실제로 검증한다.
  const flooded = { candidates: () => [
    ...Array.from({ length: 200 }, () => ({ revision_digest: fixtures.revisions[0].revision_digest, score: 0.9 })),
    ...fixtures.revisions.slice(1).map((revision: any) => ({ revision_digest: revision.revision_digest, score: 0.5 })),
  ] };
  const f = await fixture(t, { vectorIndex: flooded, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const result = await f.service.vectorSearch(actor, { query: 'q' });
  assert.equal(result.total, 1, 'digests that only appear beyond the bound are truncated, not merely deduplicated');
});

test('async embedders are awaited on both query and revision paths', async t => {
  const f = await fixture(t, { embedQuery: async (text: string) => developmentEmbedding(text),
    embedRevision: async (title: string, body: string) => developmentEmbedding(`${title}\n${body}`) });
  const result = await f.service.vectorSearch(actor, { query: '주문' });
  assert.equal(result.candidate_source, 'derived-scan');
  assert.ok(result.total > 0);
});

test('required refs keep a null score in derived-scan mode too', async t => {
  const f = await fixture(t);
  const result = await f.service.vectorSearch(actor, { query: '주문', document_ids: [sales.payload.document_id] });
  const required = result.results.find((item: any) => item.revision_digest === sales.revision_digest);
  assert.ok(required);
  assert.equal(required.score, null, 'required refs stay unranked references in every mode');
});

test('POST /vector-search and /vector-index/rebuild route through the service and close() owns the index', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-vector-route-'));
  const index = new LocalVectorIndex();
  index.upsert(entry(0));
  let closed = 0;
  const tracked = { candidates: (query: any) => index.candidates(query),
    replaceAll: (entries: any) => index.replaceAll(entries), close: () => { closed++; } };
  const app = await createDemoApp({ dataDir: directory, vectorIndex: tracked,
    embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const url = await app.listen(0);
  let appClosed = false;
  t.after(async () => { if (!appClosed) await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = await fetch(`${url}/api/session`);
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const session = await initial.json() as any;
  const post = (path: string, input: any) => fetch(`${url}/v1/workspaces/demo${path}`, { method: 'POST',
    headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify(input) });

  const search = await post('/vector-search', { query: '주문' });
  assert.equal(search.status, 200);
  const body = await search.json() as any;
  assert.equal(body.candidate_source, 'external-index');
  assert.equal(body.results[0].revision_digest, sales.revision_digest);

  // 기본 세션 actor는 bootstrap actor다 — 재구축 라우트가 서비스에 도달한다.
  const rebuild = await post('/vector-index/rebuild', {});
  assert.equal(rebuild.status, 200);
  const rebuilt = await rebuild.json() as any;
  assert.equal(rebuilt.indexed, fixtures.revisions.length);

  await app.close();
  appClosed = true;
  assert.equal(closed, 1, 'the app owns the index lifecycle');
});

test('a network failure inside a fetch-based embedder stays retryable', async t => {
  // Node fetch는 네트워크 실패를 TypeError로 던진다 — cause.code의 전이적 코드가
  // 있으면 영구 설정 오류가 아니라 재시도 가능 INDEX_UNAVAILABLE로 분류돼야 한다.
  const f = await fixture(t, {
    embedQuery: () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); },
    embedRevision: () => [1, 0, 0],
  });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }),
    (error: any) => error.code === 'INDEX_UNAVAILABLE' && error.retryable === true);
});

test('rebuildVectorIndex checks operator authorization before index configuration', async t => {
  // 색인이 없는 배포에서도 비운영자는 FORBIDDEN이다 — 구성 여부를 먼저 노출하지 않는다.
  const f = await fixture(t);
  await assert.rejects(f.service.rebuildVectorIndex(actor, {}),
    (error: any) => error.code === 'FORBIDDEN' && error.status === 403);
});

test('concurrent rebuildVectorIndex calls join a single execution', async t => {
  let replaced = 0;
  const index = new LocalVectorIndex();
  const tracked = { candidates: (query: any) => index.candidates(query),
    replaceAll: async (entries: any) => { replaced++; await new Promise(resolve => setImmediate(resolve)); return index.replaceAll(entries); } };
  const f = await fixture(t, { vectorIndex: tracked, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  const [first, second] = await Promise.all([
    f.service.rebuildVectorIndex(BOOTSTRAP_ACTOR, {}),
    f.service.rebuildVectorIndex(BOOTSTRAP_ACTOR, {}),
  ]);
  assert.equal(replaced, 1, 'concurrent rebuilds join one scan-and-replace execution');
  assert.equal(first.indexed, second.indexed);
});

test('rebuildVectorIndex rejects unexpected input fields', async t => {
  const index = new LocalVectorIndex();
  const f = await fixture(t, { vectorIndex: index, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  await assert.rejects(f.service.rebuildVectorIndex(BOOTSTRAP_ACTOR, { force: true }),
    (error: any) => error.code === 'INVALID_INPUT');
});

test('PgVectorIndex replaceAll rolls back and closes the dedicated client on failure', async () => {
  const calls: string[] = [];
  let ended = 0;
  const client = {
    on: () => {}, connect: async () => {}, end: async () => { ended++; },
    query: async (text: string) => {
      calls.push(text);
      // 배치 INSERT를 실패시켜 롤백 경로를 검증한다.
      if (/INSERT/.test(text)) throw new Error('disk full');
      return { rows: [] };
    },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  await assert.rejects(index.replaceAll([entry(0), entry(1)]), /disk full/);
  assert.ok(calls.includes('ROLLBACK'), 'a failed batch is rolled back atomically');
  assert.equal(ended, 1, 'the dedicated rebuild connection is closed even on failure');
});

test('PgVectorIndex serializes shared-client transactions so statements never interleave', async () => {
  const calls: string[] = [];
  const client = {
    on: () => {}, connect: async () => {}, end: async () => {},
    query: async (text: string) => { calls.push(text); await new Promise(resolve => setImmediate(resolve)); return { rows: [] }; },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  // 한도가 다른 두 검색을 동시에 돌린다 — 직렬화 없으면 BEGIN/set/SELECT가 섞인다.
  await Promise.all([
    index.candidates({ embedding: [1, 0, 0], limit: 200 }),
    index.candidates({ embedding: [1, 0, 0], limit: 1 }),
  ]);
  const first = calls.indexOf('COMMIT');
  assert.equal(calls.filter(text => text === 'BEGIN').length, 2);
  // 첫 트랜잭션의 COMMIT이 두 번째 BEGIN보다 앞선다 — 문장이 섞이지 않는다.
  assert.ok(first < calls.indexOf('BEGIN', 1), 'the second transaction starts only after the first commits');
  await index.close();
});

test('PgVectorIndex ends the client when the connection attempt fails', async () => {
  let ended = 0;
  const client = {
    on: () => {}, query: async () => ({ rows: [] }),
    connect: async () => { throw new Error('connection refused'); },
    end: async () => { ended++; },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  await assert.rejects(index.candidates({ embedding: [1], limit: 1 }), /connection refused/);
  assert.equal(ended, 1, 'a half-open client is released, not leaked');
});

test('PgVectorIndex replaceAll closes the dedicated client even when connect fails', async () => {
  let ended = 0;
  const client = {
    on: () => {}, query: async () => ({ rows: [] }),
    connect: async () => { throw new Error('connection refused'); },
    end: async () => { ended++; },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  await assert.rejects(index.replaceAll([entry(0)]), /connection refused/);
  assert.equal(ended, 1, 'a failed dedicated connection is still closed');
});

test('embeddings reject sparse and non-array shapes and extreme finite values stay finite', async t => {
  const { isFiniteEmbedding } = await import('../../packages/storage/vector-index.ts');
  // 희소 배열의 구멍은 걸러진다 — every()가 구멍을 건너뛰던 경로의 회귀다.
  assert.equal(isFiniteEmbedding(new Array(3)), false);
  assert.equal(isFiniteEmbedding(null), false);
  assert.equal(isFiniteEmbedding({ length: 3 }), false);
  // 극단 유한 값도 오버플로·언더플로 없이 유한 점수를 돌려야 한다.
  assert.equal(cosineSimilarity([1e308], [1e308]), 1);
  assert.equal(cosineSimilarity([1e-308], [1e-308]), 1);
  // null을 돌리는 임베더는 원시 TypeError가 아니라 INDEX_MISCONFIGURED로 분류된다.
  const f = await fixture(t, { embedQuery: () => null, embedRevision: () => [1, 0, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }),
    (error: any) => error.code === 'INDEX_MISCONFIGURED' && error.retryable === false);
});

test('an invalid revision embedding is a non-retryable configuration error', async t => {
  // 개정본 임베더의 비유한 결과는 영구 설정 오류다 — 재시도 불가로 분류돼야 한다.
  const f = await fixture(t, { embedQuery: () => [1, 0, 0], embedRevision: () => [Number.NaN, 0, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: 'q' }),
    (error: any) => error.code === 'INDEX_MISCONFIGURED' && error.retryable === false);
});

test('the embedding cache serves repeat scans without re-invoking the embedder', async t => {
  let calls = 0;
  const f = await fixture(t, { embedQuery: () => [1, 0, 0],
    embedRevision: async (title: string, body: string) => { calls++; return [1, 0, 0]; } });
  await f.service.vectorSearch(actor, { query: '주문' });
  const first = calls;
  assert.ok(first > 0, 'the first derived scan embeds every verified revision');
  await f.service.vectorSearch(actor, { query: '주문' });
  assert.equal(calls, first, 'immutable revision digests are served from the cache');
});

test('a whitespace-only query is rejected before any index work', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.vectorSearch(actor, { query: '   ' }),
    (error: any) => error.code === 'INVALID_INPUT');
});

test('PgVectorIndex discards a dead client and reconnects on the next call', async () => {
  const clients: { ended: number; onError?: () => void }[] = [];
  const pg = { Client: function () {
    const client = { ended: 0, onError: undefined as (() => void) | undefined,
      on: (_: string, handler: () => void) => { client.onError = handler; },
      connect: async () => {}, end: async () => { client.ended++; },
      query: async () => ({ rows: [] }) };
    clients.push(client);
    return client;
  } };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1, pg });
  await index.candidates({ embedding: [1], limit: 1 });
  assert.equal(clients.length, 1);
  // 유휴 연결 손실 — 자신의 연결만 비우고 다음 호출이 재연결해야 한다.
  clients[0]!.onError!();
  assert.equal(clients[0]!.ended, 1, 'the dead client is released');
  await index.candidates({ embedding: [1], limit: 1 });
  assert.equal(clients.length, 2, 'the next call opens a fresh client');
  await index.close();
});

test('PgVectorIndex replaceAll merges duplicate digests like the local index', async () => {
  const calls: { text: string; values: unknown[] }[] = [];
  const client = {
    on: () => {}, connect: async () => {}, end: async () => {},
    query: async (text: string, values: unknown[]) => { calls.push({ text, values }); return { rows: [] }; },
  };
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pg: { Client: function () { return client; } } });
  // 같은 다이제스트 두 번 — Local은 Map 병합으로 마지막이 이기고,
  // pg도 다중행 INSERT 안의 중복을 먼저 병합해 23505로 실패하지 않아야 한다.
  await index.replaceAll([entry(0, [1, 0, 0]), entry(0, [0, 1, 0])]);
  const insert = calls.find(call => /INSERT/.test(call.text))!;
  assert.equal(insert.values.filter(value => value === entry(0).revision_digest).length, 1,
    'one row survives per digest — last write wins');
  await index.close();
});

test('scope filters apply to required refs too — out-of-scope documents stay hidden', async t => {
  // document_ids가 요구하는 문서가 범위 밖이면 필수 참조도 드러나지 않는다 —
  // 색인이나 필수 해상이 범위 경계를 우회할 수 없다는 정보 노출 계약의 회귀다.
  const f = await fixture(t);
  const result = await f.service.vectorSearch(actor,
    { query: '주문', document_ids: [sales.payload.document_id], scope_id: 'scope-nonexistent' });
  assert.equal(result.total, 0, 'a required ref outside the requested scope must not leak');
});

test('a dimension mismatch between embedders is a non-retryable configuration error', async t => {
  // 질의·개정본 임베더의 차원이 다르면 영구 설정 오류다 — 조용한 0점이 아니다.
  const f = await fixture(t, { embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0] });
  await assert.rejects(f.service.vectorSearch(actor, { query: '주문' }),
    (error: any) => error.code === 'INDEX_MISCONFIGURED' && error.retryable === false);
});

test('a replaceAll failure during rebuild is classified through indexError', async t => {
  const failing = { candidates: () => [],
    replaceAll: async () => { throw new Error('index write failed'); } };
  const f = await fixture(t, { vectorIndex: failing, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0] });
  await assert.rejects(f.service.rebuildVectorIndex(BOOTSTRAP_ACTOR, {}),
    (error: any) => error.code === 'INDEX_UNAVAILABLE' && error.retryable === true);
});

test('PgVectorIndex retries after the pg loader itself fails', async () => {
  let loads = 0;
  const index = new PgVectorIndex({ connection: {}, table: 'kcl_vector_v1', indexVersion: 1,
    pgLoader: () => { loads++; return Promise.reject(Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' })); } });
  await assert.rejects(index.candidates({ embedding: [1], limit: 1 }), /optional "pg" package/);
  // 거부된 연결 Promise는 고착되지 않는다 — 다음 호출이 로더를 다시 시도해야 한다.
  await assert.rejects(index.candidates({ embedding: [1], limit: 1 }), /optional "pg" package/);
  assert.equal(loads, 2, 'a rejected opening promise is cleared so calls retry');
});
