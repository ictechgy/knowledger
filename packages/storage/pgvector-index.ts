import { isFiniteEmbedding } from './vector-index.ts';
import type { VectorCandidate, VectorCandidateIndex, VectorCandidateQuery, VectorIndexEntry, VectorIndexWriter } from './vector-index.ts';

/**
 * pgvector 기반 후보 색인. `pg`는 지연 로드되는 선택적 배포 의존성이라
 * 로컬 런타임과 최소 CI 작업은 이 모듈을 절대 import하지 않는다.
 *
 * 색인은 파생 후보 공급원일 뿐이다 — 모든 행은 임베딩된 원본의 정확한
 * `revision_digest`를 가져야 하고, 서비스는 각 후보를 요청 체크포인트의
 * 검증된 원장 상태로 재검증한다. 검증된 개정본에서의 색인 재구축은 항상
 * 안전하다 — 낡은 행은 재키잉 때 버려지지 신뢰되지 않는다.
 *
 * 기대 스키마(임베딩 프로파일별 버전):
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
  /** `pg` ClientConfig — 단일 클라이언트의 연결 문자열이나 호스트·자격증명. */
  connection: Record<string, unknown>;
  /** 테이블 이름 — 임베딩 프로파일 버전을 포함한다(예: `kcl_vector_bge_v1`). */
  table: string;
  /** 다른 임베딩·색인 버전으로 기록된 행은 질의에 보이지 않는다. */
  indexVersion: number;
  /** 선택적 `pg` 모듈 오버라이드 — 테스트에서 주입; 배포는 지연 import에 의존한다. */
  pg?: unknown;
  /** 선택적 지연 `pg` 로더 오버라이드 — 모듈 부재를 결정적으로 재현하는 테스트용. */
  pgLoader?: () => Promise<unknown>;
}

export class PgVectorIndex implements VectorCandidateIndex, VectorIndexWriter {
  private readonly connection: Record<string, unknown>;
  private readonly table: string;
  private readonly indexVersion: number;
  private readonly pgModule: unknown;
  private readonly pgLoader: (() => Promise<unknown>) | undefined;
  private opening: Promise<any> | undefined;
  /**
   * 공유 클라이언트 직렬화 큐 — pg는 개별 문장만 직렬화할 뿐 다중문 트랜잭션은
   * 보호하지 못한다. BEGIN/SELECT/COMMIT이 다른 호출과 문장 단위로 섞이면
   * 중첩 트랜잭션·설정 덮어쓰기·타 호출 ROLLBACK으로의 오염이 생기므로
   * 공유 클라이언트의 모든 연산을 이 큐로 직렬화한다. 절대 거부되지 않게
   * 유지해 await만으로 드레인할 수 있다.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: PgVectorIndexOptions) {
    if (!IDENTIFIER.test(options.table)) throw new TypeError('Vector index table must be a simple SQL identifier');
    if (!Number.isSafeInteger(options.indexVersion) || options.indexVersion < 1) throw new TypeError('Vector index version must be a positive integer');
    if (!options.connection || typeof options.connection !== 'object') throw new TypeError('Vector index requires connection settings');
    this.connection = options.connection;
    this.table = options.table;
    this.indexVersion = options.indexVersion;
    this.pgModule = options.pg;
    this.pgLoader = options.pgLoader;
  }

  /** pg 모듈을 해석한다 — 주입된 모듈·주입된 로더·지연 import 순서로 시도한다. */
  private async loadPg(): Promise<any> {
    if (this.pgModule) return this.pgModule;
    try { if (this.pgLoader) return await this.pgLoader(); }
    catch (error) { throw this.pgModuleError(error); }
    // 변수 지정자로 두면 tsc가 pg 타입 없이도 컴파일하고 번들러가 정적 해석을 강요하지 않는다 —
    // 모듈 해석은 어댑터를 실제로 쓰는 런타임에만 일어난다.
    const specifier = 'pg';
    try { return await import(specifier); }
    catch (error) { throw this.pgModuleError(error); }
  }

