import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../domain/index.ts';
import { DeliveryError, deliveryHash, deliveryId } from '../review/delivery-contract.ts';
import { reviewPage } from './review-store.ts';
import { slackAcceptance } from '../review/slack.ts';
import type { SlackAcceptance, SlackResult } from '../review/slack.ts';

export interface SlackNotice {
  reminder_id: string; binding: string; status: 'sending' | 'provider_accepted' | 'retry_wait' | 'blocked' | 'unknown' | 'failed' | 'user_confirmed' | 'dismissed';
  attempts: number; next_attempt_at: number; lease_token: string | null; lease_until: number | null;
  last_code: string | null; receipt: SlackAcceptance | null;
  version: number; total_attempts: number;
}
export interface SlackResolution { operation_id: string; expected_version: number; outcome: 'seen' | 'retry' | 'dismiss'; confirm: true; confirm_duplicate_risk?: true }
export function validateSlackResolution(input: any): SlackResolution {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['operation_id', 'expected_version', 'outcome', 'confirm', 'confirm_duplicate_risk'].includes(key))
    || !deliveryId(input.operation_id) || !Number.isSafeInteger(input.expected_version) || input.expected_version < 1
    || !['seen', 'retry', 'dismiss'].includes(input.outcome) || input.confirm !== true
    || (input.outcome === 'retry' ? input.confirm_duplicate_risk !== true : input.confirm_duplicate_risk !== undefined)) throw new DeliveryError('SLACK_CONFIRMATION_REQUIRED');
  return structuredClone(input);
}
const validTime = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 253402300799999;
/** Separate from peer delivery receipts. Expired in-flight attempts are never automatically sent again. */
export class SlackNoticeStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS slack_notices (
      reminder_id TEXT PRIMARY KEY, org_id TEXT NOT NULL, actor_id TEXT NOT NULL, binding TEXT NOT NULL,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL,
      lease_token TEXT, lease_until INTEGER, last_code TEXT, receipt_json TEXT);
      CREATE TABLE IF NOT EXISTS slack_notice_limits (scope TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slack_notice_resolutions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, actor_id TEXT NOT NULL, reminder_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL,
        result_json TEXT NOT NULL, UNIQUE(org_id,actor_id,operation_id));
      CREATE INDEX IF NOT EXISTS slack_resolution_notice ON slack_notice_resolutions(org_id,actor_id,reminder_id,seq);`);
    this.transaction(() => {
      const columns = new Set((db.prepare('PRAGMA table_info(slack_notices)').all() as any[]).map(row => row.name));
      if (!columns.has('version')) db.exec('ALTER TABLE slack_notices ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
      if (!columns.has('total_attempts')) { db.exec('ALTER TABLE slack_notices ADD COLUMN total_attempts INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE slack_notices SET total_attempts=attempts'); }
    });
  }
  private decode(row: any): SlackNotice {
    try {
      if (!deliveryId(row.reminder_id) || !/^sha256:[a-f0-9]{64}$/.test(row.binding)
        || !['sending', 'provider_accepted', 'retry_wait', 'blocked', 'unknown', 'failed', 'user_confirmed', 'dismissed'].includes(row.status)
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > 3 || !validTime(row.next_attempt_at)
        || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.total_attempts) || row.total_attempts < row.attempts
        || (row.attempts === 0 && !['retry_wait', 'user_confirmed', 'dismissed'].includes(row.status))
        || (row.last_code !== null && !/^SLACK_[A-Z_]{1,50}$/.test(row.last_code))) throw new Error();
      if (row.status === 'sending' ? !/^[a-f0-9-]{36}$/.test(row.lease_token) || !validTime(row.lease_until) : row.lease_token !== null || row.lease_until !== null) throw new Error();
      const receipt = row.receipt_json === null ? null : slackAcceptance(JSON.parse(row.receipt_json));
      if ((row.status === 'provider_accepted') !== Boolean(receipt)) throw new Error();
      return { reminder_id: row.reminder_id, binding: row.binding, status: row.status, attempts: row.attempts,
        next_attempt_at: row.next_attempt_at, lease_token: row.lease_token, lease_until: row.lease_until, last_code: row.last_code, receipt, version: row.version, total_attempts: row.total_attempts };
    } catch { throw new Error('SLACK_STORE_CORRUPT'); }
  }
  get(actor: Actor, id: string): SlackNotice | null {
    const row = this.db.prepare('SELECT * FROM slack_notices WHERE org_id=? AND actor_id=? AND reminder_id=?').get(actor.org_id, actor.actor_id, id);
    return row ? this.decode(row) : null;
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE'); try { const result = work(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private limit(scope: string): number {
    const row: any = this.db.prepare('SELECT until_ms FROM slack_notice_limits WHERE scope=?').get(scope);
    if (row && !validTime(row.until_ms)) throw new Error('SLACK_STORE_CORRUPT'); return row?.until_ms ?? 0;
  }
  private defer(scope: string, until: number) {
    this.db.prepare('INSERT INTO slack_notice_limits VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)').run(scope, until);
  }
  claim(actor: Actor, id: string, binding: string, team: string, dm: string, now: number, leaseMs: number): SlackNotice | null {
    if (!deliveryId(id) || !/^sha256:[a-f0-9]{64}$/.test(binding) || !validTime(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 60000) throw new TypeError('Invalid Slack claim');
    return this.transaction(() => {
      const existing = this.get(actor, id);
      if (existing) {
        if (existing.status === 'sending' && existing.lease_until! <= now) {
          this.db.prepare("UPDATE slack_notices SET status='unknown',lease_token=NULL,lease_until=NULL,last_code='SLACK_RESULT_UNKNOWN',version=version+1 WHERE reminder_id=?").run(id); return null;
        }
        if (existing.binding !== binding || existing.status !== 'retry_wait' || existing.next_attempt_at > now || existing.attempts >= 3) return null;
      }
      if (this.limit(`team:${team}`) > now || this.limit(`dm:${team}:${dm}`) > now) return null;
      const token = randomUUID();
      if (existing) this.db.prepare("UPDATE slack_notices SET status='sending',attempts=attempts+1,total_attempts=total_attempts+1,version=version+1,lease_token=?,lease_until=?,last_code=NULL WHERE reminder_id=?").run(token, now + leaseMs, id);
      else this.db.prepare("INSERT INTO slack_notices(reminder_id,org_id,actor_id,binding,status,attempts,next_attempt_at,lease_token,lease_until,last_code,receipt_json,version,total_attempts) VALUES(?,?,?,?,'sending',1,?,?,?,NULL,NULL,1,1)").run(id, actor.org_id, actor.actor_id, binding, now, token, now + leaseMs);
      this.defer(`dm:${team}:${dm}`, now + leaseMs + 1000); return this.get(actor, id);
    });
  }
  owns(actor: Actor, notice: SlackNotice, now: number): boolean {
    const current = this.get(actor, notice.reminder_id);
    return current?.status === 'sending' && current.lease_token === notice.lease_token && current.lease_until! > now;
  }
  settle(actor: Actor, job: SlackNotice, team: string, dm: string, result: SlackResult, now: number): void {
    if (!validTime(now)) throw new TypeError('Invalid Slack result time');
    this.transaction(() => {
      const current = this.get(actor, job.reminder_id);
      if (current?.status !== 'sending' || current.lease_token !== job.lease_token) return;
      let status: SlackNotice['status'] = result.status;
      const retry = result.status === 'retry_wait' ? result.retry_after_ms ?? 1000 : 0;
      if (!Number.isSafeInteger(retry) || retry < 0 || retry > 86400000) throw new TypeError('Invalid Slack retry');
      if (status === 'retry_wait' && current.attempts >= 3) status = 'failed';
      const receipt = result.status === 'provider_accepted' ? slackAcceptance(result.receipt) : null;
      const code = result.status === 'provider_accepted' ? null : result.code;
      this.db.prepare('UPDATE slack_notices SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_code=?,receipt_json=?,version=version+1 WHERE reminder_id=?')
        .run(status, now + retry, code, receipt ? JSON.stringify(receipt) : null, job.reminder_id);
      if (code === 'SLACK_RATE_LIMITED') this.defer(`team:${team}`, now + retry);
      this.db.prepare('UPDATE slack_notice_limits SET until_ms=? WHERE scope=? AND until_ms=?')
        .run(now + 1000, `dm:${team}:${dm}`, job.lease_until! + 1000);
    });
  }
  list(actor: Actor, input: { limit?: number; cursor?: string }) {
    const { limit, before } = reviewPage(input);
    const rows = this.db.prepare('SELECT rowid AS seq,* FROM slack_notices WHERE org_id=? AND actor_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?')
      .all(actor.org_id, actor.actor_id, before, limit + 1) as any[];
    return { notices: rows.slice(0, limit).map(row => this.decode(row)), next_cursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  }
  history(actor: Actor, id: string) {
    const rows = this.db.prepare('SELECT operation_id,outcome,created_at FROM slack_notice_resolutions WHERE org_id=? AND actor_id=? AND reminder_id=? ORDER BY seq DESC LIMIT 20')
      .all(actor.org_id, actor.actor_id, id) as any[];
    if (rows.some(row => !deliveryId(row.operation_id) || !['seen', 'retry', 'dismiss'].includes(row.outcome) || !validTime(row.created_at))) throw new Error('SLACK_STORE_CORRUPT');
    return rows.map(row => ({ ...row, created_at: new Date(row.created_at).toISOString() }));
  }
  resolutionReplay(actor: Actor, id: string, input: SlackResolution): SlackNotice | null {
    const row: any = this.db.prepare('SELECT request_digest,result_json FROM slack_notice_resolutions WHERE org_id=? AND actor_id=? AND operation_id=?').get(actor.org_id, actor.actor_id, input.operation_id);
    if (!row) return null;
    if (row.request_digest !== deliveryHash({ id, input })) throw new DeliveryError('IDEMPOTENCY_CONFLICT', 409);
    try { const value = JSON.parse(row.result_json); return this.decode({ ...value, receipt_json: value.receipt ? JSON.stringify(value.receipt) : null }); }
    catch { throw new Error('SLACK_STORE_CORRUPT'); }
  }
  resolve(actor: Actor, id: string, binding: string | null, input: SlackResolution, eligible: () => boolean, now: number): SlackNotice {
    validateSlackResolution(input); if (!deliveryId(id) || !validTime(now)) throw new DeliveryError('INVALID_INPUT');
    return this.transaction(() => {
      const replay = this.resolutionReplay(actor, id, input); if (replay) return replay;
      const current = this.get(actor, id); if (!current) throw new DeliveryError('NOT_FOUND', 404);
      const status = current.status === 'sending' && current.lease_until! <= now ? 'unknown'
        : binding !== current.binding && current.status === 'retry_wait' ? 'blocked' : current.status;
      if (current.version !== input.expected_version || !['unknown', 'blocked', 'failed'].includes(status)) throw new DeliveryError('SLACK_STATE_CHANGED', 409);
      if (input.outcome === 'retry' && (binding !== current.binding || !eligible())) throw new DeliveryError('SLACK_RETRY_NOT_ALLOWED', 409);
      const next = input.outcome === 'seen' ? 'user_confirmed' : input.outcome === 'dismiss' ? 'dismissed' : 'retry_wait';
      this.db.prepare(`UPDATE slack_notices SET status=?,attempts=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,
        last_code=?,version=version+1 WHERE reminder_id=?`).run(next, input.outcome === 'retry' ? 0 : current.attempts, now,
          input.outcome === 'retry' ? 'SLACK_MANUAL_RETRY' : 'SLACK_USER_RESOLUTION', id);
      const result = this.get(actor, id)!;
      this.db.prepare('INSERT INTO slack_notice_resolutions(org_id,actor_id,reminder_id,operation_id,request_digest,outcome,created_at,result_json) VALUES(?,?,?,?,?,?,?,?)')
        .run(actor.org_id, actor.actor_id, id, input.operation_id, deliveryHash({ id, input }), input.outcome, now, JSON.stringify(result));
      return result;
    });
  }
}
