import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { bootstrap, execute, keyFor, resolveAt } from "../../packages/domain/index.ts";
import { actorIdentity, demoFixtures, PERSONAS } from "../../apps/api/demo-config.ts";
import { sha256Digest } from "../../packages/fabric/canonical.ts";

const requireFabric = createRequire(new URL("../../packages/fabric/package.json", import.meta.url));
let fabricProtosAvailable = false;
let fabricProtosPath = "";
try { fabricProtosPath = requireFabric.resolve("@hyperledger/fabric-protos"); fabricProtosAvailable = true; }
catch (error) {
  const missing = error as NodeJS.ErrnoException;
  if (missing.code !== "MODULE_NOT_FOUND" || !missing.message.startsWith("Cannot find module '@hyperledger/fabric-protos'")) throw error;
}
const { common, ledger, peer } = fabricProtosAvailable ? await import(fabricProtosPath) : { common: undefined, ledger: undefined, peer: undefined };
const { FabricBlockProjector, fabricBlockHeaderHash } = fabricProtosAvailable ? await import("../../packages/fabric/block-projector.ts") : { FabricBlockProjector: undefined, fabricBlockHeaderHash: undefined };

const channel = "kcl-demo";
const chaincode = "kcl";
const genesis = { channel_id: channel, config_version: "cfg-1", membership_epoch: 1, role_binding_version: 1 };

function hash(value: Uint8Array): Uint8Array { return createHash("sha256").update(value).digest(); }

type Tx = { txId: string; validationCode?: number; writes?: Array<{ key: string; value: unknown; delete?: boolean }>; channelId?: string; chaincodeName?: string; namespace?: string };

async function runEngine(store: Map<string, unknown>, actor: { org_id: string; actor_id: string; kind: "human" | "agent" }, txId: string, command: { command_id: string; type: string; input: unknown }): Promise<Array<{ key: string; value: unknown }>> {
  const writes = new Map<string, unknown>();
  const context = {
    actor,
    channel_id: channel,
    tx_id: txId,
    timestamp: "2026-09-15T00:00:00Z",
    async get(key: string) { return writes.has(key) ? writes.get(key) : store.get(key); },
    async put(key: string, value: unknown) { writes.set(key, structuredClone(value)); },
  };
  await execute(context, command);
  for (const [key, value] of writes) store.set(key, structuredClone(value));
  return [...writes.entries()].map(([key, value]) => ({ key, value }));
}

async function runBootstrap(store: Map<string, unknown>, config: unknown): Promise<Array<{ key: string; value: unknown }>> {
  const writes = new Map<string, unknown>();
  const context = {
    actor: actorIdentity(PERSONAS[1]), channel_id: channel, tx_id: "tx-bootstrap-engine", timestamp: "2026-09-15T00:00:00Z",
    async get(key: string) { return writes.has(key) ? writes.get(key) : store.get(key); },
    async put(key: string, value: unknown) { writes.set(key, structuredClone(value)); },
  };
  const result = await bootstrap(context, config);
  for (const [key, value] of writes) store.set(key, structuredClone(value));
  writes.set("kcl:v1:bootstrap_manifest", { payload_digest: sha256Digest(config), result });
  return [...writes.entries()].map(([key, value]) => ({ key, value }));
}

