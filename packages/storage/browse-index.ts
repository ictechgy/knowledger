import {
  keyFor,
  slotKey,
  validateAgreement,
  validateProposal,
  validateRevision,
  type Slot,
} from '../domain/index.ts';
import type {
  AgreementBrowseRef,
  AnnotationBrowseQuery,
  BrowsePage,
  BrowseQuery,
  BrowseResult,
  BrowseWriteBatch,
  ProposalBrowseQuery,
  ProposalBrowseRef,
  RevisionBrowseAnnotation,
  RevisionBrowseQuery,
  RevisionBrowseRef,
} from './browse-contract.ts';
import type { Checkpoint } from './local-ledger.ts';

interface BrowseState {
  revisionsByKey: Map<string, RevisionBrowseRef>;
  revisions: RevisionBrowseRef[];
  revisionsBySlot: Map<string, RevisionBrowseRef[]>;
  revisionsByDocument: Map<string, RevisionBrowseRef[]>;
  proposalsByKey: Map<string, ProposalBrowseRef>;
  proposals: ProposalBrowseRef[];
  proposalsByRevision: Map<string, ProposalBrowseRef[]>;
  agreementsByKey: Map<string, AgreementBrowseRef>;
  agreementsByRevision: Map<string, AgreementBrowseRef[]>;
}

interface RevisionCacheEntry {
  refs: readonly RevisionBrowseRef[];
  estimatedBytes: number;
  /** 선택 집합이 바인딩된 체크포인트 — 이 이하의 커밋이 들어오면 항목이 오래된 것이다. */
  at: Checkpoint;
}

const MAX_REVISION_CACHE_ENTRIES = 8;
const MAX_REVISION_CACHE_REFS = 16_384;
const MAX_REVISION_CACHE_BYTES = 512 * 1024;
// 대형 선택 집합 풀 전체의 추정 바이트 예산. 일반 작업 세트와 별도로 제한한다.
const MAX_OVERSIZED_REVISION_CACHE_BYTES = 16 * 1024 * 1024;
const ESTIMATED_REF_POINTER_BYTES = 16;

const emptyState = (): BrowseState => ({
  revisionsByKey: new Map(), revisions: [], revisionsBySlot: new Map(), revisionsByDocument: new Map(),
  proposalsByKey: new Map(), proposals: [], proposalsByRevision: new Map(),
  agreementsByKey: new Map(), agreementsByRevision: new Map(),
});

function checkpointOrder(left: Checkpoint, right: Checkpoint): number {
  if (left.block_number !== right.block_number) return left.block_number < right.block_number ? -1 : 1;
  if (left.transaction_index !== right.transaction_index) return left.transaction_index < right.transaction_index ? -1 : 1;
  return 0;
}

function compareRevisions(left: RevisionBrowseRef, right: RevisionBrowseRef): number {
  const published = checkpointOrder(right.published_checkpoint, left.published_checkpoint);
  return published || left.revision_digest.localeCompare(right.revision_digest);
}

function compareProposals(left: ProposalBrowseRef, right: ProposalBrowseRef): number {
  return right.created_at.localeCompare(left.created_at) || left.proposal_id.localeCompare(right.proposal_id);
}

function compareAgreements(left: AgreementBrowseRef, right: AgreementBrowseRef): number {
  if (left.activated_at !== right.activated_at) return left.activated_at > right.activated_at ? -1 : 1;
  if (left.agreement_id !== right.agreement_id) return left.agreement_id > right.agreement_id ? -1 : 1;
  return 0;
}

function cloneCheckpoint(value: Checkpoint): Checkpoint {
  return { channel_id: value.channel_id, block_number: value.block_number, transaction_index: value.transaction_index,
    transaction_id: value.transaction_id, block_hash: value.block_hash };
}

function cloneSlot(value: Slot): Slot {
  return { channel_id: value.channel_id, document_id: value.document_id, context_id: value.context_id,
    scope_id: value.scope_id, usage_scope: value.usage_scope };
}

function cloneRevision(value: RevisionBrowseRef): RevisionBrowseRef {
  return { key: value.key, revision_digest: value.revision_digest, slot: cloneSlot(value.slot), published_checkpoint: cloneCheckpoint(value.published_checkpoint) };
}

