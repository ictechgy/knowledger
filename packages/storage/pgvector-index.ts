import { isFiniteEmbedding } from './vector-index.ts';
import type { VectorCandidate, VectorCandidateIndex, VectorCandidateQuery, VectorIndexEntry, VectorIndexWriter } from './vector-index.ts';

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
 *     revision_digest text NOT NULL,
 *     document_id     text NOT NULL,
 *     context_id      text NOT NULL,
 *     scope_id        text NOT NULL,
 *     usage_scope     text NOT NULL,
 *     embedding       vector(<dimensions>) NOT NULL,
 *     index_version   integer NOT NULL,
 *     PRIMARY KEY (revision_digest, index_version)
 *   );
 *   CREATE INDEX ON <table> USING hnsw (embedding vector_cosine_ops);
 */
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export interface PgVectorIndexOptions {
  /** `pg` ClientConfig — connection string, host/credentials, or a pooled config. */
  connection: Record<string, unknown>;
  /** Table name; include the embedding profile version, e.g. `kcl_vector_bge_v1`. */
  table: string;
  /** Rows written under other embedding/index versions are invisible to queries. */
  indexVersion: number;
  /** Optional `pg` module override — injected in tests; deployments rely on the lazy import. */
  pg?: unknown;
}

export class PgVectorIndex implements VectorCandidateIndex, VectorIndexWriter {
  private readonly connection: Record<string, unknown>;
  private readonly table: string;
  private readonly indexVersion: number;
  private readonly pgModule: unknown;
  private opening: Promise<any> | undefined;

  constructor(options: PgVectorIndexOptions) {
    if (!IDENTIFIER.test(options.table)) throw new TypeError('Vector index table must be a simple SQL identifier');
    if (!Number.isSafeInteger(options.indexVersion) || options.indexVersion < 1) throw new TypeError('Vector index version must be a positive integer');
    if (!options.connection || typeof options.connection !== 'object') throw new TypeError('Vector index requires connection settings');
    this.connection = options.connection;
    this.table = options.table;
    this.indexVersion = options.indexVersion;
    this.pgModule = options.pg;
  }

  private async loadPg(): Promise<any> {
    if (this.pgModule) return this.pgModule;
    // 정적 import('pg')로는 pg 타입·패키지가 없는 개발 환경의 타입 검사와 번들링이 깨진다 —
    // 동적 해석은 런타임에만 일어나게 둔다.
    try { return await (new Function('specifier', 'return import(specifier);') as (specifier: string) => Promise<any>)('pg'); }
    catch (error) {
      // 모듈 부재만 안내로 감싼다 — 다른 로딩 실패의 원인은 숨기지 않는다.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') throw error;
      throw new Error('pgvector index requires the optional "pg" package — install it in the deployment that configures an external index', { cause: error });
    }
  }

  private connect(): Promise<any> {
    if (!this.opening) {
      let opening!: Promise<any>;
      opening = (async () => {
        try {
          const pg = await this.loadPg();
          const client = new pg.Client(this.connection);
          // 유휴 연결 손실이 unhandled 'error'로 프로세스를 죽이지 않게 한다 —
          // 자신의 연결만 비우고(지연 error가 새 연결을 버리지 않게) 소켓을 정리해 다음 호출이 재연결한다.
          client.on('error', () => {
            if (this.opening === opening) this.opening = undefined;
            void client.end().catch(() => { /* 이미 죽은 클라이언트 — 정리 실패는 무시해도 안전하다 */ });
          });
          await client.connect();
          return client;
        } catch (error) {
          // 거부된 연결 시도는 남기지 않는다 — 이후 호출이 재시도할 수 있어야 한다.
          if (this.opening === opening) this.opening = undefined;
          throw error;
        }
      })();
      this.opening = opening;
    }
    return this.opening;
  }

  async candidates(query: VectorCandidateQuery): Promise<readonly VectorCandidate[]> {
    if (!isFiniteEmbedding(query.embedding)) throw new TypeError('Vector candidate query embedding is invalid');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) throw new TypeError('Vector candidate query limit is invalid');
    const literal = `[${query.embedding.join(',')}]`;
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

  /** Upsert one entry; re-keying on (revision_digest, index_version) makes rebuilds idempotent. */
  async upsert(entry: VectorIndexEntry): Promise<void> {
    if (!isFiniteEmbedding(entry.embedding)) throw new TypeError('Vector index entry embedding is invalid');
    const literal = `[${entry.embedding.join(',')}]`;
    const client = await this.connect();
    await client.query(
      `INSERT INTO ${this.table} (revision_digest, document_id, context_id, scope_id, usage_scope, embedding, index_version)
       VALUES ($1,$2,$3,$4,$5,$6::vector,$7)
       ON CONFLICT (revision_digest, index_version) DO UPDATE SET
         document_id = EXCLUDED.document_id, context_id = EXCLUDED.context_id, scope_id = EXCLUDED.scope_id,
         usage_scope = EXCLUDED.usage_scope, embedding = EXCLUDED.embedding`,
      [entry.revision_digest, entry.document_id, entry.context_id, entry.scope_id, entry.usage_scope, literal, this.indexVersion]);
  }

  async remove(revisionDigest: string): Promise<void> {
    const client = await this.connect();
    await client.query(`DELETE FROM ${this.table} WHERE revision_digest = $1 AND index_version = $2`, [revisionDigest, this.indexVersion]);
  }

  /** Remove every row under this index version — the rebuild path re-inserts from verified state. */
  async clear(): Promise<void> {
    const client = await this.connect();
    await client.query(`DELETE FROM ${this.table} WHERE index_version = $1`, [this.indexVersion]);
  }

  /**
   * Atomically replace every row of this index version in one transaction —
   * readers never observe an empty or partially populated index during a rebuild.
   */
  async replaceAll(entries: readonly VectorIndexEntry[]): Promise<void> {
    for (const entry of entries) if (!isFiniteEmbedding(entry.embedding)) throw new TypeError('Vector index entry embedding is invalid');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${this.table} WHERE index_version = $1`, [this.indexVersion]);
      for (const entry of entries) {
        await client.query(
          `INSERT INTO ${this.table} (revision_digest, document_id, context_id, scope_id, usage_scope, embedding, index_version)
           VALUES ($1,$2,$3,$4,$5,$6::vector,$7)`,
          [entry.revision_digest, entry.document_id, entry.context_id, entry.scope_id, entry.usage_scope, `[${entry.embedding.join(',')}]`, this.indexVersion]);
      }
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { (error as any).rollback = rollbackError; }
      throw error;
    }
  }

  async close(): Promise<void> {
    const opening = this.opening;
    this.opening = undefined;
    // 거부된 연결 시도는 닫을 대상이 없다 — 삼키지 않고 결과만 무시한다.
    await opening?.then(client => client.end(), () => undefined);
  }
}
