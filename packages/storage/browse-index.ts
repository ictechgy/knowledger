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
}

const MAX_REVISION_CACHE_ENTRIES = 8;
const MAX_REVISION_CACHE_REFS = 16_384;
const MAX_REVISION_CACHE_BYTES = 512 * 1024;
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


function cloneState(value: BrowseState): BrowseState {
  return {
    revisionsByKey: new Map(value.revisionsByKey), revisions: [...value.revisions],
    revisionsBySlot: new Map(value.revisionsBySlot), revisionsByDocument: new Map(value.revisionsByDocument),
    proposalsByKey: new Map(value.proposalsByKey), proposals: [...value.proposals], proposalsByRevision: new Map(value.proposalsByRevision),
    agreementsByKey: new Map(value.agreementsByKey), agreementsByRevision: new Map(value.agreementsByRevision),
  };
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
  private state: BrowseState = emptyState();
  private revisionCache = new Map<string, RevisionCacheEntry>();
  private revisionCacheRefs = 0;
  private revisionCacheBytes = 0;

  constructor(channelId: string) {
    if (typeof channelId !== 'string' || channelId.length < 1) throw new Error('Invalid browse channel');
    this.channelId = channelId;
  }

  prepare(batches: Iterable<BrowseWriteBatch>): { commit(): void } {
    let next: BrowseState | undefined;
    let addedRevisions = false;
    let addedProposals = false;
    const state = () => next ?? this.state;
    const writable = () => next ??= cloneState(this.state);
    const copiedSlotLists = new Set<string>();
    const copiedDocumentLists = new Set<string>();
    const copiedProposalLists = new Set<string>();
    const copiedAgreementLists = new Set<string>();

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
          const existing = state().revisionsByKey.get(key);
          if (existing) {
            if (!staticRevisionMatches(existing, ref)) throw new Error('Browse index immutable revision fields changed');
            continue;
          }
          const target = writable(); target.revisionsByKey.set(key, ref); target.revisions.push(ref); addedRevisions = true;
          const fullSlot = slotKey(ref.slot);
          let bySlot = target.revisionsBySlot.get(fullSlot);
          if (!bySlot) { bySlot = []; target.revisionsBySlot.set(fullSlot, bySlot); copiedSlotLists.add(fullSlot); }
          else if (!copiedSlotLists.has(fullSlot)) { bySlot = [...bySlot]; target.revisionsBySlot.set(fullSlot, bySlot); copiedSlotLists.add(fullSlot); }
          bySlot.push(ref);
          let byDocument = target.revisionsByDocument.get(ref.slot.document_id);
          if (!byDocument) { byDocument = []; target.revisionsByDocument.set(ref.slot.document_id, byDocument); copiedDocumentLists.add(ref.slot.document_id); }
          else if (!copiedDocumentLists.has(ref.slot.document_id)) { byDocument = [...byDocument]; target.revisionsByDocument.set(ref.slot.document_id, byDocument); copiedDocumentLists.add(ref.slot.document_id); }
          byDocument.push(ref);
        } else if (key.startsWith('kcl:v1:proposal:')) {
          const proposal = validateProposal(value);
          if (key !== keyFor.proposal(proposal.proposal_id) || proposal.channel_id !== this.channelId) throw new Error('Invalid browse proposal binding');
          const ref: ProposalBrowseRef = { key, proposal_id: proposal.proposal_id, revision_digest: proposal.revision_digest,
            slot: cloneSlot(proposal), created_at: proposal.created_at, published_checkpoint: cloneCheckpoint(batch.checkpoint) };
          const existing = state().proposalsByKey.get(key);
          if (existing) {
            if (!staticProposalMatches(existing, ref)) throw new Error('Browse index immutable proposal fields changed');
            continue;
          }
          const target = writable(); target.proposalsByKey.set(key, ref); target.proposals.push(ref); addedProposals = true;
          let byRevision = target.proposalsByRevision.get(ref.revision_digest);
          if (!byRevision) { byRevision = []; target.proposalsByRevision.set(ref.revision_digest, byRevision); copiedProposalLists.add(ref.revision_digest); }
          else if (!copiedProposalLists.has(ref.revision_digest)) { byRevision = [...byRevision]; target.proposalsByRevision.set(ref.revision_digest, byRevision); copiedProposalLists.add(ref.revision_digest); }
          byRevision.push(ref);
        } else if (key.startsWith('kcl:v1:agreement:')) {
          const agreement = validateAgreement(value);
          if (key !== keyFor.agreement(agreement.agreement_id) || agreement.channel_id !== this.channelId) throw new Error('Invalid browse agreement binding');
          const ref: AgreementBrowseRef = { key, agreement_id: agreement.agreement_id, revision_digest: agreement.revision_digest,
            slot: cloneSlot(agreement), activated_at: agreement.activated_at, published_checkpoint: cloneCheckpoint(batch.checkpoint) };
          const existing = state().agreementsByKey.get(key);
          if (existing) {
            if (!staticAgreementMatches(existing, ref)) throw new Error('Browse index immutable agreement fields changed');
            continue;
          }
          const target = writable(); target.agreementsByKey.set(key, ref);
          let byRevision = target.agreementsByRevision.get(ref.revision_digest);
          if (!byRevision) { byRevision = []; target.agreementsByRevision.set(ref.revision_digest, byRevision); copiedAgreementLists.add(ref.revision_digest); }
          else if (!copiedAgreementLists.has(ref.revision_digest)) { byRevision = [...byRevision]; target.agreementsByRevision.set(ref.revision_digest, byRevision); copiedAgreementLists.add(ref.revision_digest); }
          byRevision.push(ref);
        }
      }
    }
    // A startup stream may contain the entire ledger. Append compact refs and
    // sort touched lists once, instead of repeatedly shifting an ever larger
    // array for each historical publication.
    if (next) {
      if (addedRevisions) next.revisions.sort(compareRevisions);
      if (addedProposals) next.proposals.sort(compareProposals);
      for (const key of copiedSlotLists) next.revisionsBySlot.get(key)!.sort(compareRevisions);
      for (const key of copiedDocumentLists) next.revisionsByDocument.get(key)!.sort(compareRevisions);
      for (const key of copiedProposalLists) next.proposalsByRevision.get(key)!.sort(compareProposals);
      for (const key of copiedAgreementLists) next.agreementsByRevision.get(key)!.sort(compareAgreements);
    }
    const prepared = next;
    return { commit: () => { if (prepared) this.state = prepared; } };
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
    const cacheKey = revisionCacheKey(query);
    const cached = this.revisionCache.get(cacheKey);
    if (cached) {
      this.revisionCache.delete(cacheKey); this.revisionCache.set(cacheKey, cached);
      return page(cached.refs, query.offset, query.limit, cloneRevision);
    }
    let candidates: readonly RevisionBrowseRef[];
    if (query.mode === 'slot') {
      if (!query.slot || query.slot.channel_id !== this.channelId) throw new Error('Invalid browse slot');
      candidates = this.state.revisionsBySlot.get(slotKey(query.slot)) ?? [];
    } else if (query.mode === 'document') {
      if (typeof query.document_id !== 'string' || query.document_id.length < 1) throw new Error('Invalid browse document');
      candidates = this.state.revisionsByDocument.get(query.document_id) ?? [];
    } else if (query.mode === 'all' || query.mode === 'latest-per-slot') candidates = this.state.revisions;
    else throw new Error('Invalid browse revision mode');
    let selected = candidates.filter(item => visible(item.published_checkpoint, query.at)
      && (query.document_id === undefined || item.slot.document_id === query.document_id)
      && (query.context_id === undefined || item.slot.context_id === query.context_id)
      && (query.scope_id === undefined || item.slot.scope_id === query.scope_id)
      && (query.usage_scope === undefined || item.slot.usage_scope === query.usage_scope));
    if (query.mode === 'latest-per-slot') {
      const seen = new Set<string>();
      selected = selected.filter(item => { const key = slotKey(item.slot); if (seen.has(key)) return false; seen.add(key); return true; });
    }
    this.cacheRevisions(cacheKey, selected);
    return page(selected, query.offset, query.limit, cloneRevision);
  }

  private cacheRevisions(key: string, refs: readonly RevisionBrowseRef[]): void {
    const estimatedBytes = Buffer.byteLength(key) + refs.length * ESTIMATED_REF_POINTER_BYTES;
    if (refs.length > MAX_REVISION_CACHE_REFS || estimatedBytes > MAX_REVISION_CACHE_BYTES) {
      // 상한을 넘는 결과 집합도 오프셋 페이지네이션이 같은 키로 재질의하므로,
      // 캐시하지 않으면 페이지마다 전체 refs를 다시 걸러 O(문서²)가 된다.
      // refs는 state의 객체를 공유하는 포인터 배열이므로 다른 항목을 비우고
      // 단일 대형 항목으로 유지한다.
      this.revisionCache.clear();
      this.revisionCacheRefs = 0;
      this.revisionCacheBytes = 0;
    } else {
      while (this.revisionCache.size >= MAX_REVISION_CACHE_ENTRIES
        || this.revisionCacheRefs + refs.length > MAX_REVISION_CACHE_REFS
        || this.revisionCacheBytes + estimatedBytes > MAX_REVISION_CACHE_BYTES) {
        const oldest = this.revisionCache.entries().next().value as [string, RevisionCacheEntry] | undefined;
        if (!oldest) break;
        this.revisionCache.delete(oldest[0]);
        this.revisionCacheRefs -= oldest[1].refs.length;
        this.revisionCacheBytes -= oldest[1].estimatedBytes;
      }
    }
    const entry = { refs: [...refs], estimatedBytes };
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
