import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  digestPayload,
  keyFor,
  type AgreementProposalRecord,
  type AgreementRecord,
  type DocumentRevision,
  type Slot,
} from '../../packages/domain/index.ts';
import { VerifiedBrowseIndex } from '../../packages/storage/browse-index.ts';
import { LocalLedger, type Checkpoint } from '../../packages/storage/local-ledger.ts';
import { BOOTSTRAP_ACTOR, PERSONAS, actorIdentity, demoFixtures } from '../../examples/order-workflow/config.ts';

const CHANNEL = 'channel-browse';
const actor = { org_id: 'OrgBrowse', actor_id: 'person-browse', kind: 'human' as const };

function checkpoint(block: number, transaction = 0): Checkpoint {
  return {
    channel_id: CHANNEL,
    block_number: block,
    transaction_index: transaction,
    transaction_id: `tx-${block}-${transaction}`,
    block_hash: `${block}-${transaction}`.padEnd(64, '0'),
  };
}

function slot(documentId: string, contextId = 'context-browse', scopeId = 'scope-browse'): Slot {
  return { channel_id: CHANNEL, document_id: documentId, context_id: contextId, scope_id: scopeId, usage_scope: 'domain-definition/v1' };
}

function revision(id: string, value: Slot): DocumentRevision {
  const payload = {
    contract_type: 'DocumentRevision' as const,
    contract_version: 1 as const,
    revision_id: id,
    ...value,
    visibility: 'shared_channel' as const,
    title: id,
    body_markdown: `# ${id}`,
    parents: [],
    dependencies: [],
    metadata: {
      author_id: actor.actor_id,
      created_at: '2026-09-16T00:00:00.000Z',
      source_kind: 'human_authored' as const,
      shared_assertions: [],
      author_org_id: actor.org_id,
    },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function proposal(id: string, value: DocumentRevision, createdAt: string): AgreementProposalRecord {
  return {
    record_type: 'AgreementProposal', proposal_id: id, revision_digest: value.revision_digest,
    policy_id: 'policy-browse', policy_version: 1, membership_epoch: 1, role_binding_version: 1,
    config_version: 'config-browse', status: 'open', created_by: actor, created_at: createdAt, review_counter: 0,
    ...slot(value.payload.document_id, value.payload.context_id, value.payload.scope_id),
  };
}

function agreement(id: string, proposalId: string, value: DocumentRevision, activatedAt: string): AgreementRecord {
  return {
    agreement_id: id, proposal_id: proposalId, revision_digest: value.revision_digest,
    policy_id: 'policy-browse', policy_version: 1, membership_epoch: 1, role_binding_version: 1,
    approval_decision_ids: ['decision-browse'], status: 'active', activated_by: actor, activated_at: activatedAt,
    ...slot(value.payload.document_id, value.payload.context_id, value.payload.scope_id),
  };
}

function commit(index: VerifiedBrowseIndex, at: Checkpoint, writes: readonly (readonly [string, unknown])[]): void {
  index.prepare([{ checkpoint: at, writes }]).commit();
}

test('browse refs preserve ordering, full slots, pages, and exact historical visibility', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-first', slot('document-one'));
  const second = revision('revision-second', slot('document-one'));
  const otherScope = revision('revision-other-scope', slot('document-one', 'context-browse', 'scope-other'));
  const otherDocument = revision('revision-other-doc', slot('document-two'));

  commit(index, checkpoint(1, 0), [[keyFor.revision(first.revision_digest), first]]);
  commit(index, checkpoint(1, 1), [[keyFor.revision(otherDocument.revision_digest), otherDocument]]);
  commit(index, checkpoint(2), [[keyFor.revision(second.revision_digest), second]]);
  commit(index, checkpoint(3), [[keyFor.revision(otherScope.revision_digest), otherScope]]);

  const all = index.query({ kind: 'revisions', mode: 'all', at: checkpoint(3), offset: 0, limit: 10 });
  assert.deepEqual(all.items.map(item => item.revision_digest), [otherScope.revision_digest, second.revision_digest, otherDocument.revision_digest, first.revision_digest]);
  assert.equal(all.total, 4);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1, 0), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'latest-per-slot', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest, second.revision_digest, otherDocument.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'slot', slot: slot('document-one'), at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'document', document_id: 'document-one', scope_id: 'scope-other', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', scope_id: 'scope-other', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', context_id: 'context-missing', at: checkpoint(3), offset: 0, limit: 10 }).items, []);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'latest-per-slot', document_id: 'document-one', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest]);

  const proposalA = proposal('proposal-a', second, '2026-09-16T02:00:00.000Z');
  const proposalB = proposal('proposal-b', second, '2026-09-16T02:00:00.000Z');
  const proposalOld = proposal('proposal-old', first, '2026-09-16T01:00:00.000Z');
  commit(index, checkpoint(4), [[keyFor.proposal(proposalB.proposal_id), proposalB], [keyFor.proposal(proposalA.proposal_id), proposalA], [keyFor.proposal(proposalOld.proposal_id), proposalOld]]);
  assert.deepEqual(index.query({ kind: 'proposals', at: checkpoint(4), offset: 0, limit: 2 }).items.map(item => item.proposal_id), ['proposal-a', 'proposal-b']);
  assert.deepEqual(index.query({ kind: 'proposals', revision_digest: first.revision_digest, at: checkpoint(4), offset: 0, limit: 10 }).items.map(item => item.proposal_id), ['proposal-old']);

  const agreementA = agreement('agreement-a', proposalA.proposal_id, second, '2026-09-16T03:00:00.000Z');
  const agreementB = agreement('agreement-b', proposalB.proposal_id, second, '2026-09-16T03:00:00.000Z');
  commit(index, checkpoint(5), [[keyFor.agreement(agreementA.agreement_id), agreementA]]);
  commit(index, checkpoint(6), [[keyFor.agreement(agreementB.agreement_id), agreementB]]);
  assert.deepEqual(index.query({ kind: 'revision-annotations', at: checkpoint(4), revision_digests: [second.revision_digest] }), [{ revision_digest: second.revision_digest, revision: all.items[1], has_proposal: true }]);
  const annotation = index.query({ kind: 'revision-annotations', at: checkpoint(6), revision_digests: [second.revision_digest] })[0];
  assert.equal(annotation.agreement?.agreement_id, 'agreement-b');

  const agreementUpper = agreement('agreement-Zed', proposalA.proposal_id, first, '2026-09-16T04:00:00.000Z');
  const agreementLower = agreement('agreement-aardvark', proposalA.proposal_id, first, '2026-09-16T04:00:00.000Z');
  commit(index, checkpoint(7, 0), [[keyFor.agreement(agreementUpper.agreement_id), agreementUpper]]);
  commit(index, checkpoint(7, 1), [[keyFor.agreement(agreementLower.agreement_id), agreementLower]]);
  assert.equal(index.query({ kind: 'revision-annotations', at: checkpoint(7, 1), revision_digests: [first.revision_digest] })[0].agreement?.agreement_id, 'agreement-aardvark');
  const blockOnly = { ...checkpoint(8), transaction_index: -1, transaction_id: '' };
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: blockOnly, offset: 0, limit: 10 }).total, 4);
  assert.doesNotThrow(() => index.prepare([{ checkpoint: blockOnly, writes: [] }]));
  assert.throws(() => index.prepare([{ checkpoint: blockOnly, writes: [[keyFor.revision(first.revision_digest), first]] }]), /block-only|checkpoint/i);

  const cached = index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 1 });
  assert.equal(cached.total, 2); cached.items[0].slot.document_id = 'caller-mutation';
  const later = revision('revision-later', slot('document-one'));
  commit(index, checkpoint(9), [[keyFor.revision(later.revision_digest), later]]);
  assert.equal(index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 1 }).items[0].slot.document_id, 'document-one');
  const nextCachedPage = index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 1, limit: 1 });
  assert.equal(nextCachedPage.total, 2); assert.notEqual(nextCachedPage.items[0].slot.document_id, 'caller-mutation');
  assert.equal(index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(9), offset: 0, limit: 10 }).items[0].revision_digest, later.revision_digest);
});

