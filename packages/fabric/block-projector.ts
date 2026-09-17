import { createHash } from "node:crypto";
import { common, ledger, peer } from "@hyperledger/fabric-protos";
import { canonicalize } from "../domain/index.ts";
import { sha256Digest, parseStrictJson } from "./canonical.ts";
import { IMMUTABLE_KINDS, validateStateLinks, validateStateWrite } from "../storage/state-validation.ts";

const BOOTSTRAP_KEY = "kcl:v1:bootstrap_manifest";
// Fabric 2.5 core/chaincode/chaincode_support.go: InitializedKeyName.
const FABRIC_INITIALIZED_KEY = "\u0000\u{10ffff}initialized";
const ENDORSER_TRANSACTION = common.HeaderType.ENDORSER_TRANSACTION;
const SUPPORTED_VALIDATION_CODES = new Set(Object.entries(peer.TxValidationCode).filter(([name]) => name !== "NOT_VALIDATED").map(([, value]) => value).filter((value): value is number => typeof value === "number"));

export interface FabricBlockProjectorOptions {
  channel_id: string;
  chaincode_name: string;
  chaincode_version?: string;
  public_genesis: unknown;
}

export interface ProjectorCheckpoint {
  channel_id: string;
  block_number: number;
  block_hash: string;
  data_hash: string;
}

export interface ProjectedTransaction {
  tx_id: string;
  transaction_index: number;
  validation_code: number;
  valid: boolean;
  writes: number;
  writeset: Array<{ key: string; value: unknown }>;
  timestamp: string;
}

export interface ProjectBlockResult {
  checkpoint: ProjectorCheckpoint;
  transactions: ProjectedTransaction[];
  valid_transaction_ids: string[];
  invalid_transaction_ids: string[];
}

interface DecodedWrite {
  key: string;
  value: unknown;
}

interface DecodedTransaction extends ProjectedTransaction {
  header_type: number;
}

type ProjectorTarget = Pick<FabricBlockProjectorOptions, "channel_id" | "chaincode_name"> & { chaincode_version: string };

function fail(message = "Fabric block projection halted"): never {
  throw new Error(message);
}

function bytes(value: Uint8Array | number[] | undefined): Uint8Array {
  if (value === undefined) return new Uint8Array();
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function derLength(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 0) fail("ASN.1 length is invalid");
  if (length < 0x80) return Uint8Array.of(length);
  const value = unsignedBytes(length);
  return Uint8Array.of(0x80 | value.byteLength, ...value);
}

function unsignedBytes(value: number): Buffer {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex");
}

function derField(tag: number, value: Uint8Array): Uint8Array {
  return Uint8Array.from(Buffer.concat([Buffer.from([tag]), Buffer.from(derLength(value.byteLength)), Buffer.from(value)]));
}

