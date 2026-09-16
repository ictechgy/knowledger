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
import { VerifiedBrowseIndex } from "../storage/browse-index.ts";
import type { BrowseResult, BrowseWriteBatch, BrowseQuery } from "../storage/browse-contract.ts";

const SCHEMA_VERSION = 1;
const MAX_HISTORICAL_SNAPSHOT_CACHE = 8;
const EMPTY_JOURNAL_DIGEST = '0'.repeat(64);
function appendJournalDigest(previous: string, rawBlockDigest: string): string {
  return rawDigest(Buffer.from(previous + rawBlockDigest, 'hex'));
}

type BlockRow = {
  block_number: number;
  block_hash: string;
  data_hash: string;
  previous_hash: string;
  raw_digest: string;
  bytes: Uint8Array;
};

type HistoricalReplay = {
  before: Map<string, unknown>;
  raw_digest: string;
  result: ProjectBlockResult;
};

type VerifiedBlockResult = {
  raw_digest: string;
  result: ProjectBlockResult;
};

type StateCreationAnchor = {
  block_raw_digest: string;
  checkpoint: Checkpoint;
  transaction_digest: string;
  value_digest: string;
};

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
 * Raw blocks are the journal. On open, every raw block is streamed through
 * FabricBlockProjector. The state/history/cursor tables are derived views and
 * are rebuilt from that replay in one SQL transaction, so a damaged derived
 * view is recoverable while a damaged or forged raw journal stops startup.
 * Historical reads replay the journal on demand instead of retaining all
 * blocks, results, or per-key history in process memory.
 */
export class SqliteFabricProjection {
  readonly channelId: string;
  private readonly db: DatabaseSync;
  private readonly options: FabricBlockProjectorOptions;
  private projector!: FabricBlockProjector;
  /** Metadata-only browse index derived from the same verified transaction stream. */
  private browseIndex!: VerifiedBrowseIndex;
  /** Only the latest result is cached; raw blocks and historical results are on disk. */
  private latestResult: ProjectBlockResult | null = null;
  /** At most eight point-in-time snapshots; worst case is eight copies of current state. */
  private readonly historicalSnapshots = new Map<string, HistoricalReplay>();
  /** A bounded LRU avoids replaying the journal for repeated historical receipts. */
  private readonly verifiedBlockResults = new Map<number, VerifiedBlockResult>();
  /** Compact first-write proofs grow with current keys, not with update history. */
  private stateCreationAnchors = new Map<string, StateCreationAnchor>();
  private latestRawDigest: string | null = null;
  // One process-trusted digest covers VALID metadata too, which Fabric's header
  // hash does not bind. Cold replay must match the complete verified byte journal.
  private journalDigest = EMPTY_JOURNAL_DIGEST;
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
        CREATE TABLE IF NOT EXISTS fabric_projection_state_creation (
          state_key TEXT PRIMARY KEY,
          block_number INTEGER NOT NULL,
          transaction_index INTEGER NOT NULL,
          transaction_id TEXT NOT NULL,
          block_hash TEXT NOT NULL,
          value_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS fabric_projection_cursor (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          block_number INTEGER NOT NULL,
          block_hash TEXT NOT NULL,
          data_hash TEXT NOT NULL
        );
      `);
      this.ensureBinding();
      const replayed = this.replayAndRebuild();
      this.projector = replayed.projector;
      this.browseIndex = replayed.browseIndex;
      this.latestResult = replayed.latestResult;
      this.latestRawDigest = replayed.latestRawDigest;
      this.journalDigest = replayed.journalDigest;
      this.stateCreationAnchors = replayed.stateCreationAnchors;
      if (replayed.latestResult && replayed.latestRawDigest) this.rememberBlockResult(replayed.latestResult, replayed.latestRawDigest);
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
    const existing = this.loadBlock(blockNumber);
    if (existing) {
      if (rawDigest(existing.bytes) !== existing.raw_digest) throw new Error("Fabric raw block digest mismatch");
      if (!sameBytes(incoming, existing.bytes)) throw new Error("A different Fabric block occupies this block number");
      return clone(this.replayBlock(blockNumber));
    }
    const block = this.blockFromHeader(incoming, header);
    const candidate = this.projector.fork();
    const result = candidate.applyBlock(incoming);
    if (result.checkpoint.block_number !== blockNumber || result.checkpoint.block_hash !== block.block_hash || result.checkpoint.data_hash !== block.data_hash) throw new Error("Fabric candidate result does not match block header");
    // Prepare metadata before opening the SQL transaction.  `commit()` is
    // deliberately delayed until the durable projection commit succeeds, so
    // a failed SQL write cannot advance the in-memory browse view.
    const preparedBrowse = this.browseIndex.prepare(this.browseBatches(block, result));

    this.db.exec("BEGIN IMMEDIATE");
    let sqlCommitted = false;
    try {
      this.db.prepare(`INSERT INTO fabric_raw_blocks
        (block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(block.block_number, block.block_hash, result.checkpoint.data_hash, block.previous_hash, block.raw_digest, Buffer.from(block.bytes), json(result));
      this.insertTransactions(block.block_number, result);
      this.appendDerived(block, result);
      this.db.exec("COMMIT");
      sqlCommitted = true;
      preparedBrowse.commit();
    } catch (error) {
      if (!sqlCommitted) this.db.exec("ROLLBACK");
      throw error;
    }
    this.projector = candidate;
    this.latestResult = result;
    this.latestRawDigest = block.raw_digest;
    this.journalDigest = appendJournalDigest(this.journalDigest, block.raw_digest);
    this.recordStateCreationAnchors(this.stateCreationAnchors, block, result);
    this.rememberBlockResult(result, block.raw_digest);
    return clone(result);
  }