test('oversized revision selections stay correct across offset pages and later commits', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const total = 20_000;
  const writes: [string, unknown][] = [];
  for (let index_ = 0; index_ < total; index_++) {
    const value = revision(`revision-oversized-${index_}`, slot(`doc-oversized-${index_}`));
    writes.push([keyFor.revision(value.revision_digest), value]);
  }
  commit(index, checkpoint(1), writes);
  const at = checkpoint(1);
  // 캐시 상한(16,384 refs)을 넘는 결과 집합도 모든 오프셋 페이지가 정확해야 한다.
  const seen = new Set<string>();
  for (let offset = 0; offset < total; offset += 1000) {
    const result = index.query({ kind: 'revisions', mode: 'all', at, offset, limit: 1000 });
    assert.equal(result.total, total);
    for (const item of result.items) seen.add(item.revision_digest);
  }
  assert.equal(seen.size, total);
  // 첫 페이지만 캐시 미스이고 이후 오프셋 페이지는 캐시된 선택 집합을 재사용한다.
  assert.equal(index.revisionCacheStats.misses, 1);
  assert.equal(index.revisionCacheStats.hits, 19);
  // 대형 캐시 항목이 이후 커밋·다른 체크포인트의 결과를 오염시키지 않는다.
  const later = revision('revision-after-oversized', slot('doc-after'));
  commit(index, checkpoint(2), [[keyFor.revision(later.revision_digest), later]]);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 1 }).items[0].revision_digest, later.revision_digest);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at, offset: 0, limit: 1 }).total, total);
});