  /**
   * pg 모듈 부재를 영구 설정 오류로 변환한다 — 모듈 부재 이외의 import 실패는
   * 그대로 다시 던져 원인을 보존한다.
   */
  private pgModuleError(error: unknown): unknown {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return error;
    return new TypeError('pgvector index requires the optional "pg" package — install it in the deployment that configures an external index', { cause: error });
  }

  /**
   * 차원·형 불일치·스키마 부재 같은 pg 거부는 재시도로 해소되지 않는 영구 설정
   * 오류다 — SQLSTATE 42클래스(테이블·컬럼·권한 부재)·22클래스(데이터 예외)와
   * 3D000(카탈로그 부재)를 TypeError로 변환해 서비스가 INDEX_MISCONFIGURED로
   * 분류하게 한다. 그 외 연결·일시 오류는 그대로 전파해 재시도 가능으로 남긴다.
   */
  private async run(client: any, text: string, values: unknown[]) {
    try { return await client.query(text, values); }
    catch (error) {
      const code = String((error as any)?.code ?? '');
      if (code.startsWith('42') || code.startsWith('22') || code === '3D000' || /different vector dimensions|expected \d+ dimensions/i.test(String((error as Error)?.message))) {
        throw new TypeError('pgvector rejected the request shape or schema — check index table, dimensions, and privileges', { cause: error });
      }
      throw error;
    }
  }

  /**
   * 공유 클라이언트 연산의 독점 실행 — 호출된 연산은 큐의 이전 작업이 끝난 뒤에만
   * 시작해 다중문 트랜잭션이 다른 호출의 문장과 섞이지 않는다. 큐 자체는
   * 결과와 무관하게 절대 거부되지 않게 유지해 다음 연산이 항상 진행된다.
   */
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * 공유 클라이언트의 연결 Promise를 돌려준다 — 첫 호출이 연결을 열고 이후
   * 호출은 같은 Promise를 공유한다. 연결 실패는 Promise를 비우고 클라이언트를
   * 닫아 다음 호출이 재시도하게 한다.
   */
  private connect(): Promise<any> {
    if (!this.opening) {
      // 클로저 안에서 자기 Promise를 참조해야 해 선언 후 할당한다 —
      // 참조는 첫 await 이후의 콜백에서만 일어나므로 할당 전 사용은 없다.
      let opening!: Promise<any>;
      opening = (async () => {
        let client: any;
        try {
          const pg = await this.loadPg();
          client = new pg.Client(this.connection);
          // 유휴 연결 손실이 unhandled 'error'로 프로세스를 죽이지 않게 한다 —
          // 자신의 연결만 비우고(지연 error가 새 연결을 버리지 않게) 소켓을 정리해 다음 호출이 재연결한다.
          client.on('error', () => {
            if (this.opening === opening) this.opening = undefined;
            void client.end().catch(() => { /* 이미 죽은 클라이언트 — 정리 실패는 무시해도 안전하다 */ });
          });
          await client.connect();
          return client;
        } catch (error) {
          // 로더·생성·연결 어디서 실패해도 거부된 Promise는 남기지 않는다 —
          // 고착되면 close() 전까지 모든 호출이 같은 오류를 반복한다.
          // 만든 클라이언트는 누수하지 않게 닫고 이후 호출이 재시도하게 둔다.
          if (this.opening === opening) this.opening = undefined;
          void client?.end?.()?.catch(() => { /* 열리지 못한 연결의 정리 실패는 무시해도 안전하다 */ });
          throw error;
        }
      })();
      this.opening = opening;
    }
    return this.opening;
  }