  /**
   * Query only metadata derived from verified VALID transactions.  The
   * checkpoint assertion is intentionally performed at this adapter boundary
   * before the optimization index is consulted.
   */
  queryBrowse<Q extends BrowseQuery>(query: Q): BrowseResult<Q> {
    this.ensureOpen();
    this.assertCheckpoint(query.at);
    return this.browseIndex.query(query);
  }

  read(key: string, at?: Checkpoint | null): unknown | undefined {
    this.ensureOpen();
    let expected: unknown | undefined;
    if (at === undefined || at === null) {
      this.verifyCurrentCursor();
      expected = this.projector.read(key);
    } else if (this.isCurrentCheckpoint(at)) {
      this.verifyCurrentCheckpoint(at);
      expected = this.projector.read(key);
    } else {
      const replayed = this.replayCheckpoint(at);
      expected = this.valueAtCheckpoint(key, at, replayed.before, replayed.result);
    }
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
    let expected: [string, unknown][];
    let actualRows: any[];
    if (at === undefined || at === null) {
      this.verifyCurrentCursor();
      expected = this.projector.entries(prefix);
      actualRows = this.db.prepare("SELECT state_key, value_json FROM fabric_projection_state WHERE substr(state_key, 1, length(?)) = ? ORDER BY state_key").all(prefix, prefix) as any[];
    } else if (this.isCurrentCheckpoint(at)) {
      this.verifyCurrentCheckpoint(at);
      expected = this.projector.entries(prefix);
      actualRows = this.db.prepare("SELECT state_key, value_json FROM fabric_projection_state WHERE substr(state_key, 1, length(?)) = ? ORDER BY state_key").all(prefix, prefix) as any[];
    } else {
      const replayed = this.replayCheckpoint(at);
      expected = this.entriesAtCheckpoint(prefix, at, replayed.before, replayed.result);
      actualRows = this.db.prepare(`SELECT state_key, value_json FROM (
          SELECT state_key, value_json, ROW_NUMBER() OVER (PARTITION BY state_key ORDER BY block_number DESC, transaction_index DESC) AS latest
          FROM fabric_projection_history
          WHERE (block_number < ? OR (block_number = ? AND transaction_index <= ?))
            AND substr(state_key, 1, length(?)) = ?
        ) WHERE latest = 1 ORDER BY state_key`).all(at.block_number, at.block_number, at.transaction_index, prefix, prefix) as any[];
    }
    const actual = new Map<string, unknown>();
    for (const row of actualRows) actual.set(row.state_key, JSON.parse(row.value_json));
    if (expected.length !== actual.size || expected.some(([key, value]) => !actual.has(key) || !sameJson(actual.get(key), value))) throw new Error("Fabric projection integrity check failed; rebuild the derived view");
    return expected.map(([key, value]) => [key, clone(value)]);
  }