test('normal revision queries cannot evict the resident oversized selection', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const total = 20_000;
  const writes: [string, unknown][] = [];
  for (let index_ = 0; index_ < total; index_++) {
    const value = revision(`revision-mixed-${index_}`, slot(`doc-mixed-${index_}`));
    writes.push([keyFor.revision(value.revision_digest), value]);
  }
  commit(index, checkpoint(1), writes);
  const at = checkpoint(1);
  index.query({ kind: 'revisions', mode: 'all', at, offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.oversized, true, 'large selection is retained as the oversized entry');
  // 일반(작은) 선택 집합의 질의가 들어와도 대형 항목은 남는다 — 축출되면 다음
  // 오프셋 페이지가 전체 refs를 다시 필터링해 O(문서²)로 되돌아간다.
  for (let index_ = 0; index_ < 12; index_++) {
    index.query({ kind: 'revisions', mode: 'document', document_id: `doc-mixed-${index_}`, at, offset: 0, limit: 10 });
  }
  const mixed = index.revisionCacheStats;
  assert.equal(mixed.oversized, true, 'normal queries must not evict the oversized entry');
  assert.ok(mixed.entries > 1, 'normal selections are cached alongside the oversized entry');
  assert.ok(mixed.refs > total, 'oversized refs stay counted next to normal entries');
  const tail = index.query({ kind: 'revisions', mode: 'all', at, offset: total - 1, limit: 1 });
  assert.equal(tail.total, total);
  assert.equal(tail.items.length, 1);
  // 더 새로운 체크포인트의 대형 결과만이 상주 대형 항목을 교체하고 일반 항목은 남는다.
  const later = revision('revision-mixed-later', slot('doc-mixed-later'));
  commit(index, checkpoint(2), [[keyFor.revision(later.revision_digest), later]]);
  index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.oversized, true);
  assert.ok(index.revisionCacheStats.entries > 1, 'a newer oversized result replaces the resident one without wiping normal entries');
  // 비순차 커밋은 상주 대형 항목도 무효화한다 — 그 항목의 at가 새 쓰기를 볼 수 있으므로.
  const outOfOrder = revision('revision-mixed-ooo', slot('doc-mixed-ooo'));
  commit(index, checkpoint(0), [[keyFor.revision(outOfOrder.revision_digest), outOfOrder]]);
  assert.equal(index.revisionCacheStats.oversized, false, 'out-of-order commits invalidate the resident oversized entry');
  assert.equal(index.revisionCacheStats.entries, 0);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 1 }).total, total + 2);
});

