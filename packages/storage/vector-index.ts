/**
 * 검색 읽기 모델의 벡터 후보 색인 포트.
 *
 * 색인은 후보 제안기일 뿐 결정권이 없다 — 모든 후보는 반환 전 요청 체크포인트의
 * 검증된 원장 상태로 재검증되고, 빈 색인 결과를 "지식이 없다"로 읽으면 안 된다.
 * 필수 문서 참조는 색인과 무관하게 원장 자격으로 직접 해상한다.
 */
export interface VectorCandidateQuery {
  /** 호출자의 임베더가 만든 질의 임베딩. */
  readonly embedding: readonly number[];
  readonly context_id?: string;
  readonly scope_id?: string;
  readonly usage_scope?: string;
  readonly limit: number;
}

/**
 * 색인이 제안한 후보 행 — 서비스는 revision_digest와 score만 소비한다.
 * document_id·slot 필드는 색인 측 태그일 뿐 신뢰되지 않는다 — 범위 필터는
 * 검증된 개정본의 slot과 대조되므로 어댑터는 태그를 정확하게 채워야 하지만
 * 소비자는 태그를 자격 근거로 쓰지 않는다.
 */
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
  /** 선택적 수명주기 훅 — 연결을 쥐는 색인은 여기서 해제한다. */
  close?(): void | Promise<void>;
}

/**
 * 후보 색인의 쓰기 측 — 검증된 개정본에서만 재구축되는 파생 저장소다.
 * 구현은 동기(local)거나 비동기(pg)일 수 있다.
 */
export interface VectorIndexWriter {
  upsert(entry: VectorIndexEntry): void | Promise<void>;
  remove(revisionDigest: string): void | Promise<void>;
  clear(): void | Promise<void>;
  /**
   * 이 색인 버전의 모든 행을 원자적으로 교체한다 — 재구축 도중에도
   * 읽기 경로에 빈·부분 색인이 노출되지 않는다.
   */
  replaceAll(entries: readonly VectorIndexEntry[]): void | Promise<void>;
}

export interface VectorIndexEntry {
  readonly document_id: string;
  readonly revision_digest: string;
  readonly context_id: string;
  readonly scope_id: string;
  readonly usage_scope: string;
  readonly embedding: readonly number[];
}

/**
 * 배열 여부와 조밀한 유한 원소를 순서대로 확인한다 — 희소 배열의 구멍은
 * undefined라 유한 검사에서 걸러지고, null·비배열은 예외 없이 거짓을 돌려
 * 호출자의 오류 경계 안에서 처리되게 한다.
 */
const finite = (values: unknown): values is readonly number[] => {
  if (!Array.isArray(values) || values.length < 1 || values.length > 4096) return false;
  for (let index = 0; index < values.length; index += 1) if (!Number.isFinite(values[index])) return false;
  return true;
};

/** 모든 어댑터와 질의 경로가 공유하는 임베딩 유효성 계약. */
export function isFiniteEmbedding(values: unknown): values is readonly number[] {
  return finite(values);
}

/**
 * 코사인 유사도 — 차원 불일치는 설정 오류, 비유한·영노름 입력은 0이다.
 * 각 벡터를 자신의 최대 절댓값으로 나눠 누적해 1e308의 제곱 오버플로와
 * 1e-308의 언더플로 없이 극단적 유한 값에서도 유한한 점수를 보장한다.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new TypeError('Embedding dimensions do not match');
  if (!finite(a) || !finite(b)) return 0;
  const scale = (values: readonly number[]) => Math.max(...values.map(Math.abs));
  const sa = scale(a), sb = scale(b);
  if (sa === 0 || sb === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index]! / sa, y = b[index]! / sb;
    dot += x * y; na += x * x; nb += y * y;
  }
  const score = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return Number.isFinite(score) ? score : 0;
}

/**
 * 개발과 테스트용 인프로세스 파생 색인. 항목은 검증된 개정본에서만 채워진다.
 * upsert는 다이제스트 키 갱신이라 대체된 이전 다이제스트 행이 남지만,
 * replaceAll 재구축이 맵을 통째로 갈아 낡은 행을 모두 버린다 — 재구축이
 * 대체된 개정본을 되살리지 않는다.
 */
export class LocalVectorIndex implements VectorCandidateIndex, VectorIndexWriter {
  private entries = new Map<string, VectorIndexEntry>();

  upsert(entry: VectorIndexEntry): void {
    if (!finite(entry.embedding)) throw new TypeError('Vector index entry requires a finite embedding');
    this.entries.set(entry.revision_digest, entry);
  }
  remove(revisionDigest: string): void { this.entries.delete(revisionDigest); }
  clear(): void { this.entries.clear(); }
  /** 모든 행을 먼저 검증한 뒤 맵을 통째로 바꿔 읽기 경로에 부분 색인이 보이지 않게 한다. */
  replaceAll(entries: readonly VectorIndexEntry[]): void {
    const next = new Map<string, VectorIndexEntry>();
    for (const entry of entries) {
      if (!finite(entry.embedding)) throw new TypeError('Vector index entry requires a finite embedding');
      next.set(entry.revision_digest, entry);
    }
    this.entries = next;
  }
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
 * 개발용 결정적 bag-of-token 임베딩 — 외부 모델 없이 로컬 색인에 실제 유사도
 * 신호를 준다. 의미 임베더가 아니며 그런 것처럼 보여서도 안 된다.
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
