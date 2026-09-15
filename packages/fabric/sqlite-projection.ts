import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { common } from "@hyperledger/fabric-protos";
import {
  FabricBlockProjector,
  fabricBlockHeaderHash,
  type FabricBlockProjectorOptions,
  type ProjectBlockResult,
  type ProjectedTransaction,
  type ProjectorCheckpoint,
} from "./block-projector.ts";
import { sha256Digest } from "./canonical.ts";
import type { Checkpoint, LedgerEvent } from "../storage/local-ledger.ts";

const SCHEMA_VERSION = 1;

type BlockRow = {
  block_number: number;
  block_hash: string;
  data_hash: string;
  previous_hash: string;
  raw_digest: string;
  bytes: Uint8Array;
};

type HistoryEntry = { block_number: number; transaction_index: number; transaction_id: string; block_hash: string; value: unknown };

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Stored Fabric block is not bytes");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function decodeBlock(value: Uint8Array): common.Block {
  try { return common.Block.deserializeBinary(value); }
  catch { throw new Error("Malformed Fabric block"); }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function rawDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function checkpointFromRow(row: { channel_id: string; block_number: number; transaction_index: number; transaction_id: string; block_hash: string }): Checkpoint {
  return {
    channel_id: row.channel_id,
    block_number: row.block_number,
    transaction_index: row.transaction_index,
    transaction_id: row.transaction_id,
    block_hash: row.block_hash,
  };
}

/**
 * A single-writer durable projection for peer-delivered Fabric blocks.
 *
 * Raw blocks are the journal. On open, every raw block is replayed through
 * FabricBlockProjector. The state/history/cursor tables are derived views and
 * are rebuilt from that replay in one SQL transaction, so a damaged derived
 * view is recoverable while a damaged or forged raw journal stops startup.
 */
export class SqliteFabricProjection {
  readonly channelId: string;
  private readonly db: DatabaseSync;
  private readonly options: FabricBlockProjectorOptions;
  private projector!: FabricBlockProjector;
  private results = new Map<number, ProjectBlockResult>();
  private blocks: BlockRow[] = [];
  private history = new Map<string, HistoryEntry[]>();
  private closed = false;

