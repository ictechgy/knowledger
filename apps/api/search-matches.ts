const MAX_ENTRIES = 8;
const MAX_IDS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Exact-query, exact-snapshot results. Only immutable digest strings are retained. */
export class SearchMatchCache {
  private readonly entries = new Map<string, { ids: readonly string[]; bytes: number }>();
  private ids = 0;
  private bytes = 0;
  private oversizedIds = 0;
  private oversizedBytes = 0;
  private oversizedKey: string | undefined;

  get(key: string): readonly string[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.ids;
  }

  /** 캐시 관측치 — 진단과 회귀 테스트용. 항목 내용이나 키는 노출하지 않는다. */
  get stats(): { entries: number; ids: number; bytes: number; oversized: boolean } {
    return { entries: this.entries.size, ids: this.ids, bytes: this.bytes, oversized: this.oversizedKey !== undefined };
  }

  put(key: string, ids: readonly string[]): void {
    this.remove(key);
    const bytes = Buffer.byteLength(key) + ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
    // 결과 건수가 상한을 넘는 목록도 오프셋 페이지네이션이 같은 키로 재질의하므로,
    // 캐시하지 않으면 페이지마다 전체 원장을 다시 읽어 O(문서²)가 된다.
    // ids는 불변 다이제스트 문자열뿐이므로 다른 항목을 비우고 단일 대형 항목으로 유지한다.
    // 바이트만 넘는 작은 결과는 일반 경로로 두어 거대 키가 작업 세트를 밀어내지 않게 한다.
    if (ids.length > MAX_IDS) {
      for (const existing of [...this.entries.keys()]) this.remove(existing);
      this.oversizedKey = key;
      this.oversizedIds = ids.length;
      this.oversizedBytes = bytes;
    } else {
      // 일반 항목은 일반 예산 안에서만 축출한다 — 대형 항목을 밀어내면
      // 교차 워크로드에서 큰 질의의 다음 페이지가 다시 전체 스캔을 한다.
      const normalIds = () => this.ids - this.oversizedIds;
      const normalBytes = () => this.bytes - this.oversizedBytes;
      while (this.entries.size - (this.oversizedKey === undefined ? 0 : 1) >= MAX_ENTRIES
        || normalIds() + ids.length > MAX_IDS || normalBytes() + bytes > MAX_BYTES) {
        const oldest = [...this.entries.keys()].find(candidate => candidate !== this.oversizedKey);
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
    if (key === this.oversizedKey) { this.oversizedKey = undefined; this.oversizedIds = 0; this.oversizedBytes = 0; }
  }
}
