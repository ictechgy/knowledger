/**
 * Vector candidate index port for the search read model.
 *
 * The index is a candidate source only: it may rank or propose documents,
 * but it is never authoritative. Every candidate is re-verified against the
 * verified ledger state at the request checkpoint before it is returned,
 * and an empty index result must never be read as "no knowledge exists" —
 * required document refs are resolved directly against ledger eligibility.
 */
export interface VectorCandidateQuery {
  /** Query embedding produced by the caller's embedder. */
  readonly embedding: readonly number[];
  readonly context_id?: string;
  readonly scope_id?: string;
  readonly usage_scope?: string;
  readonly limit: number;
}

export interface VectorCandidate {
  readonly document_id: string;
  readonly revision_digest: string;
  readonly context_id: string;
  readonly scope_id: string;
  readonly usage_scope: string;
  readonly score: number;
}

export interface VectorCandidateIndex {
  candidates(query: VectorCandidateQuery): readonly VectorCandidate[] | Promise<readonly VectorCandidate[]>;
  /** Optional lifecycle hook — indexes holding connections should release them here. */
  close?(): void | Promise<void>;
}

/**
 * Write side of a candidate index — a derived store rebuilt only from
 * verified revisions. Implementations may be sync (local) or async (pg).
 */
export interface VectorIndexWriter {
  upsert(entry: VectorIndexEntry): void | Promise<void>;
  remove(revisionDigest: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

export interface VectorIndexEntry {
  readonly document_id: string;
  readonly revision_digest: string;
  readonly context_id: string;
  readonly scope_id: string;
  readonly usage_scope: string;
  readonly embedding: readonly number[];
}

const finite = (values: readonly number[]) => values.length > 0 && values.length <= 4096 && values.every(value => Number.isFinite(value));

/** Shared embedding validity contract for every adapter and query path. */
export function isFiniteEmbedding(values: readonly number[]): boolean {
  return finite(values);
}

/** Cosine similarity; mismatched dimensions are a configuration error, non-finite or zero-norm inputs yield 0. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new TypeError('Embedding dimensions do not match');
  if (!finite(a) || !finite(b)) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let index = 0; index < a.length; index += 1) { dot += a[index]! * b[index]!; na += a[index]! * a[index]!; nb += b[index]! * b[index]!; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * In-process derived index for development and tests. Entries are rebuilt
 * from verified revisions — stale digests are removed on re-keying so an
 * index rebuild cannot resurrect a superseded revision.
 */
export class LocalVectorIndex implements VectorCandidateIndex, VectorIndexWriter {
  private readonly entries = new Map<string, VectorIndexEntry>();

  upsert(entry: VectorIndexEntry): void {
    if (!finite(entry.embedding)) throw new TypeError('Vector index entry requires a finite embedding');
    this.entries.set(entry.revision_digest, entry);
  }
  remove(revisionDigest: string): void { this.entries.delete(revisionDigest); }
  clear(): void { this.entries.clear(); }
  get size(): number { return this.entries.size; }

  candidates(query: VectorCandidateQuery): readonly VectorCandidate[] {
    if (!finite(query.embedding) || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) throw new TypeError('Vector candidate query is invalid');
    const scored: VectorCandidate[] = [];
    for (const entry of this.entries.values()) {
      if (query.context_id !== undefined && entry.context_id !== query.context_id) continue;
      if (query.scope_id !== undefined && entry.scope_id !== query.scope_id) continue;
      if (query.usage_scope !== undefined && entry.usage_scope !== query.usage_scope) continue;
      scored.push({ document_id: entry.document_id, revision_digest: entry.revision_digest, context_id: entry.context_id, scope_id: entry.scope_id, usage_scope: entry.usage_scope, score: cosineSimilarity(query.embedding, entry.embedding) });
    }
    scored.sort((a, b) => b.score - a.score || a.revision_digest.localeCompare(b.revision_digest));
    return scored.slice(0, query.limit);
  }
}

/**
 * Deterministic bag-of-token embedding for development. It gives the local
 * index a real similarity signal without an external model — it is not a
 * semantic embedder and must never be presented as one.
 */
export function developmentEmbedding(text: string, dimensions = 64): number[] {
  if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4096) throw new TypeError('Embedding dimensions out of bounds');
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0 && token.length <= 64);
  for (const token of tokens) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) { hash ^= token.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    vector[Math.abs(hash) % dimensions]! += 1;
  }
  return vector;
}