function transaction(input: Tx): Uint8Array {
  const channelHeader = new common.ChannelHeader();
  channelHeader.setType(common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(input.channelId ?? channel);
  channelHeader.setTxId(input.txId);
  const header = new common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  const transaction = new peer.Transaction();
  if (input.writes) {
    const kv = new ledger.rwset.kvrwset.KVRWSet();
    for (const item of input.writes) {
      const write = new ledger.rwset.kvrwset.KVWrite();
      write.setKey(item.key);
      write.setIsDelete(item.delete ?? false);
      write.setValue(new TextEncoder().encode(JSON.stringify(item.value)));
      kv.getWritesList().push(write);
    }
    if (input.writes.length === 0) {
      const read = new ledger.rwset.kvrwset.KVRead();
      read.setKey("read-only-key");
      kv.getReadsList().push(read);
    }
    const namespace = new ledger.rwset.NsReadWriteSet();
    namespace.setNamespace(input.namespace ?? input.chaincodeName ?? chaincode);
    namespace.setRwset(kv.serializeBinary());
    const rwset = new ledger.rwset.TxReadWriteSet();
    rwset.getNsRwsetList().push(namespace);
    const action = new peer.ChaincodeAction();
    const chaincodeId = new peer.ChaincodeID();
    chaincodeId.setName(input.chaincodeName ?? chaincode);
    action.setChaincodeId(chaincodeId);
    action.setResults(rwset.serializeBinary());
    const response = new peer.ProposalResponsePayload();
    response.setExtension$(action.serializeBinary());
    const endorsed = new peer.ChaincodeEndorsedAction();
    endorsed.setProposalResponsePayload(response.serializeBinary());
    const payload = new peer.ChaincodeActionPayload();
    payload.setAction(endorsed);
    const txAction = new peer.TransactionAction();
    txAction.setHeader(new Uint8Array());
    txAction.setPayload(payload.serializeBinary());
    transaction.getActionsList().push(txAction);
  }
  const payload = new common.Payload();
  payload.setHeader(header);
  payload.setData(transaction.serializeBinary());
  const envelope = new common.Envelope();
  envelope.setPayload(payload.serializeBinary());
  return envelope.serializeBinary();
}

function block(number: number, entries: Uint8Array[], previousHash = new Uint8Array(), filter = entries.map(() => 0)): Uint8Array {
  const data = new common.BlockData();
  data.setDataList(entries);
  const header = new common.BlockHeader();
  header.setNumber(number);
  header.setPreviousHash(previousHash);
  header.setDataHash(hash(new Uint8Array(entries.reduce((all, item) => [...all, ...item], [] as number[]))));
  const metadata = new common.BlockMetadata();
  metadata.setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.from(filter)]);
  const result = new common.Block();
  result.setHeader(header);
  result.setData(data);
  result.setMetadata(metadata);
  return result.serializeBinary();
}

function configurationTransaction(): Uint8Array {
  const channelHeader = new common.ChannelHeader();
  channelHeader.setType(common.HeaderType.CONFIG);
  channelHeader.setChannelId(channel);
  const header = new common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  const payload = new common.Payload();
  payload.setHeader(header);
  const envelope = new common.Envelope();
  envelope.setPayload(payload.serializeBinary());
  return envelope.serializeBinary();
}

test("accepts the empty-ID genesis config and halts at later channel reconfiguration", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  projector.applyBlock(block(0, [configurationTransaction()]));
  const checkpoint = projector.checkpoint();
  assert.equal(checkpoint?.block_number, 0);
  assert.throws(() => projector.applyBlock(block(1, [configurationTransaction()], Buffer.from(checkpoint!.block_hash, "hex"))), /after genesis/);
  assert.deepEqual(projector.checkpoint(), checkpoint);
});

test("retains INVALID duplicate IDs but rejects two VALID copies atomically", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const tx = transaction({ txId: "tx-duplicate-id", writes: [] });
  const result = projector.applyBlock(block(0, [tx, tx], new Uint8Array(), [0, peer.TxValidationCode.DUPLICATE_TXID]));
  assert.deepEqual(result.invalid_transaction_ids, ["tx-duplicate-id"]);
  const checkpoint = projector.checkpoint();
  assert.throws(() => projector.applyBlock(block(1, [tx, tx], Buffer.from(checkpoint!.block_hash, "hex"))), /duplicate VALID/);
  assert.deepEqual(projector.checkpoint(), checkpoint);
});

test("projects only VALID target-chaincode writes from a real serialized common.Block", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const valid = transaction({ txId: "tx-valid-fence", writes: [{ key: keyFor.fence("nonce-1234567890"), value: { nonce: "nonce-1234567890", eligibility_epoch: 0, tx_id: "fabric-tx" } }] });
  const invalid = transaction({ txId: "tx-invalid", writes: [{ key: "kcl:v1:unknown:bad", value: { nope: true } }] });
  const result = projector.applyBlock(block(0, [valid, invalid], new Uint8Array(), [0, peer.TxValidationCode.MVCC_READ_CONFLICT]));
  assert.deepEqual(result.valid_transaction_ids, ["tx-valid-fence"]);
  assert.deepEqual(result.invalid_transaction_ids, ["tx-invalid"]);
  assert.deepEqual(projector.read(keyFor.fence("nonce-1234567890")), { nonce: "nonce-1234567890", eligibility_epoch: 0, tx_id: "fabric-tx" });
  assert.equal(projector.read("kcl:v1:unknown:bad"), undefined);
  assert.equal(projector.checkpoint()?.block_number, 0);
});

