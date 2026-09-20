import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor } from './local-ledger.ts';
import { ReviewStore } from './review-store.ts';
import { ReviewDeliveryStore } from './review-delivery-store.ts';
import { SlackNoticeStore } from './slack-notice-store.ts';

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
type PrivateKind = 'draft' | 'preview' | 'run' | 'command' | 'source' | 'source-operation' | 'source-schedule';

/** Local-only records. This database is never consumed by the shared ledger projector. */
export class PrivateStore {
  private db: DatabaseSync;
  readonly reviews: ReviewStore;
  readonly deliveries: ReviewDeliveryStore;
  readonly slackNotices: SlackNoticeStore;
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
          ON private_records(org_id, actor_id, kind, ${CREATED_AT} DESC, record_id DESC);
        CREATE INDEX IF NOT EXISTS private_command_actor_order ON private_records(org_id, actor_id, kind);`);
      this.reviews = new ReviewStore(this.db);
      this.deliveries = new ReviewDeliveryStore(this.db);
      this.slackNotices = new SlackNoticeStore(this.db);
    } catch (error) { this.db.close(); throw error; }
  }
  put(kind: PrivateKind, id: string, actor: Actor, value: any): void {
    this.db.prepare('INSERT INTO private_records VALUES (?, ?, ?, ?, ?)').run(kind, id, actor.org_id, actor.actor_id, JSON.stringify(value));
  }
  /** 같은 키의 최신 상태로 덮어쓴다 — run 재검증의 최신 manifest처럼 최신 값만 의미 있는 기록 전용이다. */
  replace(kind: PrivateKind, id: string, actor: Actor, value: any): void {
    this.db.prepare('INSERT INTO private_records VALUES (?, ?, ?, ?, ?) ON CONFLICT(kind,record_id,org_id,actor_id) DO UPDATE SET value_json=excluded.value_json').run(kind, id, actor.org_id, actor.actor_id, JSON.stringify(value));
  }
  get(kind: PrivateKind, id: string, actor: Actor): any | undefined {
    const row = this.db.prepare('SELECT value_json FROM private_records WHERE kind = ? AND record_id = ? AND org_id = ? AND actor_id = ?').get(kind, id, actor.org_id, actor.actor_id) as any;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  atomic<T>(operation:()=>T):T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result=operation(); this.db.exec('COMMIT'); return result; }
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  saveSource(id:string,actor:Actor,value:any):void {
    this.db.prepare(`INSERT INTO private_records VALUES ('source',?,?,?,?)
      ON CONFLICT(kind,record_id,org_id,actor_id) DO UPDATE SET value_json=excluded.value_json`)
      .run(id,actor.org_id,actor.actor_id,JSON.stringify(value));
  }
  sourcePage(actor:Actor,limit:number,cursor?:string):{values:any[];nextCursor:string|null}|undefined {
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new Error('Invalid source page size');
    const position=cursor?this.db.prepare("SELECT rowid FROM private_records WHERE kind='source' AND record_id=? AND org_id=? AND actor_id=?").get(cursor,actor.org_id,actor.actor_id) as {rowid:number}|undefined:undefined;
    if(cursor&&!position)return undefined;
    const rows=this.db.prepare(`SELECT record_id,value_json FROM private_records WHERE kind='source' AND org_id=? AND actor_id=? ${position?'AND rowid < ?':''} ORDER BY rowid DESC LIMIT ?`)
      .all(...(position?[actor.org_id,actor.actor_id,position.rowid,limit+1]:[actor.org_id,actor.actor_id,limit+1])) as {record_id:string;value_json:string}[];
    return {values:rows.slice(0,limit).map(row=>JSON.parse(row.value_json)),nextCursor:rows.length>limit?rows[limit-1].record_id:null};
  }
  updateCommand(id: string, actor: Actor, value: any): void {
    const result = this.db.prepare("UPDATE private_records SET value_json = ? WHERE kind = 'command' AND record_id = ? AND org_id = ? AND actor_id = ?")
      .run(JSON.stringify(value), id, actor.org_id, actor.actor_id);
    if (result.changes !== 1) throw new Error('Private command is missing');
  }
  commandPage(actor: Actor, limit: number, cursor?: string): { rows: {id:string;value:any}[]; nextCursor: string | null } | undefined {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid command page size');
    const position = cursor ? this.db.prepare("SELECT rowid FROM private_records WHERE kind = 'command' AND org_id = ? AND actor_id = ? AND record_id = ?")
      .get(actor.org_id, actor.actor_id, cursor) as {rowid:number}|undefined : undefined;
    if (cursor && !position) return undefined;
    const rows = this.db.prepare(`SELECT record_id, value_json FROM private_records WHERE kind = 'command' AND org_id = ? AND actor_id = ?
      ${position ? 'AND rowid < ?' : ''} ORDER BY rowid DESC LIMIT ?`)
      .all(...(position ? [actor.org_id, actor.actor_id, position.rowid, limit+1] : [actor.org_id, actor.actor_id, limit+1])) as {record_id:string;value_json:string}[];
    return {rows:rows.slice(0,limit).map(row=>({id:row.record_id,value:JSON.parse(row.value_json)})),nextCursor:rows.length>limit ? rows[limit-1].record_id : null};
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