function cloneProposal(value: ProposalBrowseRef): ProposalBrowseRef {
  return { key: value.key, proposal_id: value.proposal_id, revision_digest: value.revision_digest, slot: cloneSlot(value.slot),
    created_at: value.created_at, published_checkpoint: cloneCheckpoint(value.published_checkpoint) };
}

function cloneAgreement(value: AgreementBrowseRef): AgreementBrowseRef {
  return { key: value.key, agreement_id: value.agreement_id, revision_digest: value.revision_digest, slot: cloneSlot(value.slot),
    activated_at: value.activated_at, published_checkpoint: cloneCheckpoint(value.published_checkpoint) };
}

function assertCheckpoint(value: Checkpoint, channelId: string): void {
  if (!value || value.channel_id !== channelId || !Number.isSafeInteger(value.block_number) || value.block_number < 0
    || !Number.isSafeInteger(value.transaction_index) || value.transaction_index < -1
    || typeof value.transaction_id !== 'string'
    || (value.transaction_index === -1 ? value.transaction_id !== '' : value.transaction_id.length < 1)
    || typeof value.block_hash !== 'string' || value.block_hash.length < 1) throw new Error('Invalid browse checkpoint');
}

function sameSlot(left: Slot, right: Slot): boolean { return slotKey(left) === slotKey(right); }
function visible(checkpoint: Checkpoint, at: Checkpoint): boolean { return checkpointOrder(checkpoint, at) <= 0; }


/** 새 항목이 기존 선두보다 모두 최신이면 정렬 없이 앞에 붙이고, 아니면 합쳐서 다시 정렬한다. */
function prependLatest<T>(added: T[], existing: T[], compare: (left: T, right: T) => number): T[] {
  if (!added.length) return existing;
  if (!existing.length || compare(added[added.length - 1], existing[0]) < 0) return [...added, ...existing];
  const merged = [...added, ...existing]; merged.sort(compare); return merged;
}

function staticRevisionMatches(existing: RevisionBrowseRef, next: RevisionBrowseRef): boolean {
  return existing.key === next.key && existing.revision_digest === next.revision_digest && sameSlot(existing.slot, next.slot);
}

function staticProposalMatches(existing: ProposalBrowseRef, next: ProposalBrowseRef): boolean {
  return existing.key === next.key && existing.proposal_id === next.proposal_id && existing.revision_digest === next.revision_digest
    && existing.created_at === next.created_at && sameSlot(existing.slot, next.slot);
}

function staticAgreementMatches(existing: AgreementBrowseRef, next: AgreementBrowseRef): boolean {
  return existing.key === next.key && existing.agreement_id === next.agreement_id && existing.revision_digest === next.revision_digest
    && existing.activated_at === next.activated_at && sameSlot(existing.slot, next.slot);
}

function page<T, U>(values: readonly T[], offset: number, limit: number, clone: (value: T) => U): BrowsePage<U> {
  return { items: values.slice(offset, offset + limit).map(clone), total: values.length };
}

function revisionCacheKey(query: RevisionBrowseQuery): string {
  const slot = query.slot ? [query.slot.channel_id, query.slot.document_id, query.slot.context_id, query.slot.scope_id, query.slot.usage_scope] : null;
  return JSON.stringify([
    query.at.channel_id, query.at.block_number, query.at.transaction_index, query.at.transaction_id, query.at.block_hash,
    query.mode, slot, query.document_id ?? null, query.context_id ?? null, query.scope_id ?? null, query.usage_scope ?? null,
  ]);
}

/** Compact browse metadata derived only from adapter-verified committed write sets. */
export class VerifiedBrowseIndex {
  readonly channelId: string;
  private readonly maxRevisionCacheEntries: number;
  private readonly maxRevisionCacheRefs: number;
  private readonly maxRevisionCacheBytes: number;
  private readonly maxOversizedRevisionCacheBytes: number;
  private state: BrowseState = emptyState();
  private revisionCache = new Map<string, RevisionCacheEntry>();
  private revisionCacheRefs = 0;
  private revisionCacheBytes = 0;
  private readonly oversizedRevisionKeys = new Set<string>();
  private oversizedRevisionRefs = 0;
  private oversizedRevisionBytes = 0;
  private revisionCacheHits = 0;
  private revisionCacheMisses = 0;

