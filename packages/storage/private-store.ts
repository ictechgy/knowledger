import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor } from './local-ledger.ts';

const CREATED_AT = "CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.revision.payload.metadata.created_at') END";
const SUMMARY_FIELDS = {
  title: '$.revision.payload.title', revision_digest: '$.revision.revision_digest',
  document_id: '$.revision.payload.document_id', context_id: '$.revision.payload.context_id',
  scope_id: '$.revision.payload.scope_id', usage_scope: '$.revision.payload.usage_scope',
  source_kind: '$.revision.payload.metadata.source_kind', created_at: '$.revision.payload.metadata.created_at',
  author_id: '$.revision.payload.metadata.author_id', author_org_id: '$.revision.payload.metadata.author_org_id',
};
const SUMMARY_COLUMNS = Object.entries(SUMMARY_FIELDS).map(([name, path]) =>
  `CASE WHEN json_valid(value_json) THEN json_extract(value_json, '${path}') END AS ${name}`).join(', ');
const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;

/** Local-only records. This database is never consumed by the shared ledger projector. */
export class PrivateStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try {
      this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS private_records (
          kind TEXT NOT NULL, record_id TEXT NOT NULL, org_id TEXT NOT NULL,
          actor_id TEXT NOT NULL, value_json TEXT NOT NULL,
          PRIMARY KEY(kind, record_id, org_id, actor_id)
        );
        CREATE INDEX IF NOT EXISTS private_draft_actor_order
          ON private_records(org_id, actor_id, kind, ${CREATED_AT} DESC, record_id DESC);`);
    } catch (error) { this.db.close(); throw error; }
  }
  put(kind: 'draft' | 'preview' | 'run' | 'command', id: string, actor: Actor, value: any): void {
    this.db.prepare('INSERT INTO private_records VALUES (?, ?, ?, ?, ?)').run(kind, id, actor.org_id, actor.actor_id, JSON.stringify(value));
  }
  get(kind: 'draft' | 'preview' | 'run' | 'command', id: string, actor: Actor): any | undefined {
    const row = this.db.prepare('SELECT value_json FROM private_records WHERE kind = ? AND record_id = ? AND org_id = ? AND actor_id = ?').get(kind, id, actor.org_id, actor.actor_id) as any;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  listDrafts(actor: Actor, limit: number, cursor?: string): { rows: any[]; total: number; nextCursor: string | null; corrupt: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid draft page size');
    let cursorCreatedAt: string | undefined;
    if (cursor) {
      const found = this.db.prepare(`SELECT ${CREATED_AT} AS created_at FROM private_records
        WHERE kind = 'draft' AND org_id = ? AND actor_id = ? AND record_id = ?`).get(actor.org_id, actor.actor_id, cursor) as any;
      if (!found) return { rows: [], total: -1, nextCursor: null, corrupt: false };
      if (typeof found.created_at !== 'string' || !Number.isFinite(Date.parse(found.created_at))) return { rows: [], total: 0, nextCursor: null, corrupt: true };
      cursorCreatedAt = found.created_at;
    }
    const total = Number((this.db.prepare("SELECT COUNT(*) AS count FROM private_records WHERE kind = 'draft' AND org_id = ? AND actor_id = ?").get(actor.org_id, actor.actor_id) as any).count);
    const predicate = cursor ? `AND ((${CREATED_AT}, record_id) < (?, ?) OR ${CREATED_AT} IS NULL)` : '';
    const parameters = cursor ? [actor.org_id, actor.actor_id, cursorCreatedAt!, cursor, limit + 1] : [actor.org_id, actor.actor_id, limit + 1];
    const rows = this.db.prepare(`SELECT record_id, ${SUMMARY_COLUMNS} FROM private_records
      WHERE kind = 'draft' AND org_id = ? AND actor_id = ? ${predicate}
      ORDER BY ${CREATED_AT} DESC, record_id DESC LIMIT ?`).all(...parameters) as any[];
    const corrupt = rows.some(row => Object.keys(SUMMARY_FIELDS).some(name => typeof row[name] !== 'string' || row[name].length === 0)
      || row.author_id !== actor.actor_id || row.author_org_id !== actor.org_id
      || row.title.length > 200 || !/^sha256:[0-9a-f]{64}$/.test(row.revision_digest)
      || !['record_id', 'document_id', 'context_id', 'scope_id'].every(name => ID.test(row[name]))
      || !/^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/.test(row.usage_scope)
      || !['human_authored', 'approved_import', 'llm_drafted'].includes(row.source_kind)
      || row.created_at.length > 40 || !Number.isFinite(Date.parse(row.created_at)));
    if (corrupt) return { rows: [], total, nextCursor: null, corrupt: true };
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return { rows: page, total, nextCursor: hasMore ? page.at(-1).record_id : null, corrupt: false };
  }
  close(): void { this.db.close(); }
}