test('overlapping prepared commits cannot duplicate or rewrite immutable entries', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-overlap', slot('doc-overlap'));
  const key = keyFor.revision(value.revision_digest);
  // 같은 키를 담은 두 prepare가 둘 다 커밋 전 검증을 통과해도, 커밋 시점 재대조가
  // 두 번째 삽입을 걸러 목록에 중복이 생기지 않아야 한다.
  const first = index.prepare([{ checkpoint: checkpoint(1), writes: [[key, value]] }]);
  const second = index.prepare([{ checkpoint: checkpoint(2), writes: [[key, value]] }]);
  first.commit(); second.commit();
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
  // 커밋된 핸들의 재커밋은 무해하다.
  first.commit();
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
});

test('an overlapping commit with conflicting immutable fields is rejected without partial state', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-conflict', slot('doc-conflict'));
  const honestProposal = proposal('proposal-conflict', value, '2026-09-16T01:00:00.000Z');
  const key = keyFor.proposal(honestProposal.proposal_id);
  // revision 키는 digest로 잠기지만 proposal/agreement 키는 식별자 기반이라 같은 키에
  // 불변 필드가 다른 쓰기가 올 수 있다 — 키가 아직 비어 있으면 prepare를 통과하므로
  // 정상 커밋이 먼저 반영된 뒤 커밋 시점 재대조에서 거부되어야 한다.
  const tampered = { ...honestProposal, created_at: '2027-01-01T00:00:00.000Z' };
  const conflicted = index.prepare([{ checkpoint: checkpoint(2), writes: [[key, tampered]] }]);
  const honest = index.prepare([{ checkpoint: checkpoint(1), writes: [[key, honestProposal]] }]);
  honest.commit();
  assert.throws(() => conflicted.commit(), /immutable/i);
  const after = index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 });
  assert.equal(after.total, 1);
  assert.equal(after.items[0].created_at, '2026-09-16T01:00:00.000Z');
});

test('an older checkpoint committed after a newer one keeps newest-first order', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-older', slot('doc-ordered'));
  const second = revision('revision-newer', slot('doc-ordered'));
  const newer = index.prepare([{ checkpoint: checkpoint(2), writes: [[keyFor.revision(second.revision_digest), second]] }]);
  const older = index.prepare([{ checkpoint: checkpoint(1), writes: [[keyFor.revision(first.revision_digest), first]] }]);
  newer.commit(); older.commit();
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
});

test('an out-of-order duplicate commit lowers the published checkpoint so history stays visible', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-demoted', slot('doc-demoted'));
  const key = keyFor.revision(value.revision_digest);
  // 같은 키가 checkpoint 2로 먼저 커밋되고 checkpoint 1의 같은 쓰기가 뒤에 도착하면,
  // 발행 체크포인트는 더 이른 1로 낮아져야 at=(1)의 역사 질의가 항목을 숨기지 않는다.
  const newer = index.prepare([{ checkpoint: checkpoint(2), writes: [[key, value]] }]);
  const older = index.prepare([{ checkpoint: checkpoint(1), writes: [[key, value]] }]);
  newer.commit(); older.commit();
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).total, 1);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).items[0].revision_digest, value.revision_digest);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
  // 더 늦은 체크포인트의 중복 쓰기는 이미 반영된 더 이른 체크포인트를 바꾸지 않는다.
  const late = index.prepare([{ checkpoint: checkpoint(3), writes: [[key, value]] }]);
  late.commit();
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).items[0].published_checkpoint.block_number, 1);
  // proposal도 같은 규칙이 적용된다.
  const prop = proposal('proposal-demoted', value, '2026-09-16T01:00:00.000Z');
  const propKey = keyFor.proposal(prop.proposal_id);
  const propNewer = index.prepare([{ checkpoint: checkpoint(5), writes: [[propKey, prop]] }]);
  const propOlder = index.prepare([{ checkpoint: checkpoint(4), writes: [[propKey, prop]] }]);
  propNewer.commit(); propOlder.commit();
  assert.equal(index.query({ kind: 'proposals', at: checkpoint(4), offset: 0, limit: 10 }).total, 1);
});