test("accepts only the pinned bootstrap manifest shape and digest", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const marker = {
    payload_digest: sha256Digest(genesis),
    result: { status: "bootstrapped", channel_id: channel, config_version: "cfg-1", membership_epoch: 1, role_binding_version: 1 },
  };
  // The production digest uses canonical JSON; this fixture is intentionally canonical already.
  const tx = transaction({ txId: "tx-bootstrap", writes: [{ key: "kcl:v1:bootstrap_manifest", value: marker }] });
  projector.applyBlock(block(0, [tx]));
  assert.deepEqual(projector.read("kcl:v1:bootstrap_manifest"), marker);
});

test("rejects an invalid write atomically and preserves state and cursor", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const first = transaction({ txId: "tx-first-fence", writes: [{ key: keyFor.fence("nonce-first-123456"), value: { nonce: "nonce-first-123456", eligibility_epoch: 0, tx_id: "tx-first-fence" } }] });
  const firstBytes = block(0, [first]);
  projector.applyBlock(firstBytes);
  const checkpoint = projector.checkpoint();
  const before = projector.entries();
  const bad = transaction({ txId: "tx-bad", writes: [{ key: "kcl:v1:unknown:rejected", value: { nope: true } }] });
  assert.throws(() => projector.applyBlock(block(1, [bad], Buffer.from(checkpoint!.block_hash, "hex"))));
  assert.deepEqual(projector.checkpoint(), checkpoint);
  assert.deepEqual(projector.entries(), before);
});

test("requires a complete transaction validation filter and channel match", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const tx = transaction({ txId: "tx-channel", channelId: "other-channel", writes: [] });
  assert.throws(() => projector.applyBlock(block(0, [tx], new Uint8Array(), [])), /validation filter/);
  assert.throws(() => projector.applyBlock(block(0, [tx])), /another channel/);
});

test("matches the official ASN.1 DER BlockHeaderHash golden", { skip: !fabricProtosAvailable }, () => {
  const header = new common.BlockHeader();
  header.setPreviousHash(Uint8Array.from({ length: 32 }, () => 0x11));
  header.setDataHash(Uint8Array.from({ length: 32 }, () => 0x22));
  // Independently generated by openssl asn1parse -genconf: a SEQUENCE of
  // INTEGER:number and two 32-byte OCTET STRING fields (0x11 and 0x22).
  const golden = [
    [7, "bc5e6567bc0967b345b21bbed5ee2fa757f662cac4c634a508c66dbd9bbba7ab"],
    [128, "21255970fce2d8bd67c1b022cb7528f12d311fec7fc8ba34f5414d3983808260"],
    [256, "102f5fcde227f2fd991cf9af0ffa571244bf6cd2aee8d14fb8ff40a0a0d44e7c"],
    [65536, "8ed09c2dc43903161ff8a1551a3cb1a91efd10f45a05986c6bc5fe143111a97d"],
    [Number.MAX_SAFE_INTEGER, "a9a48db1c65235f3844cc30ed08db334f7d920abddf7fdc4e3d356b5fdce6a4c"],
  ] as const;
  for (const [number, expected] of golden) {
    header.setNumber(number);
    assert.equal(fabricBlockHeaderHash(header), expected, `block ${number}`);
  }
});

test("rejects lifecycle transactions carrying a hidden KCL namespace", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const hidden = transaction({ txId: "tx-hidden-lifecycle", chaincodeName: "_lifecycle", namespace: "kcl", writes: [{ key: keyFor.eligibilityEpoch(), value: 7 }] });
  assert.throws(() => projector.applyBlock(block(0, [hidden])), /Lifecycle.*KCL/);
  assert.equal(projector.checkpoint(), null);
});

test("halts on NOT_VALIDATED and unknown transaction filter codes", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const tx = transaction({ txId: "tx-not-final", writes: [] });
  assert.throws(() => projector.applyBlock(block(0, [tx], new Uint8Array(), [peer.TxValidationCode.NOT_VALIDATED])), /unknown or not final/);
  assert.equal(projector.checkpoint(), null);
  assert.throws(() => projector.applyBlock(block(0, [tx], new Uint8Array(), [200])), /unknown or not final/);
  assert.equal(projector.checkpoint(), null);
});

test("allows lifecycle transactions and read-only non-target namespaces while rejecting hidden writes", { skip: !fabricProtosAvailable }, () => {
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: genesis });
  const lifecycle = transaction({ txId: "tx-lifecycle", chaincodeName: "_lifecycle", namespace: "_lifecycle", writes: [{ key: "lifecycle-key", value: { ignored: true } }] });
  projector.applyBlock(block(0, [lifecycle]));
  assert.equal(projector.read("lifecycle-key"), undefined);
  const readOnly = transaction({ txId: "tx-kcl-lifecycle-read", namespace: "_lifecycle", writes: [] });
  projector.applyBlock(block(1, [readOnly], Buffer.from(projector.checkpoint()!.block_hash, "hex")));
  const hidden = transaction({ txId: "tx-kcl-lifecycle-write", namespace: "_lifecycle", writes: [{ key: "hidden", value: { ignored: true } }] });
  assert.throws(() => projector.applyBlock(block(2, [hidden], Buffer.from(projector.checkpoint()!.block_hash, "hex"))), /Non-target namespace writes/);
  assert.equal(projector.checkpoint()?.block_number, 1);
});

