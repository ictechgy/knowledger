import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { FabricBlockProjector, type FabricBlockProjectorOptions } from '../fabric/block-projector.ts';
import { fabricProjectionBinding, verifyFabricJournalBlock, type FabricJournalBlock } from '../fabric/journal-verification.ts';
import type { Checkpoint, LedgerEvent } from '../storage/local-ledger.ts';
import { measureAdoption, validateObservationLog, type AdoptionMeasurement } from './adoption.ts';

/** Replay a stopped, caller-trusted projection in one read snapshot. No rebuild,
 * credentials, peer connection, or inference from derived transaction rows. */
export function readFabricPilotMeasurement(input: {
  path: string; options: FabricBlockProjectorOptions; observations: unknown; evidence?: AdoptionMeasurement['evidence'];
}): AdoptionMeasurement {
  const log = validateObservationLog(input.observations);
  const projector = new FabricBlockProjector(input.options);
  const binding = fabricProjectionBinding(input.options);
  const db = new DatabaseSync(input.path, { readOnly: true });
  try {
    db.exec('BEGIN');
    try {
      const bindings = db.prepare('SELECT singleton, schema_version, channel_id, chaincode_name, chaincode_version, genesis_digest FROM fabric_projection_binding LIMIT 2').all();
      const stored = bindings[0];
      if (bindings.length !== 1 || stored.singleton !== 1
        || Object.entries(binding).some(([key, value]) => stored[key] !== value)) throw new Error('Fabric projection binding mismatch');
      let blockCount = 0;
      let validCount = 0;
      let invalidCount = 0;
      let journalDigest = '0'.repeat(64);
      let first: Checkpoint | undefined;
      let last: Checkpoint | undefined;
      function* events(): Generator<LedgerEvent> {
        // Include block zero and every transaction index. SQL transaction caches
        // and result_json are intentionally not consulted or repaired.
        const rows = db.prepare('SELECT block_number, block_hash, data_hash, previous_hash, raw_digest, block_bytes FROM fabric_raw_blocks ORDER BY block_number').iterate();
        for (const row of rows) {
          if (!(row.block_bytes instanceof Uint8Array)) throw new Error('Stored Fabric block is not bytes');
          const block: FabricJournalBlock = {
            block_number: row.block_number as number, block_hash: row.block_hash as string,
            data_hash: row.data_hash as string, previous_hash: row.previous_hash as string,
            raw_digest: row.raw_digest as string, bytes: row.block_bytes,
          };
          const result = verifyFabricJournalBlock(projector, block);
          journalDigest = createHash('sha256').update(Buffer.from(journalDigest + block.raw_digest, 'hex')).digest('hex');
          blockCount += 1;
          for (const transaction of result.transactions) {
            if (!transaction.valid) { invalidCount += 1; continue; }
            validCount += 1;
            const checkpoint: Checkpoint = {
              channel_id: binding.channel_id, block_number: block.block_number, block_hash: result.checkpoint.block_hash,
              transaction_index: transaction.transaction_index, transaction_id: transaction.tx_id,
            };
            first ??= checkpoint;
            last = checkpoint;
            yield { checkpoint, previous_hash: block.previous_hash, timestamp: transaction.timestamp,
              validation_code: 'VALID', reducer_version: 1,
              writes: transaction.writeset.map(write => [write.key, write.value]) };
          }
        }
      }
      const measurement = measureAdoption({ events: events(), log, channel_id: binding.channel_id, evidence: input.evidence });
      const checkpoint = projector.checkpoint();
      if (!checkpoint) throw new Error('Fabric raw block journal is empty');
      const cursors = db.prepare('SELECT singleton, block_number, block_hash, data_hash FROM fabric_projection_cursor LIMIT 2').all();
      const cursor = cursors[0];
      if (cursors.length !== 1 || cursor.singleton !== 1 || cursor.block_number !== checkpoint.block_number
        || cursor.block_hash !== checkpoint.block_hash || cursor.data_hash !== checkpoint.data_hash) throw new Error('Fabric projection cursor does not match verified journal');
      if (first && last) Object.assign(measurement.window, { first_checkpoint: first, last_checkpoint: last });
      measurement.source = { kind: 'fabric-projection', verification: 'offline-full-block-replay',
        channel_id: binding.channel_id, chaincode_name: binding.chaincode_name, chaincode_version: binding.chaincode_version,
        genesis_digest: binding.genesis_digest, block_count: blockCount, valid_transaction_count: validCount,
        invalid_transaction_count: invalidCount, journal_digest: journalDigest, checkpoint };
      db.exec('COMMIT');
      return measurement;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.close(); }
}
