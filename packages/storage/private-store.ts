import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Actor } from './local-ledger.ts';

/** Local-only records. This database is never consumed by the shared ledger projector. */
export class PrivateStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS private_records (
        kind TEXT NOT NULL, record_id TEXT NOT NULL, org_id TEXT NOT NULL,
        actor_id TEXT NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY(kind, record_id, org_id, actor_id)
      );`);
  }
  put(kind: 'draft' | 'preview' | 'run' | 'command', id: string, actor: Actor, value: any): void {
    this.db.prepare('INSERT INTO private_records VALUES (?, ?, ?, ?, ?)').run(kind, id, actor.org_id, actor.actor_id, JSON.stringify(value));
  }
  get(kind: 'draft' | 'preview' | 'run' | 'command', id: string, actor: Actor): any | undefined {
    const row = this.db.prepare('SELECT value_json FROM private_records WHERE kind = ? AND record_id = ? AND org_id = ? AND actor_id = ?').get(kind, id, actor.org_id, actor.actor_id) as any;
    return row ? JSON.parse(row.value_json) : undefined;
  }
  close(): void { this.db.close(); }
}