/** Fabric's protoutil.BlockHeaderHash: SHA-256 of its ASN.1 DER tuple. */
export function fabricBlockHeaderHash(header: common.BlockHeader): string {
  const number = header.getNumber();
  if (!Number.isSafeInteger(number) || number < 0) fail("Fabric block number is outside the supported range");
  let integer = unsignedBytes(number);
  if ((integer[0] ?? 0) & 0x80) integer = Buffer.concat([Buffer.from([0]), integer]);
  const body = Buffer.concat([
    Buffer.from(derField(0x02, integer)),
    Buffer.from(derField(0x04, bytes(header.getPreviousHash_asU8()))),
    Buffer.from(derField(0x04, bytes(header.getDataHash_asU8()))),
  ]);
  return digest(derField(0x30, body));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function decode<T>(type: { deserializeBinary(value: Uint8Array): T }, value: Uint8Array): T {
  if (value.byteLength === 0) fail("Required Fabric protobuf message is empty");
  try { return type.deserializeBinary(value); } catch { return fail("Malformed Fabric protobuf message"); }
}

function strictRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} is malformed`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) fail(`${label} is malformed`);
  return record;
}

function verifyBootstrap(value: unknown, channelId: string, genesisDigest: string, genesis: { config_version: string | number; membership_epoch: number; role_binding_version: number }): void {
  const marker = strictRecord(value, ["payload_digest", "result"], "bootstrap manifest");
  if (marker.payload_digest !== genesisDigest) fail("Bootstrap manifest digest does not match pinned public genesis");
  const result = strictRecord(marker.result, ["status", "channel_id", "config_version", "membership_epoch", "role_binding_version"], "bootstrap result");
  if (result.status !== "bootstrapped" || result.channel_id !== channelId) fail("Bootstrap manifest result is not for this channel");
  if (result.config_version !== genesis.config_version || result.membership_epoch !== genesis.membership_epoch || result.role_binding_version !== genesis.role_binding_version ||
      (typeof result.config_version !== "string" && typeof result.config_version !== "number") ||
      !Number.isSafeInteger(result.membership_epoch) || (result.membership_epoch as number) < 1 ||
      !Number.isSafeInteger(result.role_binding_version) || (result.role_binding_version as number) < 1) {
    fail("Bootstrap manifest result is malformed");
  }
}

function valueForWrite(key: string, value: Uint8Array, channelId: string, genesisDigest: string, genesis: { config_version: string | number; membership_epoch: number; role_binding_version: number }): unknown {
  let parsed: unknown;
  try { parsed = parseStrictJson(value); } catch { return fail("State write is not strict JSON"); }
  if (key === BOOTSTRAP_KEY) {
    verifyBootstrap(parsed, channelId, genesisDigest, genesis);
    return parsed;
  }
  validateStateWrite(key, parsed);
  if (key === "kcl:v1:config" && sha256Digest(parsed) !== genesisDigest) fail("Config write does not match pinned public genesis");
  return parsed;
}

function chaincodeName(action: peer.ChaincodeAction): string {
  if (!action.hasChaincodeId()) fail("Chaincode action has no chaincode identity");
  const id = action.getChaincodeId();
  if (!id || id.getName().length === 0) fail("Chaincode action has no chaincode name");
  return id.getName();
}

function channelTimestamp(channelHeader: common.ChannelHeader, required: boolean): string {
  if (!channelHeader.hasTimestamp()) {
    if (required) fail("VALID Fabric transaction has no timestamp");
    return "";
  }
  const timestamp = channelHeader.getTimestamp();
  if (!timestamp) fail("Transaction timestamp is malformed");
  const seconds = timestamp.getSeconds();
  const nanos = timestamp.getNanos();
  if (!Number.isSafeInteger(seconds) || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) fail("Transaction timestamp is malformed");
  const date = new Date(seconds * 1000 + Math.trunc(nanos / 1_000_000));
  if (!Number.isFinite(date.getTime())) fail("Transaction timestamp is outside the supported range");
  if (nanos === 0) return date.toISOString();
  const fraction = String(nanos).padStart(9, "0").replace(/0+$/, "");
  return `${date.toISOString().slice(0, 19)}.${fraction}Z`;
}

function decodeTransaction(data: Uint8Array, index: number, validationCode: number, options: ProjectorTarget & { genesis: { config_version: string | number; membership_epoch: number; role_binding_version: number } }, genesisDigest: string): DecodedTransaction {
  const envelope = decode(common.Envelope, data);
  const payload = decode(common.Payload, bytes(envelope.getPayload_asU8()));
  const header = payload.hasHeader() ? payload.getHeader() : undefined;
  if (!header) fail("Transaction payload has no header");
  const channelHeader = decode(common.ChannelHeader, bytes(header.getChannelHeader_asU8()));
  const txId = channelHeader.getTxId();
  if (channelHeader.getChannelId() !== options.channel_id) fail("Fabric block contains a transaction for another channel");
  if (txId.length === 0 && channelHeader.getType() !== common.HeaderType.CONFIG) fail("Transaction has no transaction ID");
  const valid = validationCode === peer.TxValidationCode.VALID;
  const result: DecodedTransaction = { tx_id: txId, transaction_index: index, validation_code: validationCode, valid, writes: 0, writeset: [], timestamp: channelTimestamp(channelHeader, valid), header_type: channelHeader.getType() };
  if (!result.valid || channelHeader.getType() !== ENDORSER_TRANSACTION) return result;

  const transaction = decode(peer.Transaction, bytes(payload.getData_asU8()));
  const seenKeys = new Set<string>();
  let initialized = false;
  for (const transactionAction of transaction.getActionsList()) {
    const actionPayload = decode(peer.ChaincodeActionPayload, bytes(transactionAction.getPayload_asU8()));
    if (!actionPayload.hasAction()) fail("Endorser transaction has no chaincode action");
    const endorsed = actionPayload.getAction();
    if (!endorsed) fail("Endorser transaction has no chaincode action");
    const responsePayload = decode(peer.ProposalResponsePayload, bytes(endorsed.getProposalResponsePayload_asU8()));
    const action = decode(peer.ChaincodeAction, bytes(responsePayload.getExtension_asU8()));
    const actionChaincode = chaincodeName(action);
    if (actionChaincode !== options.chaincode_name && actionChaincode !== "_lifecycle") fail("Transaction targets an unexpected chaincode");
    const resultBytes = bytes(action.getResults_asU8());
    if (resultBytes.byteLength === 0) continue;
    const rwset = decode(ledger.rwset.TxReadWriteSet, resultBytes);
    if (rwset.getDataModel() !== ledger.rwset.TxReadWriteSet.DataModel.KV) fail("Unsupported Fabric state data model");
    if (actionChaincode === "_lifecycle") {
      if (rwset.getNsRwsetList().some(namespace => namespace.getNamespace() === options.chaincode_name)) fail("Lifecycle transaction contains a hidden Knowledger namespace");
      continue;
    }
    for (const namespace of rwset.getNsRwsetList()) {
      const targetNamespace = namespace.getNamespace() === options.chaincode_name;
      if (namespace.getCollectionHashedRwsetList().length > 0) fail("Private data hashes are not projectable");
      const rwsetBytes = bytes(namespace.getRwset_asU8());
      if (rwsetBytes.byteLength === 0) continue;
      const kv = decode(ledger.rwset.kvrwset.KVRWSet, rwsetBytes);
      if (kv.getMetadataWritesList().length > 0) fail("State metadata writes are not projectable");
      if (!targetNamespace && kv.getWritesList().length > 0) fail("Non-target namespace writes are not projectable");
      if (!targetNamespace) continue;
      for (const write of kv.getWritesList()) {
        const key = write.getKey();
        if (key.length === 0 || seenKeys.has(key) || write.getIsDelete()) fail("Delete or duplicate state write is not projectable");
        seenKeys.add(key);
        const value = bytes(write.getValue_asU8());
        if (value.byteLength === 0) fail("State write value is empty");
        if (key === FABRIC_INITIALIZED_KEY) {
          if (!equalBytes(value, Buffer.from(options.chaincode_version)) || action.getChaincodeId()?.getVersion() !== options.chaincode_version) fail("Fabric Init marker has an unexpected chaincode version");
          initialized = true;
          continue;
        }
        result.writeset.push({ key, value: valueForWrite(key, value, options.channel_id, genesisDigest, options.genesis) });
      }
    }
  }
  if (initialized && (!seenKeys.has(BOOTSTRAP_KEY) || !seenKeys.has("kcl:v1:config"))) fail("Fabric Init marker requires the pinned Knowledger bootstrap in the same transaction");
  result.writes = result.writeset.length;
  return result;
}

/**
 * Verifies and projects peer-delivered full blocks in memory. Durable cursor
 * storage, restart replay orchestration, and production catch-up supervision
 * remain outside this adapter. Rebuild from block zero after restart until
 * state and checkpoint can be persisted atomically by a hosting adapter.
 * The caller's authenticated peer/TLS delivery path remains responsible for
 * source authenticity; this class verifies block structure and VALID filters.
 */
export class FabricBlockProjector {
  readonly channel_id: string;
  readonly chaincode_name: string;
  readonly chaincode_version: string;
  private readonly options: FabricBlockProjectorOptions;
  private readonly genesisDigest: string;
  private readonly genesis: { config_version: string | number; membership_epoch: number; role_binding_version: number };
  private state = new Map<string, unknown>();
  private latestCheckpoint: ProjectorCheckpoint | null = null;

  constructor(options: FabricBlockProjectorOptions) {
    if (!options || typeof options.channel_id !== "string" || options.channel_id.length === 0 || typeof options.chaincode_name !== "string" || options.chaincode_name.length === 0 || options.public_genesis === undefined) {
      throw new Error("Projector requires channel, chaincode, and pinned public genesis");
    }
    if (!options.public_genesis || typeof options.public_genesis !== "object" || Array.isArray(options.public_genesis)) throw new Error("Pinned public genesis must be an object");
    const genesis = options.public_genesis as Record<string, unknown>;
    if ((typeof genesis.config_version !== "string" && typeof genesis.config_version !== "number") || !Number.isSafeInteger(genesis.membership_epoch) || !Number.isSafeInteger(genesis.role_binding_version)) throw new Error("Pinned public genesis versions are required");
    this.genesis = { config_version: genesis.config_version, membership_epoch: genesis.membership_epoch as number, role_binding_version: genesis.role_binding_version as number };
    this.channel_id = options.channel_id;
    this.chaincode_name = options.chaincode_name;
    this.chaincode_version = options.chaincode_version ?? "0.1.0";
    if (typeof this.chaincode_version !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(this.chaincode_version)) throw new Error("A fixed chaincode version is required");
    this.genesisDigest = sha256Digest(options.public_genesis);
    this.options = {
      channel_id: this.channel_id,
      chaincode_name: this.chaincode_name,
      chaincode_version: this.chaincode_version,
      public_genesis: clone(options.public_genesis),
    };
  }

  /** Create a candidate that shares no mutable state with this projector. */
  fork(): FabricBlockProjector {
    const candidate = new FabricBlockProjector(this.options);
    candidate.state = new Map([...this.state.entries()].map(([key, value]) => [key, clone(value)]));
    candidate.latestCheckpoint = this.latestCheckpoint ? { ...this.latestCheckpoint } : null;
    return candidate;
  }

  checkpoint(): ProjectorCheckpoint | null { return this.latestCheckpoint ? { ...this.latestCheckpoint } : null; }

  read(key: string): unknown | undefined {
    const value = this.state.get(key);
    return value === undefined ? undefined : clone(value);
  }

  entries(prefix = ""): [string, unknown][] {
    return [...this.state.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, clone(value)]);
  }

  applyBlock(serialized: Uint8Array): ProjectBlockResult {
    const block = decode(common.Block, serialized);
    if (!block.hasHeader() || !block.hasData() || !block.hasMetadata()) fail("Fabric block header, data, and metadata are required");
    const header = block.getHeader();
    const data = block.getData();
    const metadata = block.getMetadata();
    if (!header || !data || !metadata) fail("Fabric block header, data, and metadata are required");
    const blockNumber = header.getNumber();
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) fail("Fabric block number is outside the supported range");
    if (this.latestCheckpoint ? blockNumber !== this.latestCheckpoint.block_number + 1 : blockNumber !== 0) fail("Fabric block number is not contiguous");
    const dataEntries = data.getDataList_asU8().map(bytes);
    const expectedDataHash = Buffer.from(digest(Buffer.concat(dataEntries.map(entry => Buffer.from(entry)))), "hex");
    if (!equalBytes(expectedDataHash, bytes(header.getDataHash_asU8()))) fail("Fabric block data hash does not match");
    const previousHash = bytes(header.getPreviousHash_asU8());
    if (this.latestCheckpoint) {
      const expected = Buffer.from(this.latestCheckpoint.block_hash, "hex");
      if (!equalBytes(previousHash, expected)) fail("Fabric block previous hash does not match checkpoint");
    } else if (previousHash.byteLength !== 0) fail("Genesis Fabric block has a previous hash");
    const filter = metadata.getMetadataList_asU8()[2];
    if (!filter || filter.byteLength !== dataEntries.length) fail("Fabric transaction validation filter is missing or has the wrong length");

    const transactions: DecodedTransaction[] = [];
    const validTxIds = new Set<string>();
    for (let index = 0; index < dataEntries.length; index += 1) {
      const validationCode = filter[index] ?? 255;
      if (!SUPPORTED_VALIDATION_CODES.has(validationCode)) fail("Fabric transaction validation code is unknown or not final");
      const transaction = decodeTransaction(dataEntries[index], index, validationCode, { channel_id: this.channel_id, chaincode_name: this.chaincode_name, chaincode_version: this.chaincode_version, genesis: this.genesis }, this.genesisDigest);
      if (transaction.header_type !== common.HeaderType.ENDORSER_TRANSACTION && transaction.header_type !== common.HeaderType.CONFIG) fail("Unsupported Fabric transaction header type");
      if (transaction.header_type === common.HeaderType.CONFIG && blockNumber !== 0) fail("Configuration transactions after genesis are unsupported");
      if (transaction.valid && transaction.tx_id.length > 0) {
        if (validTxIds.has(transaction.tx_id)) fail("Fabric block contains duplicate VALID transaction IDs");
        validTxIds.add(transaction.tx_id);
      }
      transactions.push(transaction);
    }

    // 블록 검증이 끝나기 전까지 커밋 상태를 변경하지 않는다 — 쓰기분만
    // 스테이징하고 읽기는 기존 상태로 되돌아가는 오버레이로 원자성을 유지한다.
    // 전체 상태 복제는 블록마다 O(상태) 비용을 만든다.
    const stagedWrites = new Map<string, unknown>();
    const stagedGet = (key: string): unknown => stagedWrites.has(key) ? stagedWrites.get(key) : this.state.get(key);
    for (const transaction of transactions) {
      if (!transaction.valid) continue;
      for (const { key, value } of transaction.writeset) {
        const prior = stagedGet(key);
        const kind = key === BOOTSTRAP_KEY ? "bootstrap_manifest" : key.split(":")[2];
        if (prior !== undefined && (kind === "bootstrap_manifest" || IMMUTABLE_KINDS.has(kind)) && canonicalize(prior) !== canonicalize(value)) fail("Immutable ledger write-set was overwritten; projection halted");
        stagedWrites.set(key, clone(value));
      }
      for (const { key, value } of transaction.writeset) {
        if (key !== BOOTSTRAP_KEY) validateStateLinks(key, value, referenced => stagedGet(referenced));
      }
    }
    const checkpoint: ProjectorCheckpoint = { channel_id: this.channel_id, block_number: blockNumber, block_hash: fabricBlockHeaderHash(header), data_hash: digest(Buffer.concat(dataEntries.map(entry => Buffer.from(entry)))) };
    for (const [key, value] of stagedWrites) this.state.set(key, value);
    this.latestCheckpoint = checkpoint;
    return {
      checkpoint: { ...checkpoint },
      transactions: transactions.map(({ header_type: _headerType, ...transaction }) => ({ ...transaction, writeset: transaction.writeset.map(({ key, value }) => ({ key, value: clone(value) })) })),
      valid_transaction_ids: transactions.filter(transaction => transaction.valid).map(transaction => transaction.tx_id),
      invalid_transaction_ids: transactions.filter(transaction => !transaction.valid).map(transaction => transaction.tx_id),
    };
  }
}

export const PROJECTOR_BOOTSTRAP_KEY = BOOTSTRAP_KEY;
