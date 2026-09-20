import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from '../domain/index.ts';
import { deliveryId } from '../review/delivery-contract.ts';
import { slackAcceptance } from '../review/slack.ts';
import type { SlackAcceptance, SlackResult } from '../review/slack.ts';

export interface SlackNotice {
  reminder_id: string; binding: string; status: 'sending' | 'provider_accepted' | 'retry_wait' | 'blocked' | 'unknown' | 'failed';
  attempts: number; next_attempt_at: number; lease_token: string | null; lease_until: number | null;
  last_code: string | null; receipt: SlackAcceptance | null;
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
      CREATE TABLE IF NOT EXISTS slack_notice_limits (scope TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);`);
  }
  private decode(row: any): SlackNotice {
    try {
      if (!deliveryId(row.reminder_id) || !/^sha256:[a-f0-9]{64}$/.test(row.binding)
        || !['sending', 'provider_accepted', 'retry_wait', 'blocked', 'unknown', 'failed'].includes(row.status)
        || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 3 || !validTime(row.next_attempt_at)
        || (row.last_code !== null && !/^SLACK_[A-Z_]{1,50}$/.test(row.last_code))) throw new Error();
      if (row.status === 'sending' ? !/^[a-f0-9-]{36}$/.test(row.lease_token) || !validTime(row.lease_until) : row.lease_token !== null || row.lease_until !== null) throw new Error();
      const receipt = row.receipt_json === null ? null : slackAcceptance(JSON.parse(row.receipt_json));
      if ((row.status === 'provider_accepted') !== Boolean(receipt)) throw new Error();
      return { reminder_id: row.reminder_id, binding: row.binding, status: row.status, attempts: row.attempts,
        next_attempt_at: row.next_attempt_at, lease_token: row.lease_token, lease_until: row.lease_until, last_code: row.last_code, receipt };
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
          this.db.prepare("UPDATE slack_notices SET status='unknown',lease_token=NULL,lease_until=NULL,last_code='SLACK_RESULT_UNKNOWN' WHERE reminder_id=?").run(id); return null;
        }
        if (existing.binding !== binding || existing.status !== 'retry_wait' || existing.next_attempt_at > now || existing.attempts >= 3) return null;
      }
      if (this.limit(`team:${team}`) > now || this.limit(`dm:${team}:${dm}`) > now) return null;
      const token = randomUUID();
      if (existing) this.db.prepare("UPDATE slack_notices SET status='sending',attempts=attempts+1,lease_token=?,lease_until=?,last_code=NULL WHERE reminder_id=?").run(token, now + leaseMs, id);
      else this.db.prepare("INSERT INTO slack_notices VALUES(?,?,?,?,'sending',1,?,?,?,NULL,NULL)").run(id, actor.org_id, actor.actor_id, binding, now, token, now + leaseMs);
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
      this.db.prepare('UPDATE slack_notices SET status=?,next_attempt_at=?,lease_token=NULL,lease_until=NULL,last_code=?,receipt_json=? WHERE reminder_id=?')
        .run(status, now + retry, code, receipt ? JSON.stringify(receipt) : null, job.reminder_id);
      if (code === 'SLACK_RATE_LIMITED') this.defer(`team:${team}`, now + retry);
      this.db.prepare('UPDATE slack_notice_limits SET until_ms=? WHERE scope=? AND until_ms=?')
        .run(now + 1000, `dm:${team}:${dm}`, job.lease_until! + 1000);
    });
  }
}