test('a sequential commit of an earlier duplicate still lowers the published checkpoint', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-seq-demoted', slot('doc-seq-demoted'));
  const key = keyFor.revision(value.revision_digest);
  // 겹친 prepare가 아니라 cp2 커밋이 완전히 끝난 뒤 cp1의 같은 쓰기가 커밋돼도
  // 발행 체크포인트는 1로 낮아져야 at=(1)의 역사 질의가 항목을 본다.
  commit(index, checkpoint(2), [[key, value]]);
  commit(index, checkpoint(1), [[key, value]]);
  const atOne = index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(atOne.total, 1);
  assert.equal(atOne.items[0].published_checkpoint.block_number, 1);
  // 더 늦은 중복은 발행 체크포인트를 바꾸지 않는다.
  commit(index, checkpoint(3), [[key, value]]);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 })
    .items[0].published_checkpoint.block_number, 1);
  // proposal·agreement도 순차 커밋에서 같은 규칙이 적용된다.
  const prop = proposal('proposal-seq-demoted', value, '2026-09-16T01:00:00.000Z');
  const propKey = keyFor.proposal(prop.proposal_id);
  commit(index, checkpoint(6), [[propKey, prop]]);
  commit(index, checkpoint(5), [[propKey, prop]]);
  assert.equal(index.query({ kind: 'proposals', at: checkpoint(5), offset: 0, limit: 10 }).total, 1);
  const agr = agreement('agreement-seq-demoted', prop.proposal_id, value, '2026-09-16T02:00:00.000Z');
  const agrKey = keyFor.agreement(agr.agreement_id);
  commit(index, checkpoint(8), [[agrKey, agr]]);
  commit(index, checkpoint(7), [[agrKey, agr]]);
  const annotations = index.query({ kind: 'revision-annotations', at: checkpoint(7), revision_digests: [value.revision_digest] });
  assert.equal(annotations[0].agreement?.agreement_id, 'agreement-seq-demoted');
});

test('duplicate keys within one prepare keep the earliest published checkpoint', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-same-prepare', slot('doc-same-prepare'));
  const key = keyFor.revision(value.revision_digest);
  // 커밋 단계 강등과 같은 규칙이 prepare 안의 배치 순서에도 적용돼야 한다 —
  // 같은 키가 checkpoint 2 다음 checkpoint 1로 쓰이면 발행 체크포인트는 1이다.
  index.prepare([
    { checkpoint: checkpoint(2), writes: [[key, value]] },
    { checkpoint: checkpoint(1), writes: [[key, value]] },
  ]).commit();
  const atOne = index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(atOne.total, 1);
  assert.equal(atOne.items[0].published_checkpoint.block_number, 1);
  // 반대 순서(1 다음 2)로 쓰여도 결과는 같다 — 순서에 의존하지 않는다.
  const other = revision('revision-same-prepare-2', slot('doc-same-prepare-2'));
  const otherKey = keyFor.revision(other.revision_digest);
  index.prepare([
    { checkpoint: checkpoint(3), writes: [[otherKey, other]] },
    { checkpoint: checkpoint(4), writes: [[otherKey, other]] },
  ]).commit();
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(3), offset: 0, limit: 10 })
    .items.find(item => item.revision_digest === other.revision_digest)?.published_checkpoint.block_number, 3);
});

