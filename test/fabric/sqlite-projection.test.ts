import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { keyFor } from "../../packages/domain/index.ts";
import type { Checkpoint } from "../../packages/storage/local-ledger.ts";

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));
let available = true;
let protos: any;
try { protos = await import(requireFabric.resolve("@hyperledger/fabric-protos")); }
catch (error) {
  const missing = error as NodeJS.ErrnoException;
  if (missing.code !== "MODULE_NOT_FOUND" || !missing.message.includes("@hyperledger/fabric-protos")) throw error;
  available = false;
}
const Timestamp = available ? requireFabric("google-protobuf/google/protobuf/timestamp_pb.js").Timestamp : undefined;
const { SqliteFabricProjection } = available ? await import("../../packages/fabric/sqlite-projection.ts") : { SqliteFabricProjection: undefined };

const channel = "kcl-demo";
const chaincode = "kcl";
const genesis = { channel_id: channel, config_version: "cfg-1", membership_epoch: 1, role_binding_version: 1 };
const options = { channel_id: channel, chaincode_name: chaincode, public_genesis: genesis };

function digest(value: Uint8Array): Uint8Array { return createHash("sha256").update(value).digest(); }

function transaction(txId: string, key: string, value: unknown): Uint8Array {
  const { common, ledger, peer } = protos;
  const channelHeader = new common.ChannelHeader();
  channelHeader.setType(common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(channel);
  channelHeader.setTxId(txId);
  const timestamp = new Timestamp();
  timestamp.setSeconds(1_789_430_400);
  timestamp.setNanos(123_000_000);
  channelHeader.setTimestamp(timestamp);
  const header = new common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  const kv = new ledger.rwset.kvrwset.KVRWSet();
  const write = new ledger.rwset.kvrwset.KVWrite();
  write.setKey(key);
  write.setValue(Buffer.from(JSON.stringify(value)));
  kv.getWritesList().push(write);
  const namespace = new ledger.rwset.NsReadWriteSet();
  namespace.setNamespace(chaincode);
  namespace.setRwset(kv.serializeBinary());
  const rwset = new ledger.rwset.TxReadWriteSet();
  rwset.getNsRwsetList().push(namespace);
  const id = new peer.ChaincodeID();
  id.setName(chaincode);
  id.setVersion("0.1.0");
  const action = new peer.ChaincodeAction();
  action.setChaincodeId(id);
  action.setResults(rwset.serializeBinary());
  const response = new peer.ProposalResponsePayload();
  response.setExtension$(action.serializeBinary());
  const endorsed = new peer.ChaincodeEndorsedAction();
  endorsed.setProposalResponsePayload(response.serializeBinary());
  const payload = new peer.ChaincodeActionPayload();
  payload.setAction(endorsed);
  const actionEntry = new peer.TransactionAction();
  actionEntry.setPayload(payload.serializeBinary());
  const tx = new peer.Transaction();
  tx.getActionsList().push(actionEntry);
  const body = new common.Payload();
  body.setHeader(header);
  body.setData(tx.serializeBinary());
  const envelope = new common.Envelope();
  envelope.setPayload(body.serializeBinary());
  return envelope.serializeBinary();
}

function block(number: number, entries: Uint8Array[], previousHash = new Uint8Array(), filter = entries.map(() => 0)): Uint8Array {
  const { common } = protos;
  const data = new common.BlockData();
  data.setDataList(entries);
  const header = new common.BlockHeader();
  header.setNumber(number);
  header.setPreviousHash(previousHash);
  header.setDataHash(digest(new Uint8Array(entries.flatMap(entry => [...entry]))));
  const metadata = new common.BlockMetadata();
  metadata.setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.from(filter)]);
  const result = new common.Block();
  result.setHeader(header);
  result.setData(data);
  result.setMetadata(metadata);
  return result.serializeBinary();
}

function fence(suffix: string): { key: string; value: unknown } {
  const nonce = `nonce-${suffix}`;
  return { key: keyFor.fence(nonce), value: { nonce, eligibility_epoch: 0, tx_id: `tx-${suffix}` } };
}