  constructor(channelId: string, cacheLimits?: { maxEntries?: number; maxRefs?: number; maxBytes?: number; maxOversizedBytes?: number }) {
    if (typeof channelId !== 'string' || channelId.length < 1) throw new Error('Invalid browse channel');
    this.channelId = channelId;
    this.maxRevisionCacheEntries = cacheLimits?.maxEntries ?? MAX_REVISION_CACHE_ENTRIES;
    this.maxRevisionCacheRefs = cacheLimits?.maxRefs ?? MAX_REVISION_CACHE_REFS;
    this.maxRevisionCacheBytes = cacheLimits?.maxBytes ?? MAX_REVISION_CACHE_BYTES;
    this.maxOversizedRevisionCacheBytes = cacheLimits?.maxOversizedBytes ?? MAX_OVERSIZED_REVISION_CACHE_BYTES;
  }

  /** 캐시 관측치 — 진단과 회귀 테스트용. 항목 내용이나 키는 노출하지 않는다. */
  get revisionCacheStats(): { entries: number; refs: number; bytes: number; oversized: boolean; oversizedEntries: number; hits: number; misses: number } {
    return { entries: this.revisionCache.size, refs: this.revisionCacheRefs, bytes: this.revisionCacheBytes,
      oversized: this.oversizedRevisionKeys.size > 0, oversizedEntries: this.oversizedRevisionKeys.size, hits: this.revisionCacheHits, misses: this.revisionCacheMisses };
  }