test('a byte-only oversized selection is not cached and keeps the working set', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-byte-key', slot('doc-byte-key'));
  commit(index, checkpoint(1), [[keyFor.revision(value.revision_digest), value]]);
  // 평범한 선택 집합을 먼저 캐시한다.
  index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.entries, 1);
  // 결과는 작지만 캐시 키가 바이트 예산을 넘는 질의는 캐시되지 않고
  // 기존 작업 세트를 비우지도 않는다.
  const giantDocument = 'doc-'.padEnd(700 * 1024, 'x');
  const result = index.query({ kind: 'revisions', mode: 'document', document_id: giantDocument, at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(result.total, 0);
  assert.equal(index.revisionCacheStats.entries, 1, 'byte-overflow selections are not cached');
  assert.equal(index.revisionCacheStats.oversized, false);
});

test('selections beyond the oversized byte cap are not cached at all', () => {
  // 건수 상한은 넘지만 추정 바이트가 대형 상한도 넘는 선택 집합은 상주 대상이 아니다.
  const index = new VerifiedBrowseIndex(CHANNEL, { maxRefs: 4, maxBytes: 1_024, maxOversizedBytes: 8_192 });
  const total = 64;
  const writes: [string, unknown][] = [];
  for (let index_ = 0; index_ < total; index_++) {
    const value = revision(`revision-cap-${index_}`, slot(`doc-cap-${index_}`));
    writes.push([keyFor.revision(value.revision_digest), value]);
  }
  commit(index, checkpoint(1), writes);
  index.query({ kind: 'revisions', mode: 'document', document_id: 'doc-cap-0', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.entries, 1);
  // 64 refs × 16B + 키가 대형 상한(8,192B)을 넘지 않으면 상주한다.
  index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.oversized, true);
  // 대형 바이트 상한을 넘는 선택 집합은 캐시되지 않고 작업 세트도 유지된다.
  const tiny = new VerifiedBrowseIndex(CHANNEL, { maxRefs: 4, maxBytes: 1_024, maxOversizedBytes: 32 });
  commit(tiny, checkpoint(1), writes.slice(0, 8));
  tiny.query({ kind: 'revisions', mode: 'document', document_id: 'doc-cap-0', at: checkpoint(1), offset: 0, limit: 10 });
  tiny.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(tiny.revisionCacheStats.oversized, false, 'oversized selections past the byte cap are not cached');
  assert.equal(tiny.revisionCacheStats.entries, 1, 'the normal working set survives');
});

test('non-string selectors are rejected before cache lookup so they cannot alias omitted filters', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-selector', slot('doc-selector'));
  commit(index, checkpoint(1), [[keyFor.revision(value.revision_digest), value]]);
  // scope_id:null은 생략과 같은 캐시 키로 별칭됐다 — 허용하면 빈 결과가
  // 필터 없는 질의의 캐시 항목으로 저장돼 이후 정상 질의를 오염시킨다.
  assert.throws(() => index.query({ kind: 'revisions', mode: 'all', scope_id: null as unknown as string, at: checkpoint(1), offset: 0, limit: 10 }), /selector/i);
  const stats = index.revisionCacheStats;
  assert.equal(stats.entries, 0, 'rejected queries are not cached');
  assert.equal(stats.misses, 0, 'rejected queries do not count as misses');
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).total, 1);
});

test('no-op commits keep cached selections valid', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-noop', slot('doc-noop'));
  const key = keyFor.revision(value.revision_digest);
  commit(index, checkpoint(1), [[key, value]]);
  index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 });
  assert.equal(index.revisionCacheStats.entries, 1);
  // block-only 배치는 쓰기가 없어 상태가 변하지 않는다 — 캐시를 유지한다.
  const blockOnly = { ...checkpoint(2), transaction_index: -1, transaction_id: '' };
  index.prepare([{ checkpoint: blockOnly, writes: [] }]).commit();
  assert.equal(index.revisionCacheStats.entries, 1, 'block-only commits do not invalidate the cache');
  // 전부 중복이라 실제로 아무것도 반영하지 않는 커밋도 캐시를 유지한다.
  index.prepare([{ checkpoint: checkpoint(1), writes: [[key, value]] }]).commit();
  assert.equal(index.revisionCacheStats.entries, 1, 'fully deduplicated commits do not invalidate the cache');
});