test("persists exact transaction fences, restart state, and VALID-only receipts/events", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/kcl-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("first-123456");
    const second = fence("second-12345");
    let projection = new SqliteFabricProjection(path, options);
    const firstBlock = block(0, [transaction("tx-first", first.key, first.value), transaction("tx-second", second.key, second.value)]);
    const firstResult = projection.applyBlock(firstBlock);
    const firstFence = firstResult.transactions[0];
    const checkpoint: Checkpoint = { ...firstResult.checkpoint, transaction_index: firstFence.transaction_index, transaction_id: firstFence.tx_id };
    assert.equal(projection.read(second.key, checkpoint), undefined);
    assert.deepEqual(projection.read(second.key), second.value);
    const blockCheckpoint = projection.blockCheckpoint();
    assert.equal(blockCheckpoint?.block_number, 0);
    projection.close();

    projection = new SqliteFabricProjection(path, options);
    assert.deepEqual(projection.read(second.key), second.value);
    assert.deepEqual(projection.checkpointForTransaction("tx-first").transaction_id, "tx-first");
    assert.deepEqual(projection.checkpointForStateCreation(second.key).transaction_id, "tx-second");
    const third = fence("third-12345");
    const prior = projection.blockCheckpoint()!;
    const secondBlock = block(1, [transaction("tx-duplicate", "kcl:v1:ignored:invalid", { ignored: true }), transaction("tx-duplicate", third.key, third.value)], Buffer.from(prior.block_hash, "hex"), [11, 0]);
    projection.applyBlock(secondBlock);
    assert.equal(projection.entries("", { ...prior, transaction_index: 0, transaction_id: "tx-first" }).some(([key]) => key === third.key), false);
    assert.equal(projection.read(third.key, projection.checkpointForTransaction("tx-duplicate"))?.tx_id, "tx-third-12345");
    assert.equal(projection.events(0, 1).length, 1);
    assert.equal(projection.checkpoint()?.transaction_index, 1);
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rolls back raw journal, materialized state, and cursor on SQL failure", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/kcl-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("first-123456");
    const second = fence("second-12345");
    const projection = new SqliteFabricProjection(path, options);
    projection.applyBlock(block(0, [transaction("tx-first", first.key, first.value)]));
    const before = projection.checkpoint();
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_projection_history BEFORE INSERT ON fabric_projection_history BEGIN SELECT RAISE(ABORT, 'test write failure'); END");
    const next = block(1, [transaction("tx-second", second.key, second.value)], Buffer.from(before!.block_hash, "hex"));
    assert.throws(() => projection.applyBlock(next), /test write failure/);
    assert.deepEqual(projection.checkpoint(), before);
    assert.equal(projection.read(second.key), undefined);
    db.exec("DROP TRIGGER fail_projection_history");
    db.close();
    projection.close();
    const restarted = new SqliteFabricProjection(path, options);
    assert.deepEqual(restarted.checkpoint(), before);
    restarted.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects wrong bindings, forged checkpoints, and corrupted raw journals", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/kcl-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("first-123456");
    let projection = new SqliteFabricProjection(path, options);
    projection.applyBlock(block(0, [transaction("tx-first", first.key, first.value)]));
    const known = projection.checkpoint()!;
    assert.throws(() => projection.assertCheckpoint({ ...known, transaction_id: "forged" }), /Untrusted checkpoint/);
    assert.throws(() => new SqliteFabricProjection(path, { ...options, chaincode_name: "other" }), /binding mismatch/);
    projection.close();
    const db = new DatabaseSync(path);
    db.prepare("UPDATE fabric_raw_blocks SET block_bytes = ? WHERE block_number = 0").run(Buffer.from("corrupted"));
    db.close();
    assert.throws(() => new SqliteFabricProjection(path, options), /Malformed Fabric block|raw block/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("rejects tampered derived latest and historical caches", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/kcl-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("first-123456");
    const projection = new SqliteFabricProjection(path, options);
    const result = projection.applyBlock(block(0, [transaction("tx-first", first.key, first.value)]));
    const checkpoint: Checkpoint = { ...result.checkpoint, transaction_index: 0, transaction_id: "tx-first" };
    const db = new DatabaseSync(path);
    db.prepare("UPDATE fabric_projection_cursor SET block_hash = ? WHERE singleton = 1").run("f".repeat(64));
    assert.throws(() => projection.read(first.key), /cursor integrity/);
    assert.throws(() => projection.checkpointForTransaction("tx-first"), /cursor integrity/);
    db.prepare("UPDATE fabric_projection_cursor SET block_hash = ? WHERE singleton = 1").run(result.checkpoint.block_hash);
    db.prepare("UPDATE fabric_projection_state SET value_json = ? WHERE state_key = ?").run(JSON.stringify({ forged: true }), first.key);
    assert.throws(() => projection.read(first.key), /integrity check/);
    db.prepare("UPDATE fabric_projection_state SET value_json = ? WHERE state_key = ?").run(JSON.stringify(first.value), first.key);
    db.prepare("UPDATE fabric_projection_history SET value_json = ? WHERE state_key = ?").run(JSON.stringify({ forged: true }), first.key);
    assert.throws(() => projection.read(first.key, checkpoint), /integrity check/);
    db.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("raw digest detects a VALID filter mutation and append preserves old history", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/kcl-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("first-123456");
    const second = fence("second-12345");
    const projection = new SqliteFabricProjection(path, options);
    const firstBlock = block(0, [transaction("tx-first", first.key, first.value)]);
    const firstResult = projection.applyBlock(firstBlock);
    const prior = projection.blockCheckpoint()!;
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER no_history_delete BEFORE DELETE ON fabric_projection_history BEGIN SELECT RAISE(ABORT, 'append deleted history'); END");
    const secondBlock = block(1, [transaction("tx-second", second.key, second.value)], Buffer.from(prior.block_hash, "hex"));
    projection.applyBlock(secondBlock);
    assert.deepEqual(projection.read(first.key), first.value);
    db.exec("DROP TRIGGER no_history_delete");
    db.prepare("UPDATE fabric_raw_blocks SET block_bytes = ? WHERE block_number = 0").run(Buffer.from(firstBlock).map((value, index) => index === Buffer.from(firstBlock).length - 1 ? value ^ 1 : value));
    db.close();
    projection.close();
    assert.throws(() => new SqliteFabricProjection(path, options), /raw block digest|Malformed Fabric block|journal metadata/);
    void firstResult;
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