  constructor(path: string, options: FabricBlockProjectorOptions) {
    this.options = options;
    this.channelId = options.channel_id;
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        PRAGMA busy_timeout = 5000;
        CREATE TABLE IF NOT EXISTS fabric_projection_binding (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          schema_version INTEGER NOT NULL,
          channel_id TEXT NOT NULL,
          chaincode_name TEXT NOT NULL,
          chaincode_version TEXT NOT NULL,
          genesis_digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fabric_raw_blocks (
          block_number INTEGER PRIMARY KEY,
          block_hash TEXT NOT NULL UNIQUE,
          data_hash TEXT NOT NULL,
          previous_hash TEXT NOT NULL,
          raw_digest TEXT NOT NULL,
          block_bytes BLOB NOT NULL,
          result_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fabric_raw_transactions (
          block_number INTEGER NOT NULL,
          transaction_index INTEGER NOT NULL,
          transaction_id TEXT NOT NULL,
          validation_code INTEGER NOT NULL,
          valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
          timestamp TEXT NOT NULL,
          writes_json TEXT NOT NULL,
          PRIMARY KEY (block_number, transaction_index),
          FOREIGN KEY (block_number) REFERENCES fabric_raw_blocks(block_number)
        );
        CREATE INDEX IF NOT EXISTS fabric_raw_tx_id ON fabric_raw_transactions(transaction_id, valid, block_number, transaction_index);
        CREATE TABLE IF NOT EXISTS fabric_projection_state (
          state_key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fabric_projection_history (
          state_key TEXT NOT NULL,
          block_number INTEGER NOT NULL,
          transaction_index INTEGER NOT NULL,
          transaction_id TEXT NOT NULL,
          block_hash TEXT NOT NULL,
          value_json TEXT NOT NULL,
          PRIMARY KEY (state_key, block_number, transaction_index)
        );
        CREATE TABLE IF NOT EXISTS fabric_projection_cursor (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          block_number INTEGER NOT NULL,
          block_hash TEXT NOT NULL,
          data_hash TEXT NOT NULL
        );
      `);
      this.ensureBinding();
      const blocks = this.loadBlocks();
      const replayed = this.replay(blocks);
      this.projector = replayed.projector;
      this.results = replayed.results;
      this.blocks = blocks;
      this.history = this.buildHistory(replayed.results, blocks);
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.rebuildDerived(blocks, replayed.results);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  /** The last complete block cursor, or null before the first block. */
  blockCheckpoint(): ProjectorCheckpoint | null {
    this.ensureOpen();
    const expected = this.projector.checkpoint();
    const row = this.db.prepare("SELECT block_number, block_hash, data_hash FROM fabric_projection_cursor WHERE singleton = 1").get() as any;
    if (!expected) {
      if (row) throw new Error("Fabric projection cursor is ahead of verified journal");
      return null;
    }
    if (!row || row.block_number !== expected.block_number || row.block_hash !== expected.block_hash || row.data_hash !== expected.data_hash) throw new Error("Fabric projection cursor integrity check failed");
    return { ...expected };
  }

  applyBlock(serialized: Uint8Array): ProjectBlockResult {
    this.ensureOpen();
    this.verifyCurrentCursor();
    const incoming = new Uint8Array(serialized);
    const decoded = decodeBlock(incoming);
    const header = decoded.getHeader();
    if (!header) throw new Error("Fabric block header is required");
    const blockNumber = header.getNumber();
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) throw new Error("Fabric block number is outside the supported range");
    const existing = this.blocks.find(block => block.block_number === blockNumber);
    if (existing) {
      if (!sameBytes(incoming, existing.bytes)) throw new Error("A different Fabric block occupies this block number");
      const result = this.results.get(blockNumber);
      if (!result) throw new Error("Verified Fabric block result is missing");
      return clone(result);
    }
    const block: BlockRow = {
      block_number: blockNumber,
      block_hash: fabricBlockHeaderHash(header),
      data_hash: Buffer.from(header.getDataHash_asU8()).toString("hex"),
      previous_hash: Buffer.from(header.getPreviousHash_asU8()).toString("hex"),
      raw_digest: rawDigest(incoming),
      bytes: incoming,
    };
    const candidate = this.projector.fork();
    const result = candidate.applyBlock(incoming);
    if (result.checkpoint.block_number !== blockNumber || result.checkpoint.block_hash !== block.block_hash || result.checkpoint.data_hash !== block.data_hash) throw new Error("Fabric candidate result does not match block header");

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO fabric_raw_blocks
        (block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(block.block_number, block.block_hash, result.checkpoint.data_hash, block.previous_hash, block.raw_digest, Buffer.from(block.bytes), json(result));
      this.insertTransactions(block.block_number, result);
      this.appendDerived(block, result);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.projector = candidate;
    this.results.set(blockNumber, result);
    this.blocks.push(block);
    for (const tx of result.transactions) {
      if (!tx.valid) continue;
      for (const write of tx.writeset) {
        const entries = this.history.get(write.key) ?? [];
        entries.push({ block_number: blockNumber, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash, value: clone(write.value) });
        this.history.set(write.key, entries);
      }
    }
    return clone(result);
  }

  read(key: string, at?: Checkpoint | null): unknown | undefined {
    this.ensureOpen();
    if (at === undefined || at === null) this.verifyCurrentCursor();
    if (at !== undefined && at !== null) this.assertCheckpoint(at);
    const expected = at ? this.historyValue(key, at) : this.projector.read(key);
    const row = at
      ? this.db.prepare(`SELECT value_json FROM fabric_projection_history
          WHERE state_key = ? AND (block_number < ? OR (block_number = ? AND transaction_index <= ?))
          ORDER BY block_number DESC, transaction_index DESC LIMIT 1`).get(key, at.block_number, at.block_number, at.transaction_index)
      : this.db.prepare("SELECT value_json FROM fabric_projection_state WHERE state_key = ?").get(key);
    const actual = row ? JSON.parse((row as any).value_json) : undefined;
    if (!sameJson(actual, expected)) throw new Error("Fabric projection integrity check failed; rebuild the derived view");
    return expected === undefined ? undefined : clone(expected);
  }

  entries(prefix = "", at?: Checkpoint | null): [string, unknown][] {
    this.ensureOpen();
    if (at === undefined || at === null) this.verifyCurrentCursor();
    if (at !== undefined && at !== null) this.assertCheckpoint(at);
    const expectedKeys = at
      ? [...this.history.keys()].filter(key => this.historyValue(key, at) !== undefined).sort()
      : this.projector.entries().map(([key]) => key).sort();
    const actualKeys = (this.db.prepare(at
      ? `SELECT DISTINCT state_key FROM fabric_projection_history
         WHERE block_number < ? OR (block_number = ? AND transaction_index <= ?) ORDER BY state_key`
      : "SELECT state_key FROM fabric_projection_state ORDER BY state_key").all(...(at ? [at.block_number, at.block_number, at.transaction_index] : [])) as any[]).map(row => row.state_key);
    const expectedFiltered = expectedKeys.filter(key => key.startsWith(prefix));
    const actualFiltered = actualKeys.filter(key => key.startsWith(prefix));
    if (JSON.stringify(expectedFiltered) !== JSON.stringify(actualFiltered)) throw new Error("Fabric projection integrity check failed; rebuild the derived view");
    return expectedFiltered.map(key => [key, this.read(key, at)] as [string, unknown]);
  }

  checkpoint(): Checkpoint | null {
    this.ensureOpen();
    const block = this.blocks.at(-1);
    if (!block) return null;
    const result = this.results.get(block.block_number);
    if (!result) throw new Error("Verified Fabric block result is missing");
    const transactions = result.transactions;
    const last = transactions.at(-1);
    const checkpoint = checkpointFromRow({ channel_id: this.channelId, block_number: block.block_number, transaction_index: last?.transaction_index ?? -1, transaction_id: last?.tx_id ?? "", block_hash: result.checkpoint.block_hash });
    this.assertCheckpoint(checkpoint);
    return checkpoint;
  }

  checkpointForTransaction(transactionId: string): Checkpoint {
    this.ensureOpen();
    for (const block of this.blocks) {
      const result = this.results.get(block.block_number)!;
      const tx = result.transactions.find(candidate => candidate.valid && candidate.tx_id === transactionId);
      if (tx) {
        const checkpoint = checkpointFromRow({ channel_id: this.channelId, block_number: block.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash });
        this.assertCheckpoint(checkpoint);
        return checkpoint;
      }
    }
    throw new Error("Committed transaction checkpoint is missing");
  }

  checkpointForStateCreation(key: string): Checkpoint {
    this.ensureOpen();
    const entry = this.history.get(key)?.[0];
    if (!entry) throw new Error("State creation checkpoint is missing");
    const checkpoint = checkpointFromRow({ channel_id: this.channelId, ...entry });
    this.assertCheckpoint(checkpoint);
    return checkpoint;
  }

  assertCheckpoint(at: Checkpoint): void {
    this.ensureOpen();
    if (!at || at.channel_id !== this.channelId || !Number.isSafeInteger(at.block_number) || at.block_number < 0 || !Number.isSafeInteger(at.transaction_index) || at.transaction_index < -1 || typeof at.transaction_id !== "string" || typeof at.block_hash !== "string") throw new Error("Invalid checkpoint");
    this.verifyCursor(at.block_number);
    const block = this.blocks.find(candidate => candidate.block_number === at.block_number);
    const result = block ? this.results.get(block.block_number) : undefined;
    if (!block || !result || result.checkpoint.block_hash !== at.block_hash) throw new Error("Untrusted checkpoint");
    const tx = result.transactions[at.transaction_index];
    if (at.transaction_index === -1) {
      if (result.transactions.length !== 0 || at.transaction_id !== "") throw new Error("Untrusted checkpoint");
      return;
    }
    if (!tx || tx.tx_id !== at.transaction_id) throw new Error("Untrusted checkpoint");
    this.verifyStoredTransaction(tx, at);
  }

  events(afterBlock = 0, limitBlocks = 100): LedgerEvent[] {
    this.ensureOpen();
    this.verifyCurrentCursor();
    if (!Number.isSafeInteger(afterBlock) || afterBlock < 0 || !Number.isSafeInteger(limitBlocks) || limitBlocks < 1 || limitBlocks > 1000) throw new Error("Invalid event range");
    const events: LedgerEvent[] = [];
    for (const block of this.blocks.filter(candidate => candidate.block_number > afterBlock).slice(0, limitBlocks)) {
      const result = this.results.get(block.block_number)!;
      for (const tx of result.transactions) {
        if (!tx.valid) continue;
        this.verifyStoredTransaction(tx, checkpointFromRow({ channel_id: this.channelId, block_number: block.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash }));
        const writes = tx.writeset.map(write => [write.key, clone(write.value)] as [string, unknown]);
        events.push({
          checkpoint: { channel_id: this.channelId, block_number: block.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash },
          previous_hash: block.previous_hash,
          timestamp: tx.timestamp,
          validation_code: "VALID",
          reducer_version: 1,
          writes,
        });
      }
    }
    return events;
  }

  private ensureOpen(): void { if (this.closed) throw new Error("Fabric projection is closed"); }

  private ensureBinding(): void {
    const expected = {
      schema_version: SCHEMA_VERSION,
      channel_id: this.options.channel_id,
      chaincode_name: this.options.chaincode_name,
      chaincode_version: this.options.chaincode_version ?? "0.1.0",
      genesis_digest: sha256Digest(this.options.public_genesis),
    };
    const row = this.db.prepare("SELECT schema_version, channel_id, chaincode_name, chaincode_version, genesis_digest FROM fabric_projection_binding WHERE singleton = 1").get() as any;
    if (row) {
      for (const key of Object.keys(expected)) if (row[key] !== (expected as any)[key]) throw new Error("Fabric projection binding mismatch");
      return;
    }
    this.db.prepare(`INSERT INTO fabric_projection_binding
      (singleton, schema_version, channel_id, chaincode_name, chaincode_version, genesis_digest)
      VALUES (1, ?, ?, ?, ?, ?)`).run(expected.schema_version, expected.channel_id, expected.chaincode_name, expected.chaincode_version, expected.genesis_digest);
  }

  private loadBlocks(): BlockRow[] {
    return (this.db.prepare(`SELECT block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes
      FROM fabric_raw_blocks ORDER BY block_number`).all() as any[]).map(row => ({
      block_number: row.block_number,
      block_hash: row.block_hash,
      data_hash: row.data_hash,
      previous_hash: row.previous_hash,
      raw_digest: row.raw_digest,
      bytes: new Uint8Array(asBytes(row.block_bytes)),
    }));
  }

  private replay(blocks: BlockRow[]): { projector: FabricBlockProjector; results: Map<number, ProjectBlockResult> } {
    const projector = new FabricBlockProjector(this.options);
    const results = new Map<number, ProjectBlockResult>();
    for (const block of blocks) {
      const decoded = decodeBlock(block.bytes);
      const header = decoded.getHeader();
      if (!header || header.getNumber() !== block.block_number) throw new Error("Fabric raw block number mismatch");
      if (rawDigest(block.bytes) !== block.raw_digest) throw new Error("Fabric raw block digest mismatch");
      const result = projector.applyBlock(block.bytes);
      const previousHash = Buffer.from(header.getPreviousHash_asU8()).toString("hex");
      const dataHash = Buffer.from(header.getDataHash_asU8()).toString("hex");
      if (result.checkpoint.block_hash !== block.block_hash || result.checkpoint.data_hash !== block.data_hash || previousHash !== block.previous_hash || dataHash !== block.data_hash) throw new Error("Fabric raw block journal metadata mismatch");
      results.set(block.block_number, result);
    }
    return { projector, results };
  }

  private insertTransactions(blockNumber: number, result: ProjectBlockResult): void {
    for (const tx of result.transactions) {
      this.db.prepare(`INSERT INTO fabric_raw_transactions
        (block_number, transaction_index, transaction_id, validation_code, valid, timestamp, writes_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(blockNumber, tx.transaction_index, tx.tx_id, tx.validation_code, tx.valid ? 1 : 0, tx.timestamp, json(tx.writeset));
    }
  }

  private appendDerived(block: BlockRow, result: ProjectBlockResult): void {
    for (const tx of result.transactions) {
      if (!tx.valid) continue;
      for (const write of tx.writeset) {
        this.db.prepare(`INSERT INTO fabric_projection_history
          (state_key, block_number, transaction_index, transaction_id, block_hash, value_json)
          VALUES (?, ?, ?, ?, ?, ?)`).run(write.key, block.block_number, tx.transaction_index, tx.tx_id, result.checkpoint.block_hash, json(write.value));
        this.db.prepare(`INSERT INTO fabric_projection_state (state_key, value_json) VALUES (?, ?)
          ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json`).run(write.key, json(write.value));
      }
    }
    this.db.prepare(`INSERT INTO fabric_projection_cursor (singleton, block_number, block_hash, data_hash)
      VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET block_number = excluded.block_number, block_hash = excluded.block_hash, data_hash = excluded.data_hash`)
      .run(block.block_number, result.checkpoint.block_hash, result.checkpoint.data_hash);
  }

  private buildHistory(results: Map<number, ProjectBlockResult>, blocks: BlockRow[]): Map<string, HistoryEntry[]> {
    const history = new Map<string, HistoryEntry[]>();
    for (const block of blocks) {
      const result = results.get(block.block_number);
      if (!result) throw new Error("Fabric projection result is missing");
      for (const tx of result.transactions) {
        if (!tx.valid) continue;
        for (const write of tx.writeset) {
          const entries = history.get(write.key) ?? [];
          entries.push({ block_number: block.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash, value: clone(write.value) });
          history.set(write.key, entries);
        }
      }
    }
    return history;
  }

  private historyValue(key: string, at: Checkpoint): unknown | undefined {
    const entries = this.history.get(key) ?? [];
    let selected: HistoryEntry | undefined;
    for (const entry of entries) {
      if (entry.block_number < at.block_number || (entry.block_number === at.block_number && entry.transaction_index <= at.transaction_index)) selected = entry;
      else break;
    }
    return selected ? clone(selected.value) : undefined;
  }

  private verifyCursor(blockNumber: number): void {
    const expected = this.projector.checkpoint();
    const row = this.db.prepare("SELECT block_number, block_hash, data_hash FROM fabric_projection_cursor WHERE singleton = 1").get() as any;
    if (!expected || !row || row.block_number < blockNumber || row.block_number !== expected.block_number || row.block_hash !== expected.block_hash || row.data_hash !== expected.data_hash) throw new Error("Fabric projection cursor integrity check failed");
  }

  private verifyCurrentCursor(): void {
    const expected = this.projector.checkpoint();
    const row = this.db.prepare("SELECT block_number, block_hash, data_hash FROM fabric_projection_cursor WHERE singleton = 1").get() as any;
    if (!expected) {
      if (row) throw new Error("Fabric projection cursor is ahead of verified journal");
      return;
    }
    if (!row || row.block_number !== expected.block_number || row.block_hash !== expected.block_hash || row.data_hash !== expected.data_hash) throw new Error("Fabric projection cursor integrity check failed");
  }

  private verifyStoredTransaction(tx: ProjectedTransaction, checkpoint: Checkpoint): void {
    const row = this.db.prepare(`SELECT transaction_id, validation_code, valid, timestamp, writes_json
      FROM fabric_raw_transactions WHERE block_number = ? AND transaction_index = ?`).get(checkpoint.block_number, checkpoint.transaction_index) as any;
    if (!row || row.transaction_id !== tx.tx_id || row.validation_code !== tx.validation_code || row.valid !== (tx.valid ? 1 : 0) || row.timestamp !== tx.timestamp || !sameJson(JSON.parse(row.writes_json), tx.writeset)) throw new Error("Fabric transaction index integrity check failed");
  }

  private rebuildDerived(blocks: BlockRow[], results: Map<number, ProjectBlockResult>): void {
    this.db.exec("DELETE FROM fabric_raw_transactions; DELETE FROM fabric_projection_state; DELETE FROM fabric_projection_history; DELETE FROM fabric_projection_cursor;");
    const state = new Map<string, unknown>();
    for (const block of blocks) {
      const result = results.get(block.block_number);
      if (!result) throw new Error("Fabric projection result is missing");
      this.db.prepare("UPDATE fabric_raw_blocks SET result_json = ? WHERE block_number = ?").run(json(result), block.block_number);
      this.insertTransactions(block.block_number, result);
      for (const tx of result.transactions) {
        if (!tx.valid) continue;
        for (const write of tx.writeset) {
          state.set(write.key, clone(write.value));
          this.db.prepare(`INSERT INTO fabric_projection_history
            (state_key, block_number, transaction_index, transaction_id, block_hash, value_json)
            VALUES (?, ?, ?, ?, ?, ?)`).run(write.key, block.block_number, tx.transaction_index, tx.tx_id, result.checkpoint.block_hash, json(write.value));
        }
      }
    }
    for (const [key, value] of state) this.db.prepare("INSERT INTO fabric_projection_state (state_key, value_json) VALUES (?, ?)").run(key, json(value));
    const last = blocks.at(-1);
    if (last) this.db.prepare(`INSERT INTO fabric_projection_cursor (singleton, block_number, block_hash, data_hash) VALUES (1, ?, ?, ?)`)
      .run(last.block_number, last.block_hash, results.get(last.block_number)?.checkpoint.data_hash ?? last.data_hash);
  }
}
