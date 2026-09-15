import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DurableOutbox, OutboxAttempt, OutboxAttemptStatus } from "./types.ts";

type Row = {
  command_id: string;
  actor_org_id: string;
  payload_digest: string;
  tx_id: string;
  status: OutboxAttemptStatus;
  detail: string | null;
  commit_bytes: Uint8Array | null;
};

/** Durable transaction attempts for restart-safe Gateway reconciliation. */
export class SqliteOutbox implements DurableOutbox {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS fabric_outbox_attempts (
        tx_id TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        actor_org_id TEXT NOT NULL,
        payload_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT,
        commit_bytes BLOB,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS fabric_outbox_recovery_idx
        ON fabric_outbox_attempts(status, updated_at);
    `);
  }

  async recordAttempt(attempt: OutboxAttempt): Promise<void> {
    this.db.prepare(`
      INSERT INTO fabric_outbox_attempts
        (tx_id, command_id, actor_org_id, payload_digest, status, detail, commit_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(attempt.tx_id, attempt.command_id, attempt.actor_org_id, attempt.payload_digest, attempt.status, attempt.detail ?? null, attempt.commit_bytes ?? null, Date.now());
  }

  async updateAttempt(tx_id: string, update: Pick<OutboxAttempt, "status"> & Partial<Pick<OutboxAttempt, "detail" | "commit_bytes">>): Promise<void> {
    const result = this.db.prepare(`
      UPDATE fabric_outbox_attempts
      SET status = ?, detail = ?, commit_bytes = COALESCE(?, commit_bytes), updated_at = ?
      WHERE tx_id = ?
    `).run(update.status, update.detail ?? null, update.commit_bytes ?? null, Date.now(), tx_id);
    if (result.changes !== 1) throw new Error('Outbox attempt is missing');
  }

  async listRecoverable(): Promise<OutboxAttempt[]> {
    const rows = this.db.prepare(`
      SELECT command_id, actor_org_id, payload_digest, tx_id, status, detail, commit_bytes
      FROM fabric_outbox_attempts
      WHERE status IN ('pending', 'endorsed', 'acknowledged', 'unknown')
      ORDER BY updated_at, tx_id
    `).all() as unknown as Row[];
    return rows.map((row) => ({
      command_id: row.command_id,
      actor_org_id: row.actor_org_id,
      payload_digest: row.payload_digest,
      tx_id: row.tx_id,
      status: row.status,
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.commit_bytes === null ? {} : { commit_bytes: new Uint8Array(row.commit_bytes) }),
    }));
  }

  close(): void { this.db.close(); }
}