test('a commit invalidates cached selections whose checkpoint can see the new writes', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-cached', slot('doc-cached'));
  commit(index, checkpoint(2), [[keyFor.revision(first.revision_digest), first]]);
  // at=(2)의 선택 집합을 캐시한다.
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
  const before = index.revisionCacheStats;
  assert.equal(before.entries, 1);
  // 순서대로 들어오는 커밋(3 > at 2)은 캐시를 건드리지 않는다 — 페이지 재사용이 유지된다.
  const third = revision('revision-cached-later', slot('doc-cached-later'));
  commit(index, checkpoint(3), [[keyFor.revision(third.revision_digest), third]]);
  assert.equal(index.revisionCacheStats.entries, 1, 'in-order commits keep cached pages');
  // 비순차 커밋(1 < at 2)은 at=(2)의 선택 집합을 오래된 것으로 만든다 — 무효화돼야 한다.
  const delayed = revision('revision-cached-delayed', slot('doc-cached-delayed'));
  commit(index, checkpoint(1), [[keyFor.revision(delayed.revision_digest), delayed]]);
  assert.equal(index.revisionCacheStats.entries, 0, 'out-of-order commits invalidate stale selections');
  assert.equal(index.revisionCacheStats.refs, 0);
  assert.equal(index.revisionCacheStats.bytes, 0);
  assert.equal(index.revisionCacheStats.oversized, false);
  const fresh = index.query({ kind: 'revisions', mode: 'all', at: checkpoint(3), offset: 0, limit: 10 });
  assert.equal(fresh.total, 3);
  assert.deepEqual(fresh.items.map(item => item.revision_digest), [third.revision_digest, first.revision_digest, delayed.revision_digest]);
});

test('later mutable writes cannot change indexed identity, order, or full-slot fields', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-mutable', slot('document-mutable'));
  const original = proposal('proposal-mutable', value, '2026-09-16T00:00:00.000Z');
  commit(index, checkpoint(1), [[keyFor.revision(value.revision_digest), value], [keyFor.proposal(original.proposal_id), original], [keyFor.proposal(original.proposal_id), original]]);

  const mutable = { ...original, status: 'activated' as const, review_counter: 3, agreement_id: 'agreement-mutable' };
  commit(index, checkpoint(2), [[keyFor.proposal(original.proposal_id), mutable]]);
  assert.equal(index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(3), writes: [[keyFor.proposal(original.proposal_id), { ...mutable, created_at: '2027-01-01T00:00:00.000Z' }]] }]), /immutable|indexed/i);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(3), writes: [[keyFor.proposal(original.proposal_id), { ...mutable, scope_id: 'scope-forged' }]] }]), /immutable|indexed/i);

  const originalAgreement = agreement('agreement-mutable', original.proposal_id, value, '2026-09-16T01:00:00.000Z');
  commit(index, checkpoint(3), [[keyFor.agreement(originalAgreement.agreement_id), originalAgreement]]);
  commit(index, checkpoint(4), [[keyFor.agreement(originalAgreement.agreement_id), {
    ...originalAgreement, status: 'withdrawn', status_reason: 'policy changed', status_changed_by: actor,
    status_changed_at: '2026-09-16T02:00:00.000Z',
  }]]);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(5), writes: [[keyFor.agreement(originalAgreement.agreement_id), {
    ...originalAgreement, activated_at: '2027-01-01T00:00:00.000Z',
  }]] }]), /immutable|indexed/i);

  const firstRead = index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 });
  firstRead.items[0].slot.document_id = 'document-forged';
  firstRead.items[0].published_checkpoint.block_number = 999;
  const secondRead = index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 });
  assert.equal(secondRead.items[0].slot.document_id, 'document-mutable');
  assert.equal(secondRead.items[0].published_checkpoint.block_number, 1);
  assert.throws(() => index.query({ kind: 'proposals', at: checkpoint(4), offset: -1, limit: 10 }), /offset|range/i);
  assert.throws(() => index.query({ kind: 'revision-annotations', at: checkpoint(4), revision_digests: Array(1001).fill(value.revision_digest) }), /1000|batch/i);
});

