import type { Slot } from '../domain/index.ts';
import type { Checkpoint } from './local-ledger.ts';

/** Compact, process-owned references derived only from verified committed writes. */
export interface RevisionBrowseRef {
  key: string;
  revision_digest: string;
  slot: Slot;
  published_checkpoint: Checkpoint;
}
export interface ProposalBrowseRef {
  key: string;
  proposal_id: string;
  revision_digest: string;
  slot: Slot;
  created_at: string;
  published_checkpoint: Checkpoint;
}
export interface AgreementBrowseRef {
  key: string;
  agreement_id: string;
  revision_digest: string;
  slot: Slot;
  activated_at: string;
  published_checkpoint: Checkpoint;
}
interface PageQuery { at: Checkpoint; offset: number; limit: number }
export interface RevisionBrowseQuery extends PageQuery {
  kind: 'revisions';
  mode: 'latest-per-slot' | 'all' | 'slot' | 'document';
  slot?: Slot;
  document_id?: string;
  context_id?: string;
  scope_id?: string;
  usage_scope?: string;
}
export interface ProposalBrowseQuery extends PageQuery {
  kind: 'proposals';
  revision_digest?: string;
}
export interface AnnotationBrowseQuery {
  kind: 'revision-annotations';
  at: Checkpoint;
  revision_digests: string[];
}
export interface RevisionBrowseAnnotation {
  revision_digest: string;
  revision?: RevisionBrowseRef;
  has_proposal: boolean;
  agreement?: AgreementBrowseRef;
}
export interface BrowsePage<T> { items: T[]; total: number }
export type BrowseQuery = RevisionBrowseQuery | ProposalBrowseQuery | AnnotationBrowseQuery;
export type BrowseResult<Q extends BrowseQuery> = Q extends RevisionBrowseQuery ? BrowsePage<RevisionBrowseRef>
  : Q extends ProposalBrowseQuery ? BrowsePage<ProposalBrowseRef> : RevisionBrowseAnnotation[];
/** Adapters assert the exact checkpoint before querying this optimization port. */
export interface BrowseQueryFunction { <Q extends BrowseQuery>(query: Q): BrowseResult<Q> }
export interface BrowseWriteBatch { checkpoint: Checkpoint; writes: readonly (readonly [string, unknown])[] }
