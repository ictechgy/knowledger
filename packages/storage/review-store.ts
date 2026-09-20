import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalize } from '../domain/index.ts';
import type { Actor } from './local-ledger.ts';

export interface ReviewPerson { org_id: string; actor_id: string }
export interface ReviewSchedule {
  revision_digest: string; version: number; assignees: ReviewPerson[];
  due_at: string | null; repeat_after_days: number | null; completed_at: string | null;
}
export interface ReviewEvent {
  event_id: string; revision_digest: string; author: Actor; created_at: string;
  kind: 'comment' | 'schedule' | 'reviewed'; body: string; mentions: ReviewPerson[];
  schedule: ReviewSchedule | null;
}
export class ReviewStoreError extends Error {
  readonly code: string; readonly status: number;
  constructor(code: string, status: number) {
    super(status === 409 ? '검토 일정이 바뀌었거나 같은 작업 ID의 내용이 다릅니다. 새로고침해 주세요.' : '검토 기록을 확인할 수 없습니다.');
    this.code = code; this.status = status;
  }
}
const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const iso = (value: any) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export function reviewPeople(value: any): value is ReviewPerson[] {
  return Array.isArray(value) && value.length <= 16 && value.every(p => p && Object.keys(p).sort().join(',') === 'actor_id,org_id' && ID.test(p.org_id) && ID.test(p.actor_id))
    && new Set(value.map(p => JSON.stringify([p.org_id, p.actor_id]))).size === value.length;
}
function scheduleFrom(value: any, digest: string): ReviewSchedule {
  if (!value || Object.keys(value).sort().join(',') !== 'assignees,completed_at,due_at,repeat_after_days,revision_digest,version'
    || value.revision_digest !== digest || !DIGEST.test(digest) || !Number.isSafeInteger(value.version) || value.version < 1
    || !reviewPeople(value.assignees) || value.assignees.length === 0 || (value.due_at !== null && !iso(value.due_at))
    || (value.completed_at !== null && !iso(value.completed_at))
    || (value.repeat_after_days !== null && value.due_at === null)
    || (value.repeat_after_days !== null && (!Number.isSafeInteger(value.repeat_after_days) || value.repeat_after_days < 1 || value.repeat_after_days > 3650))) throw new ReviewStoreError('REVIEW_RECORD_CORRUPT', 503);
  return value;
}
function eventFrom(row: any): ReviewEvent {
  try {
    const event = JSON.parse(row.value_json);
    if (Object.keys(event).sort().join(',') !== 'author,body,created_at,event_id,kind,mentions,revision_digest,schedule'
      || event.event_id !== row.event_id || event.revision_digest !== row.revision_digest || !DIGEST.test(event.revision_digest)
      || !ID.test(event.event_id) || !iso(event.created_at) || !reviewPeople([event.author && { org_id: event.author.org_id, actor_id: event.author.actor_id }])
      || event.author.org_id !== row.org_id || event.author.actor_id !== row.actor_id
      || !['human', 'agent'].includes(event.author.kind) || !['comment', 'schedule', 'reviewed'].includes(event.kind)
      || typeof event.body !== 'string' || !event.body.trim() || event.body.length > 4000 || !reviewPeople(event.mentions)) throw new Error();
    if (event.kind === 'comment' ? event.schedule !== null : !event.schedule) throw new Error();
    if (event.schedule) scheduleFrom(event.schedule, event.revision_digest);
    return event;
  } catch { throw new ReviewStoreError('REVIEW_RECORD_CORRUPT', 503); }
}
export function reviewPage(input: { limit?: number; cursor?: string }) {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 || (input.cursor !== undefined && (typeof input.cursor !== 'string'
    || !/^[1-9][0-9]{0,15}$/.test(input.cursor) || !Number.isSafeInteger(Number(input.cursor))))) throw new ReviewStoreError('INVALID_QUERY', 400);
  return { limit, before: input.cursor ? Number(input.cursor) : Number.MAX_SAFE_INTEGER };
}

/** Advisory records shared only by authenticated members of this application installation.
 * Stored in private-local.sqlite for the existing stopped-app backup/restore contract.
 * These tables are never used as ledger, approval, or knowledge-use evidence. */