  /**
   * 이 색인 버전의 행에서 코사인 근접 후보를 limit까지 돌려준다.
   * 공유 클라이언트의 트랜잭션 안에서 LOCAL ef_search를 올려 요청 한도의
   * 후보를 모두 훑되 다른 호출의 세션 설정과 섞이지 않게 한다.
   */
  async candidates(query: VectorCandidateQuery): Promise<readonly VectorCandidate[]> {
    if (!isFiniteEmbedding(query.embedding)) throw new TypeError('Vector candidate query embedding is invalid');
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 1000) throw new TypeError('Vector candidate query limit is invalid');
    const literal = `[${query.embedding.join(',')}]`;
    return this.exclusive(async () => {
      const client = await this.connect();
      const clauses = ['index_version = $2'];
      const values: unknown[] = [literal, this.indexVersion];
      for (const [field, column] of [['context_id', 'context_id'], ['scope_id', 'scope_id'], ['usage_scope', 'usage_scope']] as const) {
        const value = query[field];
        if (value !== undefined) { values.push(value); clauses.push(`${column} = $${values.length}`); }
      }
      values.push(query.limit);
      // HNSW 인덱스는 ef_search(기본 40)까지만 후보를 훑는다 — 요청 한도까지 돌려받으려면
      // 올려야 하는데, 세션 전역 설정은 한도가 다른 동시 호출끼리 섞일 수 있다.
      // 트랜잭션 안의 LOCAL 설정으로 묶어 이 호출에만 적용한다.
      let result: any;
      await this.run(client, 'BEGIN', []);
      try {
        await this.run(client, `SELECT set_config('hnsw.ef_search', $1, true)`, [String(query.limit)]);
        result = await this.run(client,
          `SELECT revision_digest, document_id, context_id, scope_id, usage_scope,
                  1 - (embedding <=> $1::vector) AS score
             FROM ${this.table} WHERE ${clauses.join(' AND ')}
            ORDER BY embedding <=> $1::vector LIMIT $${values.length}`, values);
        await this.run(client, 'COMMIT', []);
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch (rollbackError) { (error as any).rollback = rollbackError; }
        throw error;
      }
      return result.rows.map((row: any) => ({ revision_digest: row.revision_digest, document_id: row.document_id,
        context_id: row.context_id, scope_id: row.scope_id, usage_scope: row.usage_scope, score: Number(row.score) }));
    });
  }

  /** 항목 하나를 올리거나 갱신한다 — (revision_digest, index_version) 재키잉으로 재구축이 멱등이다. */
  async upsert(entry: VectorIndexEntry): Promise<void> {
    if (!isFiniteEmbedding(entry.embedding)) throw new TypeError('Vector index entry embedding is invalid');
    const literal = `[${entry.embedding.join(',')}]`;
    return this.exclusive(async () => {
      const client = await this.connect();
      await this.run(client,
        `INSERT INTO ${this.table} (revision_digest, document_id, context_id, scope_id, usage_scope, embedding, index_version)
         VALUES ($1,$2,$3,$4,$5,$6::vector,$7)
         ON CONFLICT (revision_digest, index_version) DO UPDATE SET
           document_id = EXCLUDED.document_id, context_id = EXCLUDED.context_id, scope_id = EXCLUDED.scope_id,
           usage_scope = EXCLUDED.usage_scope, embedding = EXCLUDED.embedding`,
        [entry.revision_digest, entry.document_id, entry.context_id, entry.scope_id, entry.usage_scope, literal, this.indexVersion]);
    });
  }

  /** 이 색인 버전에서 한 다이제스트의 행을 지운다. */
  async remove(revisionDigest: string): Promise<void> {
    return this.exclusive(async () => {
      const client = await this.connect();
      await this.run(client, `DELETE FROM ${this.table} WHERE revision_digest = $1 AND index_version = $2`, [revisionDigest, this.indexVersion]);
    });
  }

  /** 이 색인 버전의 모든 행을 지운다 — 재구축 경로는 검증된 상태에서 다시 채운다. */
  async clear(): Promise<void> {
    return this.exclusive(async () => {
      const client = await this.connect();
      await this.run(client, `DELETE FROM ${this.table} WHERE index_version = $1`, [this.indexVersion]);
    });
  }

  /**
   * 이 색인 버전의 모든 행을 하나의 트랜잭션으로 원자 교체한다.
   * 전용 연결에서 실행해 공유 클라이언트의 동시 candidates() 읽기가 COMMIT까지
   * 재구축 전 커밋 행을 계속 본다 — 빈·부분 색인이 읽기에 노출되지 않는다.
   */
  async replaceAll(entries: readonly VectorIndexEntry[]): Promise<void> {
    for (const entry of entries) if (!isFiniteEmbedding(entry.embedding)) throw new TypeError('Vector index entry embedding is invalid');
    // LocalVectorIndex와 같은 마지막-wins 의미 — 같은 다이제스트의 중복 행이
    // 다중행 INSERT에서 23505로 전체를 거절하지 않게 먼저 병합한다.
    const deduped = [...new Map(entries.map(entry => [entry.revision_digest, entry])).values()];
    const pg = await this.loadPg();
    const client = new pg.Client(this.connection);
    // 전용 연결의 error 이벤트를 삼키지 않으면 프로세스가 죽는다 — 실패는 아래 await에서 잡힌다.
    client.on('error', () => { /* 실패는 query/connect await에서 전파된다 */ });
    try {
      // connect도 try 안에 둔다 — 연결 실패가 finally의 end()를 건너뛰면 안 된다.
      await client.connect();
      await this.run(client, 'BEGIN', []);
      await this.run(client, `DELETE FROM ${this.table} WHERE index_version = $1`, [this.indexVersion]);
      // 행 단위 왕복을 피해 200행씩 다중행 INSERT로 묶는다 — 대규모 원장의
      // 재구축 트랜잭션과 트랜잭션을 여는 HTTP 요청이 지나치게 길어지지 않게 한다.
      for (let start = 0; start < deduped.length; start += 200) {
        const batch = deduped.slice(start, start + 200);
        const placeholders = batch.map((_, row) => `($${row * 7 + 1},$${row * 7 + 2},$${row * 7 + 3},$${row * 7 + 4},$${row * 7 + 5},$${row * 7 + 6}::vector,$${row * 7 + 7})`).join(',');
        await this.run(client,
          `INSERT INTO ${this.table} (revision_digest, document_id, context_id, scope_id, usage_scope, embedding, index_version) VALUES ${placeholders}`,
          batch.flatMap(entry => [entry.revision_digest, entry.document_id, entry.context_id, entry.scope_id, entry.usage_scope, `[${entry.embedding.join(',')}]`, this.indexVersion]));
      }
      await this.run(client, 'COMMIT', []);
    } catch (error) {
      try { await client.query('ROLLBACK'); }
      catch (rollbackError) { (error as any).rollback = rollbackError; }
      throw error;
    } finally {
      // 전용 연결은 요청마다 닫는다 — 정리 실패는 이미 죽은 소켓이므로 다음 호출에 영향이 없다.
      await client.end().catch(() => { /* 이미 죽은 연결의 종료 실패는 무시해도 안전하다 */ });
    }
  }

  /** 큐 작업을 드레인한 뒤 공유 클라이언트를 닫는다 — 이후 호출은 재연결한다. */
  async close(): Promise<void> {
    // 드레인과 해제를 한 큐 슬롯에서 처리한다 — 사이에 들어온 연산이
    // 곧 닫힐 클라이언트를 받는 경합을 막는다.
    await this.exclusive(async () => {
      const opening = this.opening;
      this.opening = undefined;
      // 거부된 연결 시도는 닫을 대상이 없다 — 삼키지 않고 결과만 무시한다.
      await opening?.then(client => client.end(), () => undefined);
    });
  }
}