  checkpoint(): Checkpoint | null {
    this.ensureOpen();
    this.verifyCurrentCursor();
    const result = this.latestResult;
    if (!result) return null;
    const transactions = result.transactions;
    const last = transactions.at(-1);
    const checkpoint = checkpointFromRow({ channel_id: this.channelId, block_number: result.checkpoint.block_number, transaction_index: last?.transaction_index ?? -1, transaction_id: last?.tx_id ?? "", block_hash: result.checkpoint.block_hash });
    if (last) this.verifyStoredTransaction(last, checkpoint);
    return checkpoint;
  }

  checkpointForTransaction(transactionId: string): Checkpoint {
    this.ensureOpen();
    this.verifyCurrentCursor();
    const locator = this.db.prepare(`SELECT block_number, transaction_index FROM fabric_raw_transactions
      WHERE transaction_id = ? AND valid = 1 ORDER BY block_number, transaction_index LIMIT 1`).get(transactionId) as any;
    if (locator) {
      if (!Number.isSafeInteger(locator.block_number) || locator.block_number < 0 || !Number.isSafeInteger(locator.transaction_index) || locator.transaction_index < 0) throw new Error("Fabric transaction index integrity check failed");
      const result = this.replayBlock(locator.block_number);
      const tx = result.transactions[locator.transaction_index];
      if (!tx || !tx.valid || tx.tx_id !== transactionId) throw new Error("Fabric transaction index integrity check failed");
      const checkpoint = checkpointFromRow({ channel_id: this.channelId, block_number: locator.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash });
      this.verifyStoredTransaction(tx, checkpoint);
      return checkpoint;
    }

    // A missing derived locator must not hide a transaction present in the
    // independently verified journal. This fail-closed path is intentionally
    // slower than successful receipt lookup.
    const projector = new FabricBlockProjector(this.options);
    let foundInJournal = false;
    let journalDigest = EMPTY_JOURNAL_DIGEST;
    for (const block of this.iterateRawBlocks()) {
      journalDigest = appendJournalDigest(journalDigest, block.raw_digest);
      const result = this.verifyAndApply(projector, block);
      if (result.transactions.some(candidate => candidate.valid && candidate.tx_id === transactionId)) foundInJournal = true;
    }
    this.verifyReplayTip(projector, journalDigest);
    if (foundInJournal) throw new Error("Fabric transaction index integrity check failed");
    throw new Error("Committed transaction checkpoint is missing");
  }

  checkpointForStateCreation(key: string): Checkpoint {
    this.ensureOpen();
    this.verifyCurrentCursor();
    const anchor = this.stateCreationAnchors.get(key);
    const row = this.db.prepare(`SELECT block_number, transaction_index, transaction_id, block_hash, value_json
      FROM fabric_projection_state_creation WHERE state_key = ?`).get(key) as any;
    if (!anchor) {
      if (row) throw new Error("Fabric state creation integrity check failed");
      throw new Error("State creation checkpoint is missing");
    }
    if (!row) throw new Error("Fabric state creation integrity check failed");
    const checkpoint = checkpointFromRow({ channel_id: this.channelId, ...row });
    let value: unknown;
    try { value = JSON.parse(row.value_json); } catch { throw new Error("Fabric state creation integrity check failed"); }
    if (!sameJson(checkpoint, anchor.checkpoint) || sha256Digest(value) !== anchor.value_digest) throw new Error("Fabric state creation integrity check failed");
    const transactionRow = this.db.prepare(`SELECT transaction_id, validation_code, valid, timestamp, writes_json
      FROM fabric_raw_transactions WHERE block_number = ? AND transaction_index = ?`).get(checkpoint.block_number, checkpoint.transaction_index) as any;
    const storedTransaction = this.transactionFromStoredRow(transactionRow, checkpoint.transaction_index);
    if (sha256Digest(storedTransaction) !== anchor.transaction_digest) throw new Error("Fabric transaction index integrity check failed");
    this.verifyStoredBlock(anchor.checkpoint, undefined, anchor.block_raw_digest);
    return { ...anchor.checkpoint };
  }

  assertCheckpoint(at: Checkpoint): void {
    this.ensureOpen();
    if (this.isCurrentCheckpoint(at)) {
      this.verifyCurrentCheckpoint(at);
      return;
    }
    this.replayCheckpoint(at);
  }