export class ReviewStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS review_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, revision_digest TEXT NOT NULL,
      org_id TEXT NOT NULL, actor_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, value_json TEXT NOT NULL,
      UNIQUE(org_id, actor_id, operation_id));
      CREATE INDEX IF NOT EXISTS review_events_revision ON review_events(revision_digest, seq DESC);
      CREATE TABLE IF NOT EXISTS review_schedules (revision_digest TEXT PRIMARY KEY, value_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS review_assignees (revision_digest TEXT NOT NULL, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
        due_at TEXT, PRIMARY KEY(revision_digest, org_id, actor_id));
      CREATE INDEX IF NOT EXISTS review_due_actor ON review_assignees(org_id, actor_id, due_at, revision_digest);
      CREATE TABLE IF NOT EXISTS review_notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL,
        org_id TEXT NOT NULL, actor_id TEXT NOT NULL, read_at TEXT, UNIQUE(event_id, org_id, actor_id));
      CREATE INDEX IF NOT EXISTS review_notifications_actor ON review_notifications(org_id, actor_id, seq DESC);`);
  }
  schedule(digest: string): ReviewSchedule | null {
    const row = this.db.prepare('SELECT value_json FROM review_schedules WHERE revision_digest=?').get(digest) as any;
    if (!row) return null;
    try { return scheduleFrom(JSON.parse(row.value_json), digest); }
    catch { throw new ReviewStoreError('REVIEW_RECORD_CORRUPT', 503); }
  }
  events(digest: string, input: { limit?: number; cursor?: string }) {
    const { limit, before } = reviewPage(input);
    const rows = this.db.prepare('SELECT * FROM review_events WHERE revision_digest=? AND seq<? ORDER BY seq DESC LIMIT ?').all(digest, before, limit + 1) as any[];
    return { events: rows.slice(0, limit).map(eventFrom), next_cursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  }
  /** CAS, append-only event, and recipient fan-out commit in one SQLite transaction. */
  write(actor: Actor, digest: string, input: any, build: (schedule: ReviewSchedule | null) => { event: Omit<ReviewEvent, 'event_id' | 'revision_digest' | 'author' | 'created_at'>; recipients: ReviewPerson[] }): ReviewEvent {
    const requestDigest = createHash('sha256').update(canonicalize({ digest, input, actor })).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM review_events WHERE org_id=? AND actor_id=? AND operation_id=?').get(actor.org_id, actor.actor_id, input.operation_id) as any;
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new ReviewStoreError('IDEMPOTENCY_CONFLICT', 409);
        const event = eventFrom(existing); this.db.exec('COMMIT'); return event;
      }
      const { event: details, recipients } = build(this.schedule(digest));
      const event: ReviewEvent = { ...details, event_id: `review-${randomUUID()}`, revision_digest: digest,
        author: { org_id: actor.org_id, actor_id: actor.actor_id, kind: actor.kind }, created_at: new Date().toISOString() };
      const json = JSON.stringify(event); eventFrom({ value_json: json, event_id: event.event_id, revision_digest: digest, org_id: actor.org_id, actor_id: actor.actor_id });
      this.db.prepare('INSERT INTO review_events(event_id,revision_digest,org_id,actor_id,operation_id,request_digest,value_json) VALUES(?,?,?,?,?,?,?)')
        .run(event.event_id, digest, actor.org_id, actor.actor_id, input.operation_id, requestDigest, json);
      if (event.schedule) {
        this.db.prepare('INSERT INTO review_schedules VALUES(?,?) ON CONFLICT(revision_digest) DO UPDATE SET value_json=excluded.value_json').run(digest, JSON.stringify(event.schedule));
        this.db.prepare('DELETE FROM review_assignees WHERE revision_digest=?').run(digest);
        for (const assignee of event.schedule.assignees) this.db.prepare('INSERT INTO review_assignees VALUES(?,?,?,?)')
          .run(digest, assignee.org_id, assignee.actor_id, event.schedule.due_at);
      }
      for (const recipient of recipients) if (recipient.org_id !== actor.org_id || recipient.actor_id !== actor.actor_id) {
        this.db.prepare('INSERT OR IGNORE INTO review_notifications(event_id,org_id,actor_id) VALUES(?,?,?)').run(event.event_id, recipient.org_id, recipient.actor_id);
      }
      this.db.exec('COMMIT'); return event;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  notifications(actor: Actor, input: { limit?: number; cursor?: string }) {
    const { limit, before } = reviewPage(input);
    const rows = this.db.prepare(`SELECT n.seq AS notification_seq,n.read_at,e.* FROM review_notifications n
      JOIN review_events e ON e.event_id=n.event_id WHERE n.org_id=? AND n.actor_id=? AND n.seq<? ORDER BY n.seq DESC LIMIT ?`)
      .all(actor.org_id, actor.actor_id, before, limit + 1) as any[];
    const unread = this.db.prepare('SELECT COUNT(*) AS count FROM review_notifications WHERE org_id=? AND actor_id=? AND read_at IS NULL').get(actor.org_id, actor.actor_id) as any;
    return { notifications: rows.slice(0, limit).map(row => ({ event: eventFrom(row), read_at: row.read_at })), unread_count: Number(unread.count), next_cursor: rows.length > limit ? String(rows[limit - 1].notification_seq) : null };
  }
  markRead(actor: Actor, eventId: string) {
    const result = this.db.prepare('UPDATE review_notifications SET read_at=COALESCE(read_at,?) WHERE org_id=? AND actor_id=? AND event_id=?')
      .run(new Date().toISOString(), actor.org_id, actor.actor_id, eventId);
    if (result.changes !== 1) throw new ReviewStoreError('NOT_FOUND', 404);
    return { event_id: eventId, read: true };
  }
  due(actor: Actor, now: string, limit = 20) {
    reviewPage({ limit });
    const rows = this.db.prepare(`SELECT s.revision_digest,s.value_json FROM review_assignees a JOIN review_schedules s ON s.revision_digest=a.revision_digest
      WHERE a.org_id=? AND a.actor_id=? AND a.due_at IS NOT NULL AND a.due_at<=? ORDER BY a.due_at,a.revision_digest LIMIT ?`)
      .all(actor.org_id, actor.actor_id, now, limit + 1) as any[];
    return { tasks: rows.slice(0, limit).map(row => {
      let task;
      try { task = scheduleFrom(JSON.parse(row.value_json), row.revision_digest); } catch { throw new ReviewStoreError('REVIEW_RECORD_CORRUPT', 503); }
      if (!task.assignees.some(p => p.org_id === actor.org_id && p.actor_id === actor.actor_id) || !task.due_at || task.due_at > now) throw new ReviewStoreError('REVIEW_RECORD_CORRUPT', 503);
      return task;
    }), has_more: rows.length > limit };
  }
}