test('streamed index preparation is atomic and sorts a whole replay once', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-stream-first', slot('document-stream'));
  const second = revision('revision-stream-second', slot('document-stream'));
  function* failingReplay() {
    yield { checkpoint: checkpoint(1), writes: [[keyFor.revision(first.revision_digest), first]] as const };
    throw new Error('synthetic replay failure');
  }
  assert.throws(() => index.prepare(failingReplay()), /replay failure/);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(0), offset: 0, limit: 10 }).total, 0);
  function* replay() {
    yield { checkpoint: checkpoint(1), writes: [[keyFor.revision(first.revision_digest), first]] as const };
    yield { checkpoint: checkpoint(2), writes: [[keyFor.revision(second.revision_digest), second]] as const };
  }
  index.prepare(replay()).commit();
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).total, 1);
});

test('LocalLedger publishes browse changes only after SQL commit and rebuilds them from the journal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-browse-index-'));
  const path = join(directory, 'ledger.sqlite');
  let ledger = new LocalLedger(path, CHANNEL);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = revision('revision-local-first', slot('document-local'));
  const firstCommit = await ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(first.revision_digest), first); });
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: firstCommit.checkpoint, offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);

  const external = new DatabaseSync(path);
  external.exec("CREATE TRIGGER fail_browse_projection BEFORE INSERT ON projection_history BEGIN SELECT RAISE(ABORT, 'browse rollback'); END");
  external.close();
  const second = revision('revision-local-second', slot('document-local'));
  await assert.rejects(ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(second.revision_digest), second); }), /browse rollback/);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: firstCommit.checkpoint, offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);

  const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER fail_browse_projection'); repair.close();
  const secondCommit = await ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(second.revision_digest), second); });
  const expected = ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 });
  ledger.close();
  ledger = new LocalLedger(path, CHANNEL);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);

  const tamper = new DatabaseSync(path);
  tamper.prepare('DELETE FROM projection WHERE state_key = ?').run(keyFor.revision(first.revision_digest));
  tamper.prepare('UPDATE projection_history SET value_json = ? WHERE state_key = ?').run(JSON.stringify(second), keyFor.revision(first.revision_digest));
  tamper.close();
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);
  ledger.close();
  ledger = new LocalLedger(path, CHANNEL);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);
});

test('LocalLedger rejects changed indexed proposal fields before committing SQL or memory', async t => {
  const ledger = new LocalLedger(':memory:', 'kcl-demo'); t.after(() => ledger.close());
  const fixture = demoFixtures(); const author = actorIdentity(PERSONAS[0]); const value = fixture.revisions[0]; const policy = fixture.policies[0];
  await ledger.bootstrap(BOOTSTRAP_ACTOR, fixture.config);
  await ledger.execute(author, { command_id: 'command-browse-publish', type: 'publish_revision', input: {
    revision: value, publication: { revision_digest: value.revision_digest, config_version: 1, membership_epoch: 1 },
  } });
  await ledger.execute(author, { command_id: 'command-browse-propose', type: 'propose', input: {
    proposal_id: 'proposal-browse-guard', revision_digest: value.revision_digest, policy_id: policy.policy_id, policy_version: 1,
  } });
  const key = keyFor.proposal('proposal-browse-guard'); const before = ledger.read(key); const at = ledger.checkpoint()!;
  await assert.rejects(ledger.transact(author, async ctx => {
    await ctx.put(key, { ...before, created_at: '2027-01-01T00:00:00.000Z' });
  }), /immutable|indexed/i);
  assert.deepEqual(ledger.checkpoint(), at);
  assert.deepEqual(ledger.read(key), before);
  assert.deepEqual(ledger.queryBrowse({ kind: 'proposals', at, offset: 0, limit: 10 }).items.map(item => item.proposal_id), ['proposal-browse-guard']);
});
