import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateStateWrite as validateWrite, validateStateLinks, IMMUTABLE_KINDS } from './state-validation.ts';
import { canonicalize, execute, bootstrap } from '../domain/index.ts';
import type { DomainCommand } from '../domain/index.ts';

export interface Checkpoint {
  channel_id: string;
  block_number: number;
  transaction_index: number;
  transaction_id: string;
  block_hash: string;
}
export interface Actor { org_id: string; actor_id: string; kind: 'human' | 'agent' }
export interface TransactionContext {
  actor: Actor;
  channel_id: string;
  tx_id: string;
  timestamp: string;
  get(key: string): Promise<any | undefined>;
  put(key: string, value: any): Promise<void>;
}
export interface LedgerEvent {
  checkpoint: Checkpoint;
  previous_hash: string;
  timestamp: string;
  validation_code: 'VALID';
  reducer_version: 1;
  writes: [string, any][];
}

const ZERO_HASH = '0'.repeat(64);

function hashRecord(record: Omit<LedgerEvent, 'checkpoint'> & { checkpoint: Omit<Checkpoint, 'block_hash'> }): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex');
}

/** A development-only, single-writer append-only journal. This is not a distributed ledger. */
export class LocalLedger {
  readonly channelId: string;
  readonly mode = 'local-simulation' as const;
  private db: DatabaseSync;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(path: string, channelId: string) {
    this.channelId = channelId;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS ledger_transactions (
        sequence INTEGER PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection (
        state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_history (
        state_key TEXT NOT NULL, sequence INTEGER NOT NULL, value_json TEXT NOT NULL,
        PRIMARY KEY (state_key, sequence)
      );
      CREATE TABLE IF NOT EXISTS projection_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );
    `);
    const stored = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get('channel_id') as any;
    if (stored && stored.value !== channelId) { this.db.close(); throw new Error('Ledger channel mismatch'); }
    this.db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('channel_id', channelId);
    try { this.validateHistory(); this.rebuildProjection(); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }

  async refresh(): Promise<void> { /* This process owns the local journal. */ }
  execute(actor: Actor, command: DomainCommand) { return this.transact(actor, ctx => execute(ctx, command)); }
  bootstrap(actor: Actor, config: unknown) { return this.transact(actor, ctx => bootstrap(ctx, config)); }

  read(key: string, at?: Checkpoint | null): any | undefined {
    let row: any;
    if (at) {
      this.assertCheckpoint(at);
      row = this.db.prepare('SELECT value_json FROM projection_history WHERE state_key = ? AND sequence <= ? ORDER BY sequence DESC LIMIT 1').get(key, at.block_number);
    } else {
      row = this.db.prepare('SELECT value_json FROM projection WHERE state_key = ?').get(key);
      const history = this.db.prepare('SELECT value_json FROM projection_history WHERE state_key = ? ORDER BY sequence DESC LIMIT 1').get(key) as any;
      if (row?.value_json !== history?.value_json) throw new Error('Projection integrity check failed; rebuild the derived view');
    }
    if (!row) return undefined;
    const value = JSON.parse(row.value_json);
    validateWrite(key, value);
    return value;
  }

  entries(prefix: string, at?: Checkpoint | null): [string, any][] {
    if (at) this.assertCheckpoint(at);
    const rows = at
      ? this.db.prepare(`SELECT h.state_key, h.value_json FROM projection_history h JOIN
          (SELECT state_key, MAX(sequence) sequence FROM projection_history WHERE sequence <= ? GROUP BY state_key) latest
          ON h.state_key = latest.state_key AND h.sequence = latest.sequence ORDER BY h.state_key`).all(at.block_number)
      : this.db.prepare('SELECT state_key, value_json FROM projection ORDER BY state_key').all();
    return (rows as any[]).filter(row => row.state_key.startsWith(prefix)).map(row => [row.state_key, this.read(row.state_key, at)]);
  }

  checkpoint(): Checkpoint | null {
    const row = this.db.prepare('SELECT record_json FROM ledger_transactions ORDER BY sequence DESC LIMIT 1').get() as any;
    return row ? JSON.parse(row.record_json).checkpoint : null;
  }

  checkpointForTransaction(transactionId: string): Checkpoint {
    const row = this.db.prepare('SELECT record_json FROM ledger_transactions WHERE transaction_id = ?').get(transactionId) as any;
    if (!row) throw new Error('Committed transaction checkpoint is missing');
    const checkpoint = JSON.parse(row.record_json).checkpoint;
    this.assertCheckpoint(checkpoint);
    return checkpoint;
  }

  checkpointForStateCreation(key: string): Checkpoint {
    const row = this.db.prepare('SELECT t.record_json FROM projection_history h JOIN ledger_transactions t ON t.sequence = h.sequence WHERE h.state_key = ? ORDER BY h.sequence LIMIT 1').get(key) as any;
    if (!row) throw new Error('State creation checkpoint is missing');
    return JSON.parse(row.record_json).checkpoint;
  }

  assertCheckpoint(at: Checkpoint): void {
    if (at.channel_id !== this.channelId || at.transaction_index !== 0 || !Number.isSafeInteger(at.block_number)) throw new Error('Invalid checkpoint');
    const row = this.db.prepare('SELECT record_json FROM ledger_transactions WHERE sequence = ?').get(at.block_number) as any;
    if (!row) throw new Error('Checkpoint is ahead of projection');
    const known = JSON.parse(row.record_json).checkpoint;
    if (known.transaction_id !== at.transaction_id || known.block_hash !== at.block_hash) throw new Error('Untrusted checkpoint');
    const cursor = this.db.prepare('SELECT sequence FROM projection_cursor WHERE singleton = 1').get() as any;
    if (!cursor || cursor.sequence < at.block_number) throw new Error('Checkpoint is ahead of projection');
  }

  events(after = 0, limit = 100): LedgerEvent[] {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid event range');
    return (this.db.prepare('SELECT record_json FROM ledger_transactions WHERE sequence > ? ORDER BY sequence LIMIT ?').all(after, limit) as any[]).map(row => JSON.parse(row.record_json));
  }

  transact<T>(actor: Actor, handler: (ctx: TransactionContext) => Promise<T>): Promise<{ result: T; checkpoint: Checkpoint; status: 'committed' }> {
    const operation = this.queue.then(async () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const previous = this.checkpoint();
        const timestamp = new Date().toISOString();
        const txId = createHash('sha256').update(`local:${randomUUID()}`).digest('hex');
        const writes = new Map<string, any>();
        const ctx: TransactionContext = {
          actor, channel_id: this.channelId, tx_id: txId, timestamp,
          get: async key => writes.has(key) ? structuredClone(writes.get(key)) : this.read(key),
          put: async (key, value) => { validateWrite(key, value); writes.set(key, structuredClone(value)); },
        };
        const result = await handler(ctx);
        if (!writes.size && previous) { this.db.exec('COMMIT'); return { result, checkpoint: previous, status: 'committed' as const }; }
        const sequence = (previous?.block_number ?? 0) + 1;
        const unsigned = {
          checkpoint: { channel_id: this.channelId, block_number: sequence, transaction_index: 0, transaction_id: txId },
          previous_hash: previous?.block_hash ?? ZERO_HASH,
          timestamp, validation_code: 'VALID' as const, reducer_version: 1 as const,
          writes: [...writes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
        };
        const event: LedgerEvent = { ...unsigned, checkpoint: { ...unsigned.checkpoint, block_hash: hashRecord(unsigned) } };
        this.db.prepare('INSERT INTO ledger_transactions VALUES (?, ?, ?)').run(sequence, txId, JSON.stringify(event));
        this.apply(event);
        this.db.exec('COMMIT');
        return { result, checkpoint: event.checkpoint, status: 'committed' as const };
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  validateHistory(): void {
    let previousHash = ZERO_HASH;
    let expectedSequence = 1;
    for (const row of this.db.prepare('SELECT sequence, record_json FROM ledger_transactions ORDER BY sequence').iterate() as Iterable<any>) {
      const event: LedgerEvent = JSON.parse(row.record_json);
      const { block_hash, ...checkpoint } = event.checkpoint;
      const unsigned = { checkpoint, previous_hash: event.previous_hash, timestamp: event.timestamp, validation_code: event.validation_code, reducer_version: event.reducer_version, writes: event.writes };
      if (row.sequence !== expectedSequence || checkpoint.block_number !== expectedSequence || checkpoint.transaction_index !== 0 || checkpoint.channel_id !== this.channelId || event.previous_hash !== previousHash || hashRecord(unsigned) !== block_hash || event.reducer_version !== 1 || event.validation_code !== 'VALID') {
        throw new Error('Local journal integrity check failed; projection halted');
      }
      for (const [key, value] of event.writes) validateWrite(key, value);
      previousHash = block_hash;
      expectedSequence++;
    }
  }

  /** Rebuild only derived tables from the journal; no ledger transaction is changed. */
  rebuildProjection(): void {
    this.validateHistory();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM projection; DELETE FROM projection_history; DELETE FROM projection_cursor;');
      for (const row of this.db.prepare('SELECT record_json FROM ledger_transactions ORDER BY sequence').iterate() as Iterable<any>) this.apply(JSON.parse(row.record_json));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  private apply(event: LedgerEvent): void {
    if (event.reducer_version !== 1) throw new Error('Unknown write-set reducer');
    for (const [key, value] of event.writes) {
      validateWrite(key, value);
      const prior = this.read(key);
      if (prior !== undefined && IMMUTABLE_KINDS.has(key.split(':')[2]) && canonicalize(prior) !== canonicalize(value)) throw new Error('Immutable ledger write-set was overwritten; projection halted');
      const encoded = JSON.stringify(value);
      this.db.prepare('INSERT INTO projection VALUES (?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json').run(key, encoded);
      this.db.prepare('INSERT INTO projection_history VALUES (?, ?, ?)').run(key, event.checkpoint.block_number, encoded);
    }
    for (const [key, value] of event.writes) validateStateLinks(key, value, referenced => this.read(referenced));
    this.db.prepare('INSERT INTO projection_cursor VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET sequence = excluded.sequence').run(event.checkpoint.block_number);
  }
}
