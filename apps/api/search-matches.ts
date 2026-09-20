const MAX_ENTRIES = 8;
const MAX_IDS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;
// 대형 결과 풀 전체의 바이트 예산. 일반 작업 세트와 별도로 제한한다.
const MAX_OVERSIZED_BYTES = 64 * 1024 * 1024;

/** Exact-query, exact-snapshot results. Only immutable digest strings are retained. */
export class SearchMatchCache {
  private readonly maxEntries: number;
  private readonly maxIds: number;
  private readonly maxBytes: number;
  private readonly maxOversizedBytes: number;
  private readonly entries = new Map<string, { ids: readonly string[]; bytes: number }>();
  private ids = 0;
  private bytes = 0;
  private oversizedIds = 0;
  private oversizedBytes = 0;
  private readonly oversizedKeys = new Set<string>();
  private hits = 0;
  private misses = 0;

  constructor(limits?: { maxEntries?: number; maxIds?: number; maxBytes?: number; maxOversizedBytes?: number }) {
    this.maxEntries = limits?.maxEntries ?? MAX_ENTRIES;
    this.maxIds = limits?.maxIds ?? MAX_IDS;
    this.maxBytes = limits?.maxBytes ?? MAX_BYTES;
    this.maxOversizedBytes = limits?.maxOversizedBytes ?? MAX_OVERSIZED_BYTES;
  }

  get(key: string): readonly string[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.misses += 1; return undefined; }
    this.hits += 1;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.ids;
  }

  /** 캐시 관측치 — 진단과 회귀 테스트용. 항목 내용이나 키는 노출하지 않는다. */
  get stats(): { entries: number; ids: number; bytes: number; oversized: boolean; oversizedEntries: number; hits: number; misses: number } {
    return { entries: this.entries.size, ids: this.ids, bytes: this.bytes, oversized: this.oversizedKeys.size > 0, oversizedEntries: this.oversizedKeys.size,
      hits: this.hits, misses: this.misses };
  }

  put(key: string, ids: readonly string[]): void {
    this.remove(key);
    const bytes = Buffer.byteLength(key) + ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
    // 결과 건수가 상한을 넘는 목록도 오프셋 페이지네이션이 같은 키로 재질의하므로,
    // 캐시하지 않으면 페이지마다 전체 원장을 다시 읽어 O(문서²)가 된다.
    // ids는 불변 다이제스트 문자열뿐이며 대형 풀의 합산 예산 안에서 LRU로 유지한다.
    if (ids.length > this.maxIds) {
      if (bytes > this.maxOversizedBytes) return;
      while (this.oversizedKeys.size >= this.maxEntries || this.oversizedBytes + bytes > this.maxOversizedBytes) {
        const oldest = [...this.entries.keys()].find(candidate => this.oversizedKeys.has(candidate));
        if (oldest === undefined) break;
        this.remove(oldest);
      }
      this.oversizedKeys.add(key);
      this.oversizedIds += ids.length;
      this.oversizedBytes += bytes;
    } else if (bytes > this.maxBytes) {
      // 바이트만 넘는 항목(거대 키 등)은 캐시하지 않는다 — 상주 대상은
      // 페이지네이션이 재사용하는 큰 결과 집합뿐이다.
      return;
    } else {
      // 일반 항목은 일반 예산 안에서만 축출한다 — 대형 항목을 밀어내면
      // 교차 워크로드에서 큰 질의의 다음 페이지가 다시 전체 스캔을 한다.
      const normalIds = () => this.ids - this.oversizedIds;
      const normalBytes = () => this.bytes - this.oversizedBytes;
      while (this.entries.size - this.oversizedKeys.size >= this.maxEntries
        || normalIds() + ids.length > this.maxIds || normalBytes() + bytes > this.maxBytes) {
        const oldest = [...this.entries.keys()].find(candidate => !this.oversizedKeys.has(candidate));
        if (oldest === undefined) break;
        this.remove(oldest);
      }
    }
    this.entries.set(key, { ids: Object.freeze([...ids]), bytes }); this.ids += ids.length; this.bytes += bytes;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.ids -= entry.ids.length; this.bytes -= entry.bytes;
    if (this.oversizedKeys.delete(key)) { this.oversizedIds -= entry.ids.length; this.oversizedBytes -= entry.bytes; }
  }
}
