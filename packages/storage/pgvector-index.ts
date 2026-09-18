import type { VectorCandidate, VectorCandidateIndex, VectorCandidateQuery, VectorIndexEntry } from './vector-index.ts';

/**
 * pgvector-backed candidate index. `pg` is an optional deployment dependency
 * loaded lazily so local runtimes and minimal CI jobs never import it.
 *
 * The index is a derived candidate source only — every row must carry the
 * exact `revision_digest` it was embedded from, and the service re-verifies
 * each candidate against verified ledger state at the request checkpoint.
 * Rebuilding the index from verified revisions is always safe: stale rows
 * are dropped on re-key, never trusted.
 *
 * Expected schema (versioned per embedding profile):
 *
 *   CREATE EXTENSION vector;
 *   CREATE TABLE <table> (
 *     revision_digest text PRIMARY KEY,
 *     document_id     text NOT NULL,
 *     context_id      text NOT NULL,
 *     scope_id        text NOT NULL,
 *     usage_scope     text NOT NULL,
 *     embedding       vector(<dimensions>) NOT NULL,
 *     index_version   integer NOT NULL
 *   );
 *   CREATE INDEX ON <table> USING hnsw (embedding vector_cosine_ops);
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const VECTOR_LITERAL = /^\[[\d.,eE+-]+\]$/;

export interface PgVectorIndexOptions {
  /** `pg` ClientConfig — connection string, host/credentials, or a pooled config. */
  connection: Record<string, unknown>;
  /** Table name; include the embedding profile version, e.g. `kcl_vector_bge_v1`. */
  table: string;
  /** Rows written under other embedding/index versions are invisible to queries. */
  indexVersion: number;
}

export class PgVectorIndex implements VectorCandidateIndex {
  private readonly connection: Record<string, unknown>;
  private readonly table: string;
  private readonly indexVersion: number;
  private client: any;
  private opening: Promise<any> | undefined;

  constructor(options: PgVectorIndexOptions) {
    if (!IDENTIFIER.test(options.table)) throw new TypeError('Vector index table must be a simple SQL identifier');
    if (!Number.isSafeInteger(options.indexVersion) || options.indexVersion < 1) throw new TypeError('Vector index version must be a positive integer');
    if (!options.connection || typeof options.connection !== 'object') throw new TypeError('Vector index requires connection settings');
    this.connection = options.connection;
    this.table = options.table;
    this.indexVersion = options.indexVersion;
  }

  private async connect(): Promise<any> {
    this.opening ??= (async () => {
      let pg: any;
      try { pg = await (new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>)('pg'); }
      catch { throw new Error('pgvector index requires the optional "pg" package — install it in the deployment that configures an external index'); }
      const client = new pg.Client(this.connection);
      await client.connect();
      this.client = client;
      return client;
    })();
    return this.opening;
  }

  async candidates(query: VectorCandidateQuery): Promise<readonly VectorCandidate[]> {
    const literal = `[${query.embedding.join(',')}]`;
    if (!VECTOR_LITERAL.test(literal)) throw new TypeError('Vector candidate query embedding is invalid');
    const client = await this.connect();
    const clauses = ['index_version = $2'];
    const values: unknown[] = [literal, this.indexVersion];
    for (const [field, column] of [['context_id', 'context_id'], ['scope_id', 'scope_id'], ['usage_scope', 'usage_scope']] as const) {
      const value = query[field];
      if (value !== undefined) { values.push(value); clauses.push(`${column} = $${values.length}`); }
    }
    values.push(query.limit);
    const result = await client.query(
      `SELECT revision_digest, document_id, context_id, scope_id, usage_scope,
              1 - (embedding <=> $1::vector) AS score
         FROM ${this.table} WHERE ${clauses.join(' AND ')}
        ORDER BY embedding <=> $1::vector LIMIT $${values.length}`, values);
    return result.rows.map((row: any) => ({ revision_digest: row.revision_digest, document_id: row.document_id,
      context_id: row.context_id, scope_id: row.scope_id, usage_scope: row.usage_scope, score: Number(row.score) }));
  }

  /** Upsert one entry; re-keying on revision_digest makes rebuilds idempotent. */
  async upsert(entry: VectorIndexEntry): Promise<void> {
    const literal = `[${entry.embedding.join(',')}]`;
    if (!VECTOR_LITERAL.test(literal)) throw new TypeError('Vector index entry embedding is invalid');
    const client = await this.connect();
    await client.query(
      `INSERT INTO ${this.table} (revision_digest, document_id, context_id, scope_id, usage_scope, embedding, index_version)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7)
       ON CONFLICT (revision_digest) DO UPDATE SET
         document_id = EXCLUDED.document_id, context_id = EXCLUDED.context_id, scope_id = EXCLUDED.scope_id,
         usage_scope = EXCLUDED.usage_scope, embedding = EXCLUDED.embedding, index_version = EXCLUDED.index_version`,
      [entry.revision_digest, entry.document_id, entry.context_id, entry.scope_id, entry.usage_scope, literal, this.indexVersion]);
  }

  async remove(revisionDigest: string): Promise<void> {
    const client = await this.connect();
    await client.query(`DELETE FROM ${this.table} WHERE revision_digest = $1`, [revisionDigest]);
  }

  /** Remove every row under this index version — the rebuild path re-inserts from verified state. */
  async clear(): Promise<void> {
    const client = await this.connect();
    await client.query(`DELETE FROM ${this.table} WHERE index_version = $1`, [this.indexVersion]);
  }

  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    try { await (await opening)?.end(); } finally { this.client = undefined; }
  }
}