  prepare(batches: Iterable<BrowseWriteBatch>): { commit(): void } {
    // 커밋 전까지 this.state를 변경하지 않고 추가분만 모은다 — 블록마다 색인
    // 전체를 복사·정렬하면 O(색인×블록)이 되므로 델타로 유지한다. 커밋은
    // 신규 항목을 기존 목록 앞에 붙이고 최신 정렬이 깨진 경우에만 다시 정렬한다.
    // 빠른 경로도 기존 배열의 포인터 복사(얕은 O(색인))는 수행하지만 객체
    // 복제와 정렬은 하지 않는다. 두 prepare가 겹쳐도 커밋 시점에 현재 상태와
    // 다시 대조해 중복을 걸러낸다.
    const addedRevisions: RevisionBrowseRef[] = [];
    const pendingRevisions = new Map<string, RevisionBrowseRef>();
    const addedProposals: ProposalBrowseRef[] = [];
    const pendingProposals = new Map<string, ProposalBrowseRef>();
    const pendingAgreements = new Map<string, AgreementBrowseRef>();
    // prepare 시점에 이미 커밋된 키의 더 이른 체크포인트 쓰기는 커밋 시점에
    // 다시 대조해 발행 체크포인트를 낮춘다 — 순차 커밋(cp2 커밋 후 cp1 prepare)도
    // 겹친 prepare와 같은 규칙으로 역사 가시성을 유지한다. 키당 가장 이른 후보만 남긴다.
    const demoteCandidatesRevisions = new Map<string, RevisionBrowseRef>();
    const demoteCandidatesProposals = new Map<string, ProposalBrowseRef>();
    const demoteCandidatesAgreements = new Map<string, AgreementBrowseRef>();
    const noteDemote = <Ref extends { key: string; published_checkpoint: Checkpoint }>(map: Map<string, Ref>, ref: Ref): void => {
      const previous = map.get(ref.key);
      if (!previous || checkpointOrder(ref.published_checkpoint, previous.published_checkpoint) < 0) map.set(ref.key, ref);
    };

    for (const batch of batches) {
      assertCheckpoint(batch.checkpoint, this.channelId);
      if (!Array.isArray(batch.writes)) throw new Error('Invalid browse write batch');
      if (batch.checkpoint.transaction_index === -1 && batch.writes.length) throw new Error('Block-only browse checkpoint cannot publish writes');
      for (const entry of batch.writes) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') throw new Error('Invalid browse write batch');
        const [key, value] = entry;
        if (key.startsWith('kcl:v1:revision:')) {
          const revision = validateRevision(value);
          if (key !== keyFor.revision(revision.revision_digest) || revision.payload.channel_id !== this.channelId) throw new Error('Invalid browse revision binding');
          const ref: RevisionBrowseRef = { key, revision_digest: revision.revision_digest, slot: cloneSlot(revision.payload), published_checkpoint: cloneCheckpoint(batch.checkpoint) };
          const pendingRevision = pendingRevisions.get(key);
          const committedRevision = this.state.revisionsByKey.get(key);
          const existing = committedRevision ?? pendingRevision;
          if (existing) {
            if (!staticRevisionMatches(existing, ref)) throw new Error('Browse index immutable revision fields changed');
            // 같은 prepare 안에서 더 이른 체크포인트의 중복 쓰기는 pending의 발행
            // 체크포인트를 낮추고, 이미 커밋된 키는 커밋 시점 강등 후보로 넘긴다.
            if (pendingRevision && checkpointOrder(ref.published_checkpoint, pendingRevision.published_checkpoint) < 0) {
              pendingRevision.published_checkpoint = cloneCheckpoint(ref.published_checkpoint);
            } else if (committedRevision && checkpointOrder(ref.published_checkpoint, committedRevision.published_checkpoint) < 0) {
              noteDemote(demoteCandidatesRevisions, ref);
            }
            continue;
          }
          addedRevisions.push(ref); pendingRevisions.set(key, ref);
        } else if (key.startsWith('kcl:v1:proposal:')) {
          const proposal = validateProposal(value);
          if (key !== keyFor.proposal(proposal.proposal_id) || proposal.channel_id !== this.channelId) throw new Error('Invalid browse proposal binding');
          const ref: ProposalBrowseRef = { key, proposal_id: proposal.proposal_id, revision_digest: proposal.revision_digest,
            slot: cloneSlot(proposal), created_at: proposal.created_at, published_checkpoint: cloneCheckpoint(batch.checkpoint) };
          const pendingProposal = pendingProposals.get(key);
          const committedProposal = this.state.proposalsByKey.get(key);
          const existing = committedProposal ?? pendingProposal;
          if (existing) {
            if (!staticProposalMatches(existing, ref)) throw new Error('Browse index immutable proposal fields changed');
            if (pendingProposal && checkpointOrder(ref.published_checkpoint, pendingProposal.published_checkpoint) < 0) {
              pendingProposal.published_checkpoint = cloneCheckpoint(ref.published_checkpoint);
            } else if (committedProposal && checkpointOrder(ref.published_checkpoint, committedProposal.published_checkpoint) < 0) {
              noteDemote(demoteCandidatesProposals, ref);
            }
            continue;
          }
          addedProposals.push(ref); pendingProposals.set(key, ref);
        } else if (key.startsWith('kcl:v1:agreement:')) {
          const agreement = validateAgreement(value);
          if (key !== keyFor.agreement(agreement.agreement_id) || agreement.channel_id !== this.channelId) throw new Error('Invalid browse agreement binding');
          const ref: AgreementBrowseRef = { key, agreement_id: agreement.agreement_id, revision_digest: agreement.revision_digest,
            slot: cloneSlot(agreement), activated_at: agreement.activated_at, published_checkpoint: cloneCheckpoint(batch.checkpoint) };
          const pendingAgreement = pendingAgreements.get(key);
          const committedAgreement = this.state.agreementsByKey.get(key);
          const existing = committedAgreement ?? pendingAgreement;
          if (existing) {
            if (!staticAgreementMatches(existing, ref)) throw new Error('Browse index immutable agreement fields changed');
            if (pendingAgreement && checkpointOrder(ref.published_checkpoint, pendingAgreement.published_checkpoint) < 0) {
              pendingAgreement.published_checkpoint = cloneCheckpoint(ref.published_checkpoint);
            } else if (committedAgreement && checkpointOrder(ref.published_checkpoint, committedAgreement.published_checkpoint) < 0) {
              noteDemote(demoteCandidatesAgreements, ref);
            }
            continue;
          }
          pendingAgreements.set(key, ref);
        }
      }
    }
    let committed = false;
    return { commit: () => {
      if (committed) return;
      const state = this.state;
      // 1) 커밋 시점의 현재 상태와 다시 대조한다 — 다른 prepare가 먼저
      //    커밋돼 같은 키가 들어간 경우 중복 추가를 건너뛰고, 불변 필드가
      //    다르면 상태를 변경하기 전에 여기서 중단한다.
      const demotedRevisions: RevisionBrowseRef[] = [];
      const freshRevisions = addedRevisions.filter(ref => {
        const existing = state.revisionsByKey.get(ref.key);
        if (!existing) return true;
        if (!staticRevisionMatches(existing, ref)) throw new Error('Browse index immutable revision fields changed');
        // 더 이른 체크포인트의 같은 쓰기가 늦게 커밋되면 발행 체크포인트를 낮춘다 —
        // 그렇지 않으면 그 시점의 역사 질의가 이미 존재한 항목을 숨긴다.
        if (checkpointOrder(ref.published_checkpoint, existing.published_checkpoint) < 0) demotedRevisions.push(ref);
        return false;
      });
      const demotedProposals: ProposalBrowseRef[] = [];
      const freshProposals = addedProposals.filter(ref => {
        const existing = state.proposalsByKey.get(ref.key);
        if (!existing) return true;
        if (!staticProposalMatches(existing, ref)) throw new Error('Browse index immutable proposal fields changed');
        if (checkpointOrder(ref.published_checkpoint, existing.published_checkpoint) < 0) demotedProposals.push(ref);
        return false;
      });
      const demotedAgreements: AgreementBrowseRef[] = [];
      const freshAgreements = [...pendingAgreements.values()].filter(ref => {
        const existing = state.agreementsByKey.get(ref.key);
        if (!existing) return true;
        if (!staticAgreementMatches(existing, ref)) throw new Error('Browse index immutable agreement fields changed');
        if (checkpointOrder(ref.published_checkpoint, existing.published_checkpoint) < 0) demotedAgreements.push(ref);
        return false;
      });
      // prepare 시점에 이미 커밋돼 있던 키의 강등 후보도 현재 상태와 다시 대조한다 —
      // 그 사이 다른 커밋이 더 이르게 낮췄으면 건너뛰고, 불변 필드 충돌은 여기서 중단한다.
      const collectDemoted = <Ref extends { key: string; published_checkpoint: Checkpoint }>(
        candidates: Iterable<Ref>, byKey: Map<string, Ref>, matches: (existing: Ref, next: Ref) => boolean, error: string, demoted: Ref[],
      ): void => {
        for (const ref of candidates) {
          const existing = byKey.get(ref.key);
          if (!existing) continue;
          if (!matches(existing, ref)) throw new Error(error);
          if (checkpointOrder(ref.published_checkpoint, existing.published_checkpoint) < 0) demoted.push(ref);
        }
      };
      collectDemoted(demoteCandidatesRevisions.values(), state.revisionsByKey, staticRevisionMatches, 'Browse index immutable revision fields changed', demotedRevisions);
      collectDemoted(demoteCandidatesProposals.values(), state.proposalsByKey, staticProposalMatches, 'Browse index immutable proposal fields changed', demotedProposals);
      collectDemoted(demoteCandidatesAgreements.values(), state.agreementsByKey, staticAgreementMatches, 'Browse index immutable agreement fields changed', demotedAgreements);
      // 2) 실제로 반영되는 revision ref의 최소 체크포인트 이하의 at에 바인딩된 캐시 선택
      //    집합만 무효화한다 — 상태를 바꾸지 않는 멱등·block-only·proposal/agreement만의
      //    커밋은 캐시를 유지하고, 순서대로 들어오는 커밋도 기존 at보다 뒤라 유지된다.
      const touched = [...freshRevisions, ...demotedRevisions];
      if (touched.length) {
        let minCommitted = touched[0].published_checkpoint;
        for (const ref of touched) {
          if (checkpointOrder(ref.published_checkpoint, minCommitted) < 0) minCommitted = ref.published_checkpoint;
        }
        for (const cachedKey of [...this.revisionCache.keys()]) {
          if (checkpointOrder(minCommitted, this.revisionCache.get(cachedKey)!.at) <= 0) this.dropRevisionCacheEntry(cachedKey);
        }
      }
      // 3) 강등은 기존 ref를 제거한 뒤 더 이른 체크포인트로 재삽입해 정렬 위치를
      //    다시 계산하고, 신규 ref는 정렬 병합으로 반영한다.
      this.mergeDelta({ fresh: freshRevisions, demoted: demotedRevisions, byKey: state.revisionsByKey, compare: compareRevisions,
        all: { get: () => state.revisions, set: next => { state.revisions = next; } },
        buckets: [
          { map: state.revisionsBySlot, keyOf: ref => slotKey(ref.slot) },
          { map: state.revisionsByDocument, keyOf: ref => ref.slot.document_id },
        ] });
      this.mergeDelta({ fresh: freshProposals, demoted: demotedProposals, byKey: state.proposalsByKey, compare: compareProposals,
        all: { get: () => state.proposals, set: next => { state.proposals = next; } },
        buckets: [{ map: state.proposalsByRevision, keyOf: ref => ref.revision_digest }] });
      this.mergeDelta({ fresh: freshAgreements, demoted: demotedAgreements, byKey: state.agreementsByKey, compare: compareAgreements,
        buckets: [{ map: state.agreementsByRevision, keyOf: ref => ref.revision_digest }] });
      // 병합이 끝난 뒤에야 완료로 표시한다 — 비교자는 순수하지만, 만약 중간에 예외가
      // 나면 재커밋이 멱등하게 나머지를 반영할 수 있어야 한다.
      committed = true;
    } };
  }

  /** 한 종류의 델타를 커밋한다 — 강등 ref를 모든 색인에서 제거하고 fresh+demoted를 정렬 병합한다. */
  private mergeDelta<Ref extends { key: string; published_checkpoint: Checkpoint }>(spec: {
    fresh: Ref[];
    demoted: Ref[];
    byKey: Map<string, Ref>;
    compare: (left: Ref, right: Ref) => number;
    all?: { get(): Ref[]; set(next: Ref[]): void };
    buckets: { map: Map<string, Ref[]>; keyOf: (ref: Ref) => string }[];
  }): void {
    const { fresh, demoted, byKey, compare, all, buckets } = spec;
    if (demoted.length) {
      const demotedKeys = new Set(demoted.map(ref => ref.key));
      const keep = (item: Ref) => !demotedKeys.has(item.key);
      if (all) all.set(all.get().filter(keep));
      for (const key of demotedKeys) byKey.delete(key);
      for (const bucket of buckets) {
        for (const bucketKey of new Set(demoted.map(ref => bucket.keyOf(ref)))) {
          bucket.map.set(bucketKey, (bucket.map.get(bucketKey) ?? []).filter(keep));
        }
      }
    }
    const incoming = [...fresh, ...demoted];
    if (!incoming.length) return;
    incoming.sort(compare);
    if (all) all.set(prependLatest(incoming, all.get(), compare));
    const grouped = buckets.map(() => new Map<string, Ref[]>());
    for (const ref of incoming) {
      byKey.set(ref.key, ref);
      buckets.forEach((bucket, bucketIndex) => {
        const bucketKey = bucket.keyOf(ref);
        const list = grouped[bucketIndex].get(bucketKey);
        if (list) list.push(ref); else grouped[bucketIndex].set(bucketKey, [ref]);
      });
    }
    buckets.forEach((bucket, bucketIndex) => {
      for (const [bucketKey, refs] of grouped[bucketIndex]) {
        refs.sort(compare);
        bucket.map.set(bucketKey, prependLatest(refs, bucket.map.get(bucketKey) ?? [], compare));
      }
    });
  }

  query<Q extends BrowseQuery>(query: Q): BrowseResult<Q> {
    if (!query || typeof query !== 'object') throw new Error('Invalid browse query');
    assertCheckpoint(query.at, this.channelId);
    if (query.kind === 'revision-annotations') return this.annotations(query) as BrowseResult<Q>;
    if (!Number.isSafeInteger(query.offset) || query.offset < 0 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) throw new Error('Invalid browse page range');
    if (query.kind === 'proposals') return this.proposals(query) as BrowseResult<Q>;
    if (query.kind === 'revisions') return this.revisions(query) as BrowseResult<Q>;
    throw new Error('Invalid browse query');
  }

  private revisions(query: RevisionBrowseQuery): BrowsePage<RevisionBrowseRef> {
    // 선택자 필드는 undefined 또는 비어 있지 않은 문자열만 허용한다 — null 같은
    // 값이 `?? null` 키 생성에서 생략 필터와 별칭되어 다른 필터의 결과를 오염시킨다.
    for (const selector of [query.document_id, query.context_id, query.scope_id, query.usage_scope]) {
      if (selector !== undefined && (typeof selector !== 'string' || selector.length < 1)) throw new Error('Invalid browse revision selector');
    }
    // 캐시 조회 전에 mode·slot 형태를 전부 검증한다 — 유효 질의만 캐시를 만진다.
    if (query.mode === 'slot') {
      if (!query.slot || query.slot.channel_id !== this.channelId) throw new Error('Invalid browse slot');
      slotKey(query.slot);
    } else if (query.mode === 'document') {
      if (typeof query.document_id !== 'string' || query.document_id.length < 1) throw new Error('Invalid browse document');
    } else if (query.mode !== 'all' && query.mode !== 'latest-per-slot') throw new Error('Invalid browse revision mode');
    const cacheKey = revisionCacheKey(query);
    const cached = this.revisionCache.get(cacheKey);
    if (cached) {
      this.revisionCacheHits += 1;
      this.revisionCache.delete(cacheKey); this.revisionCache.set(cacheKey, cached);
      return page(cached.refs, query.offset, query.limit, cloneRevision);
    }
    this.revisionCacheMisses += 1;
    const candidates: readonly RevisionBrowseRef[] =
      query.mode === 'slot' ? this.state.revisionsBySlot.get(slotKey(query.slot!)) ?? []
      : query.mode === 'document' ? this.state.revisionsByDocument.get(query.document_id!) ?? []
      : this.state.revisions;
    let selected = candidates.filter(item => visible(item.published_checkpoint, query.at)
      && (query.document_id === undefined || item.slot.document_id === query.document_id)
      && (query.context_id === undefined || item.slot.context_id === query.context_id)
      && (query.scope_id === undefined || item.slot.scope_id === query.scope_id)
      && (query.usage_scope === undefined || item.slot.usage_scope === query.usage_scope));
    if (query.mode === 'latest-per-slot') {
      const seen = new Set<string>();
      selected = selected.filter(item => { const key = slotKey(item.slot); if (seen.has(key)) return false; seen.add(key); return true; });
    }
    this.cacheRevisions(cacheKey, selected, query.at);
    return page(selected, query.offset, query.limit, cloneRevision);
  }

  /** 캐시 항목을 지우고 카운터를 갱신한다 — 상주 대형 항목 추적도 함께 해제한다. */
  private dropRevisionCacheEntry(key: string): void {
    const entry = this.revisionCache.get(key);
    if (!entry) return;
    this.revisionCache.delete(key);
    this.revisionCacheRefs -= entry.refs.length;
    this.revisionCacheBytes -= entry.estimatedBytes;
    if (this.oversizedRevisionKeys.delete(key)) {
      this.oversizedRevisionRefs -= entry.refs.length;
      this.oversizedRevisionBytes -= entry.estimatedBytes;
    }
  }

  private cacheRevisions(key: string, refs: readonly RevisionBrowseRef[], at: Checkpoint): void {
    const estimatedBytes = Buffer.byteLength(key) + refs.length * ESTIMATED_REF_POINTER_BYTES;
    if (this.revisionCache.has(key)) this.dropRevisionCacheEntry(key);
    if (refs.length > this.maxRevisionCacheRefs) {
      // 결과 건수가 상한을 넘는 선택 집합도 오프셋 페이지네이션이 같은 키로
      // 재질의하므로, 캐시하지 않으면 페이지마다 전체 refs를 다시 걸러
      // O(문서²)가 된다. refs는 state의 객체를 공유하는 포인터 배열이며
      // 대형 풀의 합산 예산 안에서 LRU로 유지한다.
      if (estimatedBytes > this.maxOversizedRevisionCacheBytes) return;
      while (this.oversizedRevisionKeys.size >= this.maxRevisionCacheEntries
        || this.oversizedRevisionBytes + estimatedBytes > this.maxOversizedRevisionCacheBytes) {
        const oldest = [...this.revisionCache.keys()].find(candidate => this.oversizedRevisionKeys.has(candidate));
        if (oldest === undefined) break;
        this.dropRevisionCacheEntry(oldest);
      }
      this.oversizedRevisionKeys.add(key);
      this.oversizedRevisionRefs += refs.length;
      this.oversizedRevisionBytes += estimatedBytes;
    } else if (estimatedBytes > this.maxRevisionCacheBytes) {
      // 바이트만 넘는 항목(거대 키 등)은 캐시하지 않는다 — 상주 대상은
      // 페이지네이션이 재사용하는 큰 결과 집합뿐이다.
      return;
    } else {
      // 일반 항목은 일반 예산 안에서만 축출한다 — 대형 항목을 밀어내면
      // 교차 워크로드에서 큰 선택 집합의 다음 페이지가 다시 전체 필터를 한다.
      const normalRefs = () => this.revisionCacheRefs - this.oversizedRevisionRefs;
      const normalBytes = () => this.revisionCacheBytes - this.oversizedRevisionBytes;
      while (this.revisionCache.size - this.oversizedRevisionKeys.size >= this.maxRevisionCacheEntries
        || normalRefs() + refs.length > this.maxRevisionCacheRefs
        || normalBytes() + estimatedBytes > this.maxRevisionCacheBytes) {
        const oldest = [...this.revisionCache.keys()].find(candidate => !this.oversizedRevisionKeys.has(candidate));
        if (oldest === undefined) break;
        this.dropRevisionCacheEntry(oldest);
      }
    }
    const entry = { refs: [...refs], estimatedBytes, at: cloneCheckpoint(at) };
    this.revisionCache.set(key, entry);
    this.revisionCacheRefs += entry.refs.length;
    this.revisionCacheBytes += estimatedBytes;
  }

  private proposals(query: ProposalBrowseQuery): BrowsePage<ProposalBrowseRef> {
    if (query.revision_digest !== undefined && (typeof query.revision_digest !== 'string' || query.revision_digest.length < 1)) throw new Error('Invalid browse revision digest');
    const candidates = query.revision_digest === undefined ? this.state.proposals : this.state.proposalsByRevision.get(query.revision_digest) ?? [];
    return page(candidates.filter(item => visible(item.published_checkpoint, query.at)), query.offset, query.limit, cloneProposal);
  }

  private annotations(query: AnnotationBrowseQuery): RevisionBrowseAnnotation[] {
    if (!Array.isArray(query.revision_digests) || query.revision_digests.length > 1000
      || query.revision_digests.some(value => typeof value !== 'string' || value.length < 1)) throw new Error('Invalid browse annotation batch; maximum is 1000');
    return query.revision_digests.map(revisionDigest => {
      const annotation: RevisionBrowseAnnotation = { revision_digest: revisionDigest,
        has_proposal: (this.state.proposalsByRevision.get(revisionDigest) ?? []).some(item => visible(item.published_checkpoint, query.at)) };
      const revision = this.state.revisionsByKey.get(keyFor.revision(revisionDigest));
      if (revision && visible(revision.published_checkpoint, query.at)) annotation.revision = cloneRevision(revision);
      const agreement = (this.state.agreementsByRevision.get(revisionDigest) ?? []).find(item => visible(item.published_checkpoint, query.at));
      if (agreement) annotation.agreement = cloneAgreement(agreement);
      return annotation;
    });
  }
}