test("projects engine write sets atomically and resolver withholds after same-block withdrawal", { skip: !fabricProtosAvailable }, async () => {
  const fixtures = demoFixtures();
  const projector = new FabricBlockProjector({ channel_id: channel, chaincode_name: chaincode, public_genesis: fixtures.config });
  const store = new Map<string, unknown>();
  const apply = (blockNumber: number, txs: Array<{ txId: string; writes: Array<{ key: string; value: unknown }> }>) => {
    const previous = projector.checkpoint();
    const serialized = block(blockNumber, txs.map(tx => transaction(tx)), previous ? Buffer.from(previous.block_hash, "hex") : new Uint8Array(), txs.map(() => 0));
    projector.applyBlock(serialized);
  };
  const bootstrapWrites = await runBootstrap(store, fixtures.config);
  apply(0, [{ txId: "tx-bootstrap-engine", writes: bootstrapWrites }]);
  const revision = fixtures.revisions[0];
  const policy = fixtures.policies[0];
  const sales = actorIdentity(PERSONAS[0]);
  const slot = { channel_id: channel, document_id: revision.payload.document_id, context_id: revision.payload.context_id, scope_id: revision.payload.scope_id, usage_scope: revision.payload.usage_scope };
  const publish = await runEngine(store, sales, "tx-engine-publish", { command_id: "cmd-engine-publish", type: "publish_revision", input: { revision, publication: { revision_digest: revision.revision_digest, config_version: 1, membership_epoch: 1 } } });
  apply(1, [{ txId: "tx-engine-publish", writes: publish }]);
  const proposalId = "proposal-engine-001";
  const propose = await runEngine(store, sales, "tx-engine-propose", { command_id: "cmd-engine-propose", type: "propose", input: { proposal_id: proposalId, revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1 } });
  apply(2, [{ txId: "tx-engine-propose", writes: propose }]);
  const representative = policy.role_representatives[0];
  const decision = {
    contract_type: "ApprovalDecision", contract_version: 1, decision_id: "decision-engine-001", revision_digest: revision.revision_digest,
    ...slot, policy_id: policy.policy_id, policy_version: 1, membership_epoch: 1, role_binding_version: 1,
    actor_org_id: sales.org_id, actor_id: sales.actor_id, subject_id: revision.payload.document_id, actor_domain_role: representative.domain_role,
    decision: "approve", rationale: "engine fixture", decided_at: "2026-09-15T00:00:00Z", proposal_id: proposalId,
  };
  const decide = await runEngine(store, sales, "tx-engine-decide", { command_id: "cmd-engine-decide", type: "decide", input: { decision } });
  apply(3, [{ txId: "tx-engine-decide", writes: decide }]);
  const activate = await runEngine(store, sales, "tx-engine-activate", { command_id: "cmd-engine-activate", type: "activate", input: { proposal_id: proposalId, agreement_id: "agreement-engine-001", expected_active_agreement_id: null } });
  apply(4, [{ txId: "tx-engine-activate", writes: activate }]);
  assert.equal((await resolveAt(async key => projector.read(key), slot)).eligible, true);

  const fence = await runEngine(store, sales, "tx-engine-fence", { command_id: "cmd-engine-fence", type: "fence", input: { nonce: "nonce-engine-123456" } });
  const withdraw = await runEngine(store, sales, "tx-engine-withdraw", { command_id: "cmd-engine-withdraw", type: "withdraw", input: { agreement_id: "agreement-engine-001", reason: "engine fixture withdrawal" } });
  apply(5, [
    { txId: "tx-engine-fence", writes: fence },
    { txId: "tx-engine-withdraw", writes: withdraw },
  ]);
  const final = await resolveAt(async key => projector.read(key), slot);
  assert.equal(final.eligible, false);
  assert.equal(final.reason, "NO_ACTIVE_AGREEMENT");
  assert.deepEqual(projector.read(keyFor.fence("nonce-engine-123456")), { nonce: "nonce-engine-123456", eligibility_epoch: 1, tx_id: "tx-engine-fence" });
});
