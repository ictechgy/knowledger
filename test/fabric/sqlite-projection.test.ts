import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { digestPayload, keyFor, type DocumentRevision } from "../../packages/domain/index.ts";
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
  header.setDataHash(digest(Buffer.concat(entries.map(entry => Buffer.from(entry)))));
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

function revision(id: string, documentId = "doc-browse"): DocumentRevision {
  const payload = {
    contract_type: "DocumentRevision" as const,
    contract_version: 1 as const,
    revision_id: id,
    channel_id: channel,
    document_id: documentId,
    context_id: "context-browse",
    scope_id: "scope-browse",
    usage_scope: "domain-definition/v1",
    visibility: "shared_channel" as const,
    title: id,
    body_markdown: `# ${id}`,
    parents: [],
    dependencies: [],
    metadata: {
      author_id: "person-browse",
      author_org_id: "OrgBrowse",
      created_at: "2026-09-16T00:00:00.000Z",
      source_kind: "human_authored" as const,
      shared_assertions: [],
    },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function transactionCheckpoint(result: { checkpoint: Pick<Checkpoint, "channel_id" | "block_number" | "block_hash"> }, transactionIndex: number, transactionId: string): Checkpoint {
  return { channel_id: result.checkpoint.channel_id, block_number: result.checkpoint.block_number,
    transaction_index: transactionIndex, transaction_id: transactionId, block_hash: result.checkpoint.block_hash };
}

test("persists exact transaction fences, restart state, and VALID-only receipts/events", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
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

test("publishes only verified VALID browse metadata after durable commit and rebuilds it on restart", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-browse-index-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = revision("revision-fabric-first");
    const second = revision("revision-fabric-second", "doc-fabric-second");
    const ignored = revision("revision-fabric-invalid", "doc-fabric-invalid");
    let projection = new SqliteFabricProjection(path, options);

    // The first block has two transactions.  A checkpoint at tx 0 must not
    // expose metadata written by tx 1, and the ref must carry that exact tx.
    const firstBlock = block(0, [
      transaction("tx-fabric-revision-first", keyFor.revision(first.revision_digest), first),
      transaction("tx-fabric-fence-first", fence("fabric-browse-first").key, fence("fabric-browse-first").value),
    ]);
    const firstResult = projection.applyBlock(firstBlock);
    const firstTx = transactionCheckpoint(firstResult, 0, "tx-fabric-revision-first");
    const firstPage = projection.queryBrowse({ kind: "revisions", mode: "all", at: firstTx, offset: 0, limit: 10 });
    assert.equal(firstPage.total, 1);
    assert.equal(firstPage.items[0]?.revision_digest, first.revision_digest);
    assert.deepEqual(firstPage.items[0]?.published_checkpoint, firstTx);

    // An invalid transaction can contain arbitrary bytes, but it must never
    // become a browse ref.  Appending the same block again is idempotent.
    const prior = projection.blockCheckpoint()!;
    const invalidBlock = block(1, [
      transaction("tx-fabric-invalid", keyFor.revision(ignored.revision_digest), ignored),
      transaction("tx-fabric-fence-second", fence("fabric-browse-second").key, fence("fabric-browse-second").value),
    ], Buffer.from(prior.block_hash, "hex"), [11, 0]);
    projection.applyBlock(invalidBlock);
    projection.applyBlock(invalidBlock);
    const invalidPage = projection.queryBrowse({ kind: "revisions", mode: "all", at: projection.checkpoint()!, offset: 0, limit: 10 });
    assert.deepEqual(invalidPage.items.map(item => item.revision_digest), [first.revision_digest]);

    // The index is prepared before SQL COMMIT but committed only afterward.
    // A trigger failure must leave both durable state and browse metadata at
    // the previous checkpoint.
    const beforeFailure = projection.checkpoint()!;
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_browse_projection BEFORE INSERT ON fabric_projection_history BEGIN SELECT RAISE(ABORT, 'browse index rollback'); END");
    const next = block(2, [transaction("tx-fabric-revision-second", keyFor.revision(second.revision_digest), second)], Buffer.from(beforeFailure.block_hash, "hex"));
    assert.throws(() => projection.applyBlock(next), /browse index rollback/);
    assert.deepEqual(projection.checkpoint(), beforeFailure);
    assert.equal(projection.queryBrowse({ kind: "revisions", mode: "all", at: beforeFailure, offset: 0, limit: 10 }).total, 1);
    db.exec("DROP TRIGGER fail_browse_projection");
    db.close();

    projection.applyBlock(next);
    const secondCheckpoint = projection.checkpoint()!;
    const secondPage = projection.queryBrowse({ kind: "revisions", mode: "all", at: secondCheckpoint, offset: 0, limit: 10 });
    assert.deepEqual(secondPage.items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
    projection.close();

    projection = new SqliteFabricProjection(path, options);
    assert.deepEqual(projection.queryBrowse({ kind: "revisions", mode: "all", at: secondCheckpoint, offset: 0, limit: 10 }), secondPage);

    // The browse index is an optimization.  A forged derived SQL row must be
    // rejected by the canonical projection read used for the selected ref.
    const tamper = new DatabaseSync(path);
    tamper.prepare("UPDATE fabric_projection_state SET value_json = ? WHERE state_key = ?")
      .run(JSON.stringify({ forged: true }), keyFor.revision(second.revision_digest));
    tamper.close();
    assert.throws(() => projection.read(keyFor.revision(second.revision_digest)), /integrity/);
    projection.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps browse metadata available at an empty full-block checkpoint", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-browse-empty-");
  const path = join(directory, "projection.sqlite");
  try {
    const value = revision("revision-fabric-before-empty");
    const projection = new SqliteFabricProjection(path, options);
    const first = projection.applyBlock(block(0, [transaction("tx-fabric-before-empty", keyFor.revision(value.revision_digest), value)]));
    const empty = block(1, [], Buffer.from(first.checkpoint.block_hash, "hex"));
    projection.applyBlock(empty);
    const at = projection.checkpoint()!;
    assert.equal(at.block_number, 1);
    assert.equal(at.transaction_index, -1);
    assert.equal(at.transaction_id, "");
    const page = projection.queryBrowse({ kind: "revisions", mode: "all", at, offset: 0, limit: 10 });
    assert.deepEqual(page.items.map(item => item.revision_digest), [value.revision_digest]);
    projection.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rolls back raw journal, materialized state, and cursor on SQL failure", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
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
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
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
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
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
    assert.deepEqual(projection.read(first.key, checkpoint), first.value);
    db.prepare("UPDATE fabric_projection_history SET value_json = ? WHERE state_key = ?").run(JSON.stringify({ forged: true }), first.key);
    assert.throws(() => projection.read(first.key, checkpoint), /integrity check/);
    db.prepare("UPDATE fabric_projection_state_creation SET value_json = ? WHERE state_key = ?").run(JSON.stringify({ forged: true }), first.key);
    assert.throws(() => projection.checkpointForStateCreation(first.key), /state creation integrity/);
    db.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("anchors state creation to the first verified VALID write", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const key = keyFor.eligibilityEpoch();
    const projection = new SqliteFabricProjection(path, options);
    const first = projection.applyBlock(block(0, [transaction("tx-create", key, 0)]));
    projection.applyBlock(block(1, [transaction("tx-update", key, 1)], Buffer.from(first.checkpoint.block_hash, "hex")));
    const db = new DatabaseSync(path);
    const created = db.prepare(`SELECT block_number, transaction_index, transaction_id, block_hash, value_json
      FROM fabric_projection_history WHERE state_key = ? AND block_number = 0`).get(key) as any;
    const updated = db.prepare(`SELECT block_number, transaction_index, transaction_id, block_hash, value_json
      FROM fabric_projection_history WHERE state_key = ? AND block_number = 1`).get(key) as any;

    db.prepare(`UPDATE fabric_projection_state_creation SET block_number = ?, transaction_index = ?,
      transaction_id = ?, block_hash = ?, value_json = ? WHERE state_key = ?`)
      .run(updated.block_number, updated.transaction_index, updated.transaction_id, updated.block_hash, updated.value_json, key);
    assert.throws(() => projection.checkpointForStateCreation(key), /state creation integrity/);

    db.prepare(`UPDATE fabric_projection_state_creation SET block_number = ?, transaction_index = ?,
      transaction_id = ?, block_hash = ?, value_json = ? WHERE state_key = ?`)
      .run(created.block_number, created.transaction_index, created.transaction_id, created.block_hash, JSON.stringify(99), key);
    db.prepare("UPDATE fabric_raw_transactions SET writes_json = ? WHERE block_number = 0 AND transaction_index = 0")
      .run(JSON.stringify([{ key, value: 99 }]));
    assert.throws(() => projection.checkpointForStateCreation(key), /state creation integrity|transaction index integrity/);
    db.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("treats the transaction table as an untrusted receipt locator", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("locator-123456");
    const projection = new SqliteFabricProjection(path, options);
    projection.applyBlock(block(0, [transaction("tx-locator", first.key, first.value)]));
    const db = new DatabaseSync(path);
    db.prepare("UPDATE fabric_raw_transactions SET transaction_id = ? WHERE block_number = 0 AND transaction_index = 0").run("tx-forged-locator");
    assert.throws(() => projection.checkpointForTransaction("tx-forged-locator"), /transaction index integrity/);
    assert.throws(() => projection.checkpointForTransaction("tx-locator"), /transaction index integrity/);
    db.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("anchors live creation and receipt proofs to the verified raw block bytes", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("raw-anchor-12345");
    const projection = new SqliteFabricProjection(path, options);
    const serialized = block(0, [transaction("tx-raw-anchor", first.key, first.value)]);
    projection.applyBlock(serialized);
    assert.equal(projection.checkpointForTransaction("tx-raw-anchor").transaction_id, "tx-raw-anchor");
    const tampered = Buffer.from(serialized);
    tampered[tampered.length - 1] ^= 1;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE fabric_raw_blocks SET block_bytes = ?, raw_digest = ? WHERE block_number = 0")
      .run(tampered, createHash("sha256").update(tampered).digest("hex"));
    assert.throws(() => projection.checkpointForStateCreation(first.key), /raw block digest|journal metadata/);
    assert.throws(() => projection.checkpointForTransaction("tx-raw-anchor"), /raw block digest|journal metadata/);
    db.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("cold history rejects changed VALID metadata even when later writes restore the same final state", { skip: !available }, () => {
  const directory = mkdtempSync('/tmp/knowledger-fabric-history-anchor-'); const path = join(directory, 'projection.sqlite');
  const projection = new SqliteFabricProjection(path, options); const key = keyFor.eligibilityEpoch();
  try {
    const first = projection.applyBlock(block(0, [transaction('tx-anchor-first', key, 0)]));
    const rejected = block(1, [transaction('tx-anchor-invalid', key, 1)], Buffer.from(first.checkpoint.block_hash, 'hex'), [11]);
    const middle = projection.applyBlock(rejected);
    projection.applyBlock(block(2, [transaction('tx-anchor-final', key, 2)], Buffer.from(middle.checkpoint.block_hash, 'hex')));
    const at = { ...middle.checkpoint, transaction_index: 0, transaction_id: 'tx-anchor-invalid' };
    const forged = block(1, [transaction('tx-anchor-invalid', key, 1)], Buffer.from(first.checkpoint.block_hash, 'hex'), [0]);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE fabric_raw_blocks SET block_bytes = ?, raw_digest = ? WHERE block_number = 1').run(Buffer.from(forged), createHash('sha256').update(forged).digest('hex'));
    db.prepare('UPDATE fabric_raw_transactions SET valid = 1, validation_code = 0, writes_json = ? WHERE block_number = 1').run(JSON.stringify([{ key, value: 1 }]));
    db.prepare('INSERT INTO fabric_projection_history VALUES (?, 1, 0, ?, ?, ?)').run(key, at.transaction_id, at.block_hash, '1');
    db.close();
    assert.throws(() => projection.read(key, at), /journal|digest|integrity/);
    assert.throws(() => projection.events(0), /journal|digest|integrity/);
  } finally { projection.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("rebuilds the additive state creation index on restart", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const first = fence("migration-12345");
    let projection = new SqliteFabricProjection(path, options);
    projection.applyBlock(block(0, [transaction("tx-migration", first.key, first.value)]));
    projection.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE fabric_projection_state_creation");
    db.close();
    projection = new SqliteFabricProjection(path, options);
    assert.equal(projection.checkpointForStateCreation(first.key).transaction_id, "tx-migration");
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("raw digest detects a VALID filter mutation and append preserves old history", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
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

test("streams a long raw journal while preserving point-in-time reads", { skip: !available }, (t) => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-");
  const path = join(directory, "projection.sqlite");
  try {
    const projection = new SqliteFabricProjection(path, options);
    const key = keyFor.eligibilityEpoch();
    let previousHash = new Uint8Array();
    let firstCheckpoint: Checkpoint | undefined;
    let middleCheckpoint: Checkpoint | undefined;
    for (let index = 0; index < 512; index += 1) {
      const serialized = block(index, [transaction(`tx-long-${index}`, key, index)], previousHash);
      const result = projection.applyBlock(serialized);
      previousHash = Buffer.from(result.checkpoint.block_hash, "hex");
      if (!firstCheckpoint) firstCheckpoint = { ...result.checkpoint, transaction_index: 0, transaction_id: `tx-long-${index}` };
      if (index === 256) middleCheckpoint = { ...result.checkpoint, transaction_index: 0, transaction_id: `tx-long-${index}` };
    }
    assert.equal(projection.read(key, firstCheckpoint), 0);
    assert.equal(projection.read(key, middleCheckpoint), 256);
    assert.equal(projection.read(key), 511);
    const currentReadStart = performance.now();
    for (let index = 0; index < 16; index += 1) assert.equal(projection.read(key), 511);
    const currentReadMs = performance.now() - currentReadStart;
    const currentCheckpoint = projection.checkpoint()!;
    assert.equal(projection.read(key, currentCheckpoint), 511);
    assert.equal(projection.checkpointForStateCreation(key).block_number, 0);
    const collectGarbage = (globalThis as typeof globalThis & { gc?: () => void }).gc;
    collectGarbage?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const repeatedStart = performance.now();
    for (let index = 0; index < 16; index += 1) assert.equal(projection.read(key, middleCheckpoint), 256);
    const repeatedMs = performance.now() - repeatedStart;
    collectGarbage?.();
    const heapAfter = process.memoryUsage().heapUsed;
    t.diagnostic(JSON.stringify({ blocks: 512, repeated_current_reads: 16, current_read_ms: Number(currentReadMs.toFixed(3)), repeated_historical_reads: 16, historical_read_ms: Number(repeatedMs.toFixed(3)), heap_before: heapBefore, heap_after: heapAfter, heap_delta: heapAfter - heapBefore }));
    assert.equal(projection.entries("kcl:v1:eligibility_epoch", middleCheckpoint)[0]?.[1], 256);
    const receiptColdStart = performance.now();
    assert.equal(projection.checkpointForTransaction("tx-long-256").block_number, 256);
    const receiptColdMs = performance.now() - receiptColdStart;
    const receiptWarmStart = performance.now();
    for (let index = 0; index < 16; index += 1) assert.equal(projection.checkpointForTransaction("tx-long-256").block_number, 256);
    const receiptWarmMs = performance.now() - receiptWarmStart;
    t.diagnostic(JSON.stringify({ blocks: 512, receipt_cold_ms: Number(receiptColdMs.toFixed(3)), repeated_receipts: 16, receipt_warm_ms: Number(receiptWarmMs.toFixed(3)) }));
    projection.close();

    const restartStart = performance.now();
    const restarted = new SqliteFabricProjection(path, options);
    const restartMs = performance.now() - restartStart;
    assert.equal(restarted.read(key), 511);
    assert.equal(restarted.read(key, middleCheckpoint), 256);
    assert.equal(restarted.checkpointForStateCreation(key).block_number, 0);
    t.diagnostic(JSON.stringify({ blocks: 512, verified_restart_ms: Number(restartMs.toFixed(3)) }));
    restarted.close();
    const db = new DatabaseSync(path);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM fabric_raw_blocks").get() as any).count, 512);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM fabric_projection_history").get() as any).count, 512);
    db.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("does not retain padded raw block history in process memory", { skip: !available || typeof globalThis.gc !== "function" }, async (t) => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-projection-memory-");
  const path = join(directory, "projection.sqlite");
  try {
    const projection = new SqliteFabricProjection(path, options);
    const key = keyFor.eligibilityEpoch();
    const padding = "x".repeat(64 * 1024);
    let previousHash = new Uint8Array();
    let rawBytesAfter64 = 0;
    let memoryAfter64 = process.memoryUsage();
    let appendedRawBytes = 0;
    for (let index = 0; index < 512; index += 1) {
      const valid = transaction(`tx-memory-valid-${index}`, key, index);
      const invalid = transaction(`tx-memory-invalid-${index}`, `kcl:v1:ignored:memory-${index}`, { padding });
      const serialized = block(index, [valid, invalid], previousHash, [0, 11]);
      const result = projection.applyBlock(serialized);
      previousHash = Buffer.from(result.checkpoint.block_hash, "hex");
      if (index < 64) rawBytesAfter64 += serialized.byteLength;
      else appendedRawBytes += serialized.byteLength;
      if (index === 63) {
        for (let cycle = 0; cycle < 3; cycle += 1) {
          globalThis.gc!();
          await new Promise(resolve => setImmediate(resolve));
        }
        memoryAfter64 = process.memoryUsage();
      }
    }
    for (let cycle = 0; cycle < 3; cycle += 1) {
      globalThis.gc!();
      await new Promise(resolve => setImmediate(resolve));
    }
    const memoryAfter512 = process.memoryUsage();
    const retainedGrowth = Math.max(0, memoryAfter512.arrayBuffers - memoryAfter64.arrayBuffers);
    t.diagnostic(JSON.stringify({
      blocks_initial: 64,
      blocks_final: 512,
      raw_bytes_initial: rawBytesAfter64,
      raw_bytes_appended: appendedRawBytes,
      heap_growth: memoryAfter512.heapUsed - memoryAfter64.heapUsed,
      external_growth: memoryAfter512.external - memoryAfter64.external,
      array_buffers_initial: memoryAfter64.arrayBuffers,
      array_buffers_final: memoryAfter512.arrayBuffers,
      array_buffers_growth: retainedGrowth,
    }));
    assert.ok(retainedGrowth < appendedRawBytes / 3, `retained ${retainedGrowth} of ${appendedRawBytes} appended raw bytes`);
    assert.equal(projection.read(key), 511);
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("readMany matches per-key read for current and historical checkpoints and detects tampering", { skip: !available }, () => {
  const directory = mkdtempSync("/tmp/knowledger-fabric-readmany-");
  const path = join(directory, "projection.sqlite");
  try {
    const projection = new SqliteFabricProjection(path, options);
    const first = fence("readmany-first");
    const second = fence("readmany-second");
    const third = fence("readmany-third");
    const epochKey = keyFor.eligibilityEpoch();
    const firstResult = projection.applyBlock(block(0, [transaction("tx-rm-first", first.key, first.value), transaction("tx-rm-second", second.key, second.value), transaction("tx-rm-epoch", epochKey, 1)]));
    const middle = transactionCheckpoint(firstResult, 2, "tx-rm-epoch");
    const prior = projection.blockCheckpoint()!;
    projection.applyBlock(block(1, [transaction("tx-rm-third", epochKey, 2), transaction("tx-rm-fourth", third.key, third.value)], Buffer.from(prior.block_hash, "hex")));

    // 현재 커서: read()와 동일한 값 집합을 반환하고 부재 키는 생략한다.
    const current = projection.readMany([first.key, second.key, third.key, epochKey, "kcl:v1:fence:missing", first.key]);
    assert.equal(current.size, 4);
    assert.deepEqual(current.get(first.key), first.value);
    assert.deepEqual(current.get(second.key), second.value);
    assert.deepEqual(current.get(third.key), third.value);
    assert.equal(current.get(epochKey), 2);
    assert.equal(current.has("kcl:v1:fence:missing"), false);
    assert.equal(projection.readMany([]).size, 0);

    // 과거 체크포인트: replay 경로가 시점별 값과 부재를 재현한다.
    const historical = projection.readMany([first.key, second.key, third.key, epochKey], middle);
    assert.deepEqual(historical.get(first.key), first.value);
    assert.deepEqual(historical.get(second.key), second.value);
    assert.equal(historical.get(epochKey), 1);
    assert.equal(historical.has(third.key), false);

    // 500키 바인드 청크 경계를 넘는 묶음도 같은 규칙을 유지한다.
    const bulk: { key: string; value: unknown }[] = [];
    const entries: Uint8Array[] = [];
    for (let index = 0; index < 600; index += 1) {
      const item = fence(`bulk-${String(index).padStart(8, '0')}`);
      bulk.push(item);
      entries.push(transaction(`tx-rm-bulk-${index}`, item.key, item.value));
    }
    projection.applyBlock(block(2, entries, Buffer.from(projection.blockCheckpoint()!.block_hash, "hex")));
    const wide = projection.readMany(bulk.map(item => item.key));
    assert.equal(wide.size, 600);
    for (const item of bulk) assert.deepEqual(wide.get(item.key), item.value);

    // 파생 테이블이 세션 중에 변조되면 read()와 마찬가지로 readMany도 탐지한다.
    // (재시작 시 파생 테이블은 raw 블록에서 재구축되므로 열린 상태에서 시험한다.)
    const other = new DatabaseSync(path);
    other.prepare("UPDATE fabric_projection_state SET value_json = ? WHERE state_key = ?").run(JSON.stringify({ tampered: true }), first.key);
    assert.throws(() => projection.readMany([first.key]), /integrity check failed/i);
    other.close();
    projection.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
