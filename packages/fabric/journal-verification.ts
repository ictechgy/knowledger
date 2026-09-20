import { createHash } from 'node:crypto';
import { common } from '@hyperledger/fabric-protos';
import { FabricBlockProjector, type FabricBlockProjectorOptions, type ProjectBlockResult } from './block-projector.ts';
import { sha256Digest } from './canonical.ts';

export interface FabricJournalBlock {
  block_number: number;
  block_hash: string;
  data_hash: string;
  previous_hash: string;
  raw_digest: string;
  bytes: Uint8Array;
}

export function fabricProjectionBinding(options: FabricBlockProjectorOptions) {
  return {
    schema_version: 1,
    channel_id: options.channel_id,
    chaincode_name: options.chaincode_name,
    chaincode_version: options.chaincode_version ?? '0.1.0',
    genesis_digest: sha256Digest(options.public_genesis),
  };
}

/** Shared by durable replay and offline readers; derived SQL results are never input. */
export function verifyFabricJournalBlock(projector: FabricBlockProjector, block: FabricJournalBlock): ProjectBlockResult {
  if (!Number.isSafeInteger(block.block_number) || block.block_number < 0) throw new Error('Fabric raw block number is invalid');
  let decoded: common.Block;
  try { decoded = common.Block.deserializeBinary(block.bytes); }
  catch { throw new Error('Malformed Fabric block'); }
  const header = decoded.getHeader();
  if (!header || header.getNumber() !== block.block_number) throw new Error('Fabric raw block number mismatch');
  if (createHash('sha256').update(block.bytes).digest('hex') !== block.raw_digest) throw new Error('Fabric raw block digest mismatch');
  const result = projector.applyBlock(block.bytes);
  const previousHash = Buffer.from(header.getPreviousHash_asU8()).toString('hex');
  const dataHash = Buffer.from(header.getDataHash_asU8()).toString('hex');
  if (result.checkpoint.block_hash !== block.block_hash || result.checkpoint.data_hash !== block.data_hash
    || previousHash !== block.previous_hash || dataHash !== block.data_hash) throw new Error('Fabric raw block journal metadata mismatch');
  return result;
}
