import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor } from './local-ledger.ts';
import { reviewPage } from './review-store.ts';
import { DeliveryError, deliveryHash, deliveryId, samePerson, validateReviewPacket, validateReviewReceipt } from '../review/delivery-contract.ts';
import type { ReviewPacket, ReviewReceipt } from '../review/delivery-contract.ts';

export type DeliveryStatus = 'pending' | 'sending' | 'delivered' | 'blocked' | 'failed';
export interface DeliveryJob {
  packet: ReviewPacket; target_id: string; target_binding: string; status: DeliveryStatus;
  attempts: number; total_attempts: number; next_attempt_at: number; lease_token: string | null;
  last_code: string | null; receipt: ReviewReceipt | null;
}
/** Local application outbox/inbox. No entries authorize a shared ledger transition. */
export class ReviewDeliveryStore {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS review_delivery_outbox (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, delivery_id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, actor_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, request_digest TEXT NOT NULL, target_id TEXT NOT NULL, target_binding TEXT NOT NULL,
      packet_json TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, total_attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER, last_code TEXT, receipt_json TEXT,
      UNIQUE(org_id,actor_id,operation_id));
      CREATE INDEX IF NOT EXISTS review_delivery_actor ON review_delivery_outbox(org_id,actor_id,seq DESC);
      CREATE INDEX IF NOT EXISTS review_delivery_pending ON review_delivery_outbox(status,next_attempt_at,seq);
      CREATE TABLE IF NOT EXISTS review_delivery_inbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, delivery_id TEXT NOT NULL, payload_digest TEXT NOT NULL,
        org_id TEXT NOT NULL, actor_id TEXT NOT NULL, packet_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
        UNIQUE(source_id,delivery_id));
      CREATE INDEX IF NOT EXISTS review_delivery_recipient ON review_delivery_inbox(org_id,actor_id,seq DESC);`);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private job(row: any): DeliveryJob {
    try {
      const packet = validateReviewPacket(JSON.parse(row.packet_json));
      if (packet.message.delivery_id !== row.delivery_id || !samePerson(packet.message.comment.author, { org_id: row.org_id, actor_id: row.actor_id })
        || !deliveryId(row.target_id)
        || !['pending', 'sending', 'delivered', 'blocked', 'failed'].includes(row.status)
        || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !Number.isSafeInteger(row.total_attempts) || row.total_attempts < row.attempts
        || !Number.isSafeInteger(row.next_attempt_at) || row.next_attempt_at < 0 || !/^sha256:[a-f0-9]{64}$/.test(row.target_binding)
        || (row.last_code !== null && !/^[A-Z][A-Z0-9_]{1,63}$/.test(row.last_code))) throw new Error();
      if (row.status === 'sending' ? typeof row.lease_token !== 'string' || !/^[a-f0-9-]{36}$/.test(row.lease_token)
        || !Number.isSafeInteger(row.lease_until) || row.lease_until < 0 : row.lease_token !== null || row.lease_until !== null) throw new Error();
      const receipt = row.receipt_json === null ? null : validateReviewReceipt(JSON.parse(row.receipt_json), packet);
      if ((row.status === 'delivered') !== Boolean(receipt)) throw new Error();
      return { packet, target_id: row.target_id, target_binding: row.target_binding, status: row.status, attempts: row.attempts,
        total_attempts: row.total_attempts, next_attempt_at: row.next_attempt_at, lease_token: row.lease_token, last_code: row.last_code, receipt };
    } catch { throw new DeliveryError('DELIVERY_STORE_CORRUPT', 503); }
  }
  enqueue(actor: Actor, operationId: string, input: unknown, target: { id: string; binding: string }, packet: ReviewPacket, now: number): DeliveryJob {
    validateReviewPacket(packet);
    const requestDigest = deliveryHash(input);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM review_delivery_outbox WHERE org_id=? AND actor_id=? AND operation_id=?').get(actor.org_id, actor.actor_id, operationId) as any;
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new DeliveryError('IDEMPOTENCY_CONFLICT', 409);
        return this.job(existing);
      }
      this.db.prepare(`INSERT INTO review_delivery_outbox(delivery_id,org_id,actor_id,operation_id,request_digest,target_id,target_binding,packet_json,status,attempts,total_attempts,next_attempt_at)
        VALUES(?,?,?,?,?,?,?,?,'pending',0,0,?)`).run(packet.message.delivery_id, actor.org_id, actor.actor_id, operationId, requestDigest, target.id, target.binding, JSON.stringify(packet), now);
      return this.get(actor, packet.message.delivery_id);
    });
  }
  get(actor: Actor, id: string): DeliveryJob {
    const row = this.db.prepare('SELECT * FROM review_delivery_outbox WHERE delivery_id=? AND org_id=? AND actor_id=?').get(id, actor.org_id, actor.actor_id);
    if (!row) throw new DeliveryError('NOT_FOUND', 404); return this.job(row);
  }
  list(actor: Actor, input: { limit?: number; cursor?: string }) {
    const { limit, before } = reviewPage(input);
    const rows = this.db.prepare('SELECT * FROM review_delivery_outbox WHERE org_id=? AND actor_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(actor.org_id, actor.actor_id, before, limit + 1) as any[];
    return { jobs: rows.slice(0, limit).map(row => this.job(row)), next_cursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  }
  claim(now: number, leaseMs: number, maxAttempts: number, exclude: string[] = []): DeliveryJob | null {
    if (exclude.length > 20 || !exclude.every(deliveryId)) throw new TypeError('Invalid delivery batch');
    return this.transaction(() => {
      this.db.prepare(`UPDATE review_delivery_outbox SET status='failed',last_code='DELIVERY_UNCONFIRMED',lease_token=NULL,lease_until=NULL
        WHERE attempts>=? AND (status='pending' OR (status='sending' AND lease_until<=?))`).run(maxAttempts, now);
      const row = this.db.prepare(`SELECT * FROM review_delivery_outbox WHERE ((status='pending' AND next_attempt_at<=?)
        OR (status='sending' AND lease_until<=?)) ${exclude.length ? `AND delivery_id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
        ORDER BY next_attempt_at,seq LIMIT 1`).get(now, now, ...exclude) as any;
      if (!row) return null;
      this.job(row);
      const token = randomUUID();
      this.db.prepare(`UPDATE review_delivery_outbox SET status='sending',attempts=attempts+1,total_attempts=total_attempts+1,lease_token=?,lease_until=? WHERE delivery_id=?`)
        .run(token, now + leaseMs, row.delivery_id);
      return this.job({ ...row, status: 'sending', attempts: row.attempts + 1, total_attempts: row.total_attempts + 1, lease_token: token, lease_until: now + leaseMs });
    });
  }
  settle(job: DeliveryJob, status: Exclude<DeliveryStatus, 'sending'>, now: number, code: string | null, receipt: ReviewReceipt | null = null): boolean {
    if (receipt) validateReviewReceipt(receipt, job.packet);
    const result = this.db.prepare(`UPDATE review_delivery_outbox SET status=?,next_attempt_at=?,last_code=?,receipt_json=?,lease_token=NULL,lease_until=NULL
      WHERE delivery_id=? AND status='sending' AND lease_token=?`).run(status, now, code, receipt ? JSON.stringify(receipt) : null, job.packet.message.delivery_id, job.lease_token);
    return result.changes === 1;
  }
  retry(actor: Actor, id: string, now: number): DeliveryJob {
    return this.transaction(() => {
      const job = this.get(actor, id);
      if (!['failed', 'blocked'].includes(job.status)) throw new DeliveryError('DELIVERY_NOT_RETRYABLE', 409);
      this.db.prepare(`UPDATE review_delivery_outbox SET status='pending',attempts=0,next_attempt_at=?,lease_token=NULL,lease_until=NULL WHERE delivery_id=?`).run(now, id);
      return this.get(actor, id);
    });
  }
  receive(packet: ReviewPacket): ReviewReceipt {
    packet = validateReviewPacket(packet); const m = packet.message;
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM review_delivery_inbox WHERE source_id=? AND delivery_id=?').get(m.source_id, m.delivery_id) as any;
      if (row) {
        if (row.payload_digest !== packet.payload_digest) throw new DeliveryError('DELIVERY_ID_CONFLICT', 409);
        return this.received(row).receipt;
      }
      const receipt: ReviewReceipt = { schema_version: 1, delivery_id: m.delivery_id, payload_digest: packet.payload_digest, received_at: new Date().toISOString() };
      this.db.prepare('INSERT INTO review_delivery_inbox(source_id,delivery_id,payload_digest,org_id,actor_id,packet_json,receipt_json) VALUES(?,?,?,?,?,?,?)')
        .run(m.source_id, m.delivery_id, packet.payload_digest, m.recipient.org_id, m.recipient.actor_id, JSON.stringify(packet), JSON.stringify(receipt));
      return receipt;
    });
  }
  private received(row: any) {
    try {
      const packet = validateReviewPacket(JSON.parse(row.packet_json));
      if (packet.message.source_id !== row.source_id || packet.message.delivery_id !== row.delivery_id || packet.payload_digest !== row.payload_digest
        || !samePerson(packet.message.recipient, { org_id: row.org_id, actor_id: row.actor_id })) throw new Error();
      return { packet, receipt: validateReviewReceipt(JSON.parse(row.receipt_json), packet) };
    } catch { throw new DeliveryError('DELIVERY_STORE_CORRUPT', 503); }
  }
  inbox(actor: Actor, input: { limit?: number; cursor?: string }) {
    const { limit, before } = reviewPage(input);
    const rows = this.db.prepare('SELECT * FROM review_delivery_inbox WHERE org_id=? AND actor_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(actor.org_id, actor.actor_id, before, limit + 1) as any[];
    return { deliveries: rows.slice(0, limit).map(row => this.received(row)), next_cursor: rows.length > limit ? String(rows[limit - 1].seq) : null };
  }
}