  events(afterBlock = 0, limitBlocks = 100): LedgerEvent[] {
    this.ensureOpen();
    this.verifyCurrentCursor();
    if (!Number.isSafeInteger(afterBlock) || afterBlock < 0 || !Number.isSafeInteger(limitBlocks) || limitBlocks < 1 || limitBlocks > 1000) throw new Error("Invalid event range");
    const events: LedgerEvent[] = [];
    const projector = new FabricBlockProjector(this.options);
    let selectedBlocks = 0;
    let journalDigest = EMPTY_JOURNAL_DIGEST;
    for (const block of this.iterateRawBlocks()) {
      journalDigest = appendJournalDigest(journalDigest, block.raw_digest);
      const result = this.verifyAndApply(projector, block);
      if (block.block_number <= afterBlock || selectedBlocks >= limitBlocks) continue;
      selectedBlocks += 1;
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
    this.verifyReplayTip(projector, journalDigest);
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

  private blockFromRow(row: any): BlockRow {
    if (!Number.isSafeInteger(row.block_number) || row.block_number < 0) throw new Error("Fabric raw block number is invalid");
    return {
      block_number: row.block_number,
      block_hash: row.block_hash,
      data_hash: row.data_hash,
      previous_hash: row.previous_hash,
      raw_digest: row.raw_digest,
      bytes: new Uint8Array(asBytes(row.block_bytes)),
    };
  }

  private blockFromHeader(serialized: Uint8Array, header: common.BlockHeader): BlockRow {
    return {
      block_number: header.getNumber(),
      block_hash: fabricBlockHeaderHash(header),
      data_hash: Buffer.from(header.getDataHash_asU8()).toString("hex"),
      previous_hash: Buffer.from(header.getPreviousHash_asU8()).toString("hex"),
      raw_digest: rawDigest(serialized),
      bytes: serialized,
    };
  }

  private loadBlock(blockNumber: number): BlockRow | null {
    const row = this.db.prepare(`SELECT block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes
      FROM fabric_raw_blocks WHERE block_number = ?`).get(blockNumber) as any;
    return row ? this.blockFromRow(row) : null;
  }

  /** Iterate one journal row at a time so raw blocks never accumulate in heap. */
  private *iterateRawBlocks(): Generator<BlockRow> {
    const statement = this.db.prepare(`SELECT block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes
      FROM fabric_raw_blocks WHERE block_number > ? ORDER BY block_number LIMIT 1`);
    let after = -1;
    while (true) {
      const row = statement.get(after) as any;
      if (!row) return;
      const block = this.blockFromRow(row);
      yield block;
      after = block.block_number;
    }
  }

  private verifyAndApply(projector: FabricBlockProjector, block: BlockRow): ProjectBlockResult {
    const decoded = decodeBlock(block.bytes);
    const header = decoded.getHeader();
    if (!header || header.getNumber() !== block.block_number) throw new Error("Fabric raw block number mismatch");
    if (rawDigest(block.bytes) !== block.raw_digest) throw new Error("Fabric raw block digest mismatch");
    const result = projector.applyBlock(block.bytes);
    const previousHash = Buffer.from(header.getPreviousHash_asU8()).toString("hex");
    const dataHash = Buffer.from(header.getDataHash_asU8()).toString("hex");
    if (result.checkpoint.block_hash !== block.block_hash || result.checkpoint.data_hash !== block.data_hash || previousHash !== block.previous_hash || dataHash !== block.data_hash) throw new Error("Fabric raw block journal metadata mismatch");
    return result;
  }

  private replayAndRebuild(): { projector: FabricBlockProjector; browseIndex: VerifiedBrowseIndex; latestResult: ProjectBlockResult | null; latestRawDigest: string | null; stateCreationAnchors: Map<string, StateCreationAnchor>; journalDigest: string } {
    const projector = new FabricBlockProjector(this.options);
    const browseIndex = new VerifiedBrowseIndex(this.channelId);
    let latestResult: ProjectBlockResult | null = null;
    let latestRawDigest: string | null = null;
    const stateCreationAnchors = new Map<string, StateCreationAnchor>();
    let journalDigest = EMPTY_JOURNAL_DIGEST;
    let sqlCommitted = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM fabric_raw_transactions; DELETE FROM fabric_projection_state; DELETE FROM fabric_projection_history; DELETE FROM fabric_projection_state_creation; DELETE FROM fabric_projection_cursor;");
      const self = this;
      function* replayBrowse(): Generator<BrowseWriteBatch> {
        for (const block of self.iterateRawBlocks()) {
          journalDigest = appendJournalDigest(journalDigest, block.raw_digest);
          const result = self.verifyAndApply(projector, block);
          self.db.prepare("UPDATE fabric_raw_blocks SET result_json = ? WHERE block_number = ?").run(json(result), block.block_number);
          self.insertTransactions(block.block_number, result);
          self.appendDerived(block, result);
          yield* self.browseBatches(block, result);
          self.recordStateCreationAnchors(stateCreationAnchors, block, result);
          latestResult = result;
          latestRawDigest = block.raw_digest;
        }
      }
      // One staged metadata view consumes verified writes as a stream, without
      // retaining journal bodies or copying the whole index for every block.
      const preparedBrowse = browseIndex.prepare(replayBrowse());
      this.db.exec("COMMIT");
      sqlCommitted = true;
      preparedBrowse.commit();
    } catch (error) {
      // `commit()` is expected to be infallible after prepare.  Keep the
      // durable rebuild intact if a future index implementation violates
      // that contract after SQLite has already committed.
      if (!sqlCommitted) this.db.exec("ROLLBACK");
      throw error;
    }
    return { projector, browseIndex, latestResult, latestRawDigest, stateCreationAnchors, journalDigest };
  }

  private browseBatches(block: BlockRow, result: ProjectBlockResult): BrowseWriteBatch[] {
    // Empty valid configuration/lifecycle transactions carry no browseable
    // metadata (and may legitimately have an empty Fabric tx id).
    return result.transactions.filter(transaction => transaction.valid && transaction.writeset.length > 0).map(transaction => ({
      checkpoint: checkpointFromRow({
        channel_id: this.channelId,
        block_number: block.block_number,
        transaction_index: transaction.transaction_index,
        transaction_id: transaction.tx_id,
        block_hash: result.checkpoint.block_hash,
      }),
      writes: transaction.writeset.map(write => [write.key, write.value] as const),
    }));
  }

  private replayBlock(blockNumber: number): ProjectBlockResult {
    const cached = this.verifiedBlockResults.get(blockNumber);
    if (cached) {
      this.verifyStoredBlock(checkpointFromRow({ channel_id: this.channelId, block_number: blockNumber, transaction_index: -1, transaction_id: "", block_hash: cached.result.checkpoint.block_hash }), cached.result, cached.raw_digest);
      this.verifiedBlockResults.delete(blockNumber);
      this.verifiedBlockResults.set(blockNumber, cached);
      return cached.result;
    }
    const projector = new FabricBlockProjector(this.options);
    let selected: VerifiedBlockResult | null = null;
    let journalDigest = EMPTY_JOURNAL_DIGEST;
    for (const block of this.iterateRawBlocks()) {
      journalDigest = appendJournalDigest(journalDigest, block.raw_digest);
      const result = this.verifyAndApply(projector, block);
      if (block.block_number === blockNumber) selected = { raw_digest: block.raw_digest, result };
    }
    this.verifyReplayTip(projector, journalDigest);
    if (!selected) throw new Error("Verified Fabric block is missing");
    this.rememberBlockResult(selected.result, selected.raw_digest);
    return selected.result;
  }

  private replayCheckpoint(at: Checkpoint): HistoricalReplay {
    this.validateCheckpoint(at);
    this.verifyCursor(at.block_number);
    const cacheKey = this.checkpointKey(at);
    const cached = this.historicalSnapshots.get(cacheKey);
    if (cached) {
      this.verifyCachedCheckpoint(at, cached);
      this.historicalSnapshots.delete(cacheKey);
      this.historicalSnapshots.set(cacheKey, cached);
      return cached;
    }
    const projector = new FabricBlockProjector(this.options);
    let selected: HistoricalReplay | null = null;
    let journalDigest = EMPTY_JOURNAL_DIGEST;
    for (const block of this.iterateRawBlocks()) {
      journalDigest = appendJournalDigest(journalDigest, block.raw_digest);
      if (block.block_number === at.block_number) {
        const before = new Map(projector.entries());
        const result = this.verifyAndApply(projector, block);
        if (result.checkpoint.block_hash !== at.block_hash) throw new Error("Untrusted checkpoint");
        if (at.transaction_index === -1) {
          if (result.transactions.length !== 0 || at.transaction_id !== "") throw new Error("Untrusted checkpoint");
          selected = { before, raw_digest: block.raw_digest, result };
          continue;
        }
        const tx = result.transactions[at.transaction_index];
        if (!tx || tx.tx_id !== at.transaction_id) throw new Error("Untrusted checkpoint");
        this.verifyStoredTransaction(tx, at);
        selected = { before, raw_digest: block.raw_digest, result };
        continue;
      }
      this.verifyAndApply(projector, block);
    }
    this.verifyReplayTip(projector, journalDigest);
    if (!selected) throw new Error("Untrusted checkpoint");
    this.rememberHistoricalSnapshot(cacheKey, selected);
    return selected;
  }

  private valueAtCheckpoint(key: string, at: Checkpoint, before: Map<string, unknown>, result: ProjectBlockResult): unknown | undefined {
    let value = before.get(key);
    if (at.transaction_index >= 0) {
      for (const tx of result.transactions) {
        if (tx.transaction_index > at.transaction_index) break;
        if (!tx.valid) continue;
        for (const write of tx.writeset) if (write.key === key) value = write.value;
      }
    }
    return value === undefined ? undefined : clone(value);
  }

  private entriesAtCheckpoint(prefix: string, at: Checkpoint, before: Map<string, unknown>, result: ProjectBlockResult): [string, unknown][] {
    const state = new Map(before);
    if (at.transaction_index >= 0) {
      for (const tx of result.transactions) {
        if (tx.transaction_index > at.transaction_index) break;
        if (!tx.valid) continue;
        for (const write of tx.writeset) state.set(write.key, clone(write.value));
      }
    }
    return [...state.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
  }

  private validateCheckpoint(at: Checkpoint): void {
    if (!at || at.channel_id !== this.channelId || !Number.isSafeInteger(at.block_number) || at.block_number < 0 || !Number.isSafeInteger(at.transaction_index) || at.transaction_index < -1 || typeof at.transaction_id !== "string" || typeof at.block_hash !== "string") throw new Error("Invalid checkpoint");
  }

  private checkpointKey(at: Checkpoint): string {
    return `${at.block_number}:${at.transaction_index}:${at.transaction_id}:${at.block_hash}`;
  }

  private rememberHistoricalSnapshot(key: string, replayed: HistoricalReplay): void {
    this.historicalSnapshots.delete(key);
    this.historicalSnapshots.set(key, replayed);
    while (this.historicalSnapshots.size > MAX_HISTORICAL_SNAPSHOT_CACHE) this.historicalSnapshots.delete(this.historicalSnapshots.keys().next().value!);
  }

  private rememberBlockResult(result: ProjectBlockResult, rawDigest: string): void {
    const blockNumber = result.checkpoint.block_number;
    this.verifiedBlockResults.delete(blockNumber);
    this.verifiedBlockResults.set(blockNumber, { raw_digest: rawDigest, result });
    while (this.verifiedBlockResults.size > MAX_HISTORICAL_SNAPSHOT_CACHE) this.verifiedBlockResults.delete(this.verifiedBlockResults.keys().next().value!);
  }

  private recordStateCreationAnchors(target: Map<string, StateCreationAnchor>, block: BlockRow, result: ProjectBlockResult): void {
    for (const tx of result.transactions) {
      if (!tx.valid) continue;
      let transactionDigest: string | undefined;
      for (const write of tx.writeset) {
        if (target.has(write.key)) continue;
        transactionDigest ??= sha256Digest(tx);
        target.set(write.key, {
          block_raw_digest: block.raw_digest,
          checkpoint: checkpointFromRow({ channel_id: this.channelId, block_number: block.block_number, transaction_index: tx.transaction_index, transaction_id: tx.tx_id, block_hash: result.checkpoint.block_hash }),
          transaction_digest: transactionDigest,
          value_digest: sha256Digest(write.value),
        });
      }
    }
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
        this.db.prepare(`INSERT OR IGNORE INTO fabric_projection_state_creation
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

  private isCurrentCheckpoint(at: Checkpoint): boolean {
    if (!at || typeof at !== "object") return false;
    const current = this.projector.checkpoint();
    const result = this.latestResult;
    if (!current || !result) return false;
    const last = result.transactions.at(-1);
    return at.channel_id === this.channelId && at.block_number === current.block_number && at.block_hash === current.block_hash
      && at.transaction_index === (last?.transaction_index ?? -1) && at.transaction_id === (last?.tx_id ?? "");
  }

  private verifyCurrentCheckpoint(at: Checkpoint): void {
    this.validateCheckpoint(at);
    if (!this.isCurrentCheckpoint(at)) throw new Error("Untrusted checkpoint");
    this.verifyCursor(at.block_number);
    const result = this.latestResult;
    if (!result) throw new Error("Verified Fabric block result is missing");
    this.verifyStoredBlock(at, result, this.latestRawDigest ?? undefined);
    const last = result.transactions.at(-1);
    if (last) this.verifyStoredTransaction(last, at);
  }

  private verifyCachedCheckpoint(at: Checkpoint, replayed: HistoricalReplay): void {
    this.verifyStoredBlock(at, replayed.result, replayed.raw_digest);
    if (at.transaction_index === -1) {
      if (replayed.result.transactions.length !== 0 || at.transaction_id !== "") throw new Error("Untrusted checkpoint");
      return;
    }
    const tx = replayed.result.transactions[at.transaction_index];
    if (!tx || tx.tx_id !== at.transaction_id) throw new Error("Untrusted checkpoint");
    this.verifyStoredTransaction(tx, at);
  }

  private verifyStoredBlock(at: Checkpoint, result?: ProjectBlockResult, expectedRawDigest?: string): void {
    const block = this.loadBlock(at.block_number);
    const actualRawDigest = block ? rawDigest(block.bytes) : "";
    if (!block || actualRawDigest !== block.raw_digest || (expectedRawDigest !== undefined && actualRawDigest !== expectedRawDigest)) throw new Error("Fabric raw block digest mismatch");
    const decoded = decodeBlock(block.bytes);
    const header = decoded.getHeader();
    const data = decoded.getData();
    if (!header || !data || header.getNumber() !== block.block_number) throw new Error("Fabric raw block number mismatch");
    const blockHash = fabricBlockHeaderHash(header);
    const dataHash = Buffer.from(header.getDataHash_asU8()).toString("hex");
    const computedDataHash = rawDigest(Buffer.concat(data.getDataList_asU8().map(entry => Buffer.from(entry))));
    const previousHash = Buffer.from(header.getPreviousHash_asU8()).toString("hex");
    if (computedDataHash !== dataHash || blockHash !== block.block_hash || dataHash !== block.data_hash || previousHash !== block.previous_hash || blockHash !== at.block_hash || (result && (result.checkpoint.block_hash !== blockHash || result.checkpoint.data_hash !== dataHash))) throw new Error("Fabric raw block journal metadata mismatch");
  }

  private verifyReplayTip(projector: FabricBlockProjector, journalDigest: string): void {
    if (journalDigest !== this.journalDigest) throw new Error("Fabric raw block journal no longer matches the verified bytes");
    const replayed = projector.checkpoint();
    const trusted = this.projector.checkpoint();
    if (!sameJson(replayed, trusted) || !sameJson(projector.entries(), this.projector.entries())) throw new Error("Fabric raw block journal no longer matches the verified tip");
  }

  private verifyStoredTransaction(tx: ProjectedTransaction, checkpoint: Checkpoint): void {
    const row = this.db.prepare(`SELECT transaction_id, validation_code, valid, timestamp, writes_json
      FROM fabric_raw_transactions WHERE block_number = ? AND transaction_index = ?`).get(checkpoint.block_number, checkpoint.transaction_index) as any;
    let stored: ProjectedTransaction;
    try { stored = this.transactionFromStoredRow(row, checkpoint.transaction_index); }
    catch { throw new Error("Fabric transaction index integrity check failed"); }
    if (!sameJson(stored, tx)) throw new Error("Fabric transaction index integrity check failed");
  }

  private transactionFromStoredRow(row: any, transactionIndex: number): ProjectedTransaction {
    if (!row || typeof row.transaction_id !== "string" || !Number.isSafeInteger(row.validation_code) || (row.valid !== 0 && row.valid !== 1) || typeof row.timestamp !== "string") throw new Error("Fabric transaction index integrity check failed");
    let writeset: unknown;
    try { writeset = JSON.parse(row.writes_json); } catch { throw new Error("Fabric transaction index integrity check failed"); }
    if (!Array.isArray(writeset)) throw new Error("Fabric transaction index integrity check failed");
    return {
      tx_id: row.transaction_id,
      transaction_index: transactionIndex,
      validation_code: row.validation_code,
      valid: row.valid === 1,
      writes: writeset.length,
      writeset: writeset as Array<{ key: string; value: unknown }>,
      timestamp: row.timestamp,
    };
  }

}
