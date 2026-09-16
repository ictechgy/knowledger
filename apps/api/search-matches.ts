const MAX_ENTRIES = 8;
const MAX_IDS = 20_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** Exact-query, exact-snapshot results. Only immutable digest strings are retained. */
export class SearchMatchCache {
  private readonly entries = new Map<string, { ids: readonly string[]; bytes: number }>();
  private ids = 0;
  private bytes = 0;

  get(key: string): readonly string[] | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.ids;
  }

  put(key: string, ids: readonly string[]): void {
    this.remove(key);
    const bytes = Buffer.byteLength(key) + ids.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
    // Large results remain correct; they are rescanned rather than retained.
    if (ids.length > MAX_IDS || bytes > MAX_BYTES) return;
    while (this.entries.size >= MAX_ENTRIES || this.ids + ids.length > MAX_IDS || this.bytes + bytes > MAX_BYTES) {
      this.remove(this.entries.keys().next().value!);
    }
    this.entries.set(key, { ids: Object.freeze([...ids]), bytes }); this.ids += ids.length; this.bytes += bytes;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key); this.ids -= entry.ids.length; this.bytes -= entry.bytes;
  }
}
