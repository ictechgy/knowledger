import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { demoDefinition, demoFixtures, actorIdentity, PERSONAS } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { measureAdoption } from '../../packages/measurement/adoption.ts';

const requireFabric = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
let available = false;
try { requireFabric.resolve('@hyperledger/fabric-protos'); available = true; }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error; }
const { common, ledger, peer } = available ? requireFabric('@hyperledger/fabric-protos') : {};
const Timestamp = available ? requireFabric('google-protobuf/google/protobuf/timestamp_pb.js').Timestamp : undefined;
const { SqliteFabricProjection } = available ? await import('../../packages/fabric/sqlite-projection.ts') : {};
const { FabricBlockProjector, fabricBlockHeaderHash } = available ? await import('../../packages/fabric/block-projector.ts') : {};
const { readFabricPilotMeasurement } = available ? await import('../../packages/measurement/fabric-adoption.ts') : {};
const genesis = demoFixtures().config;
const options = { channel_id: 'kcl-demo', chaincode_name: 'kcl', chaincode_version: '0.1.0', public_genesis: genesis };
const observations = { schema_version: 1 as const, pilot_id: 'fabric-pilot-fixture', concept: 'Fixture concept', workflow: 'Fixture review', observations: [] };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function transaction(txId: string, writes: [string, unknown][], at = '2026-09-20T00:00:00.000Z'): Uint8Array {
  const channel = new common.ChannelHeader(); channel.setType(common.HeaderType.ENDORSER_TRANSACTION);
  channel.setChannelId(options.channel_id); channel.setTxId(txId);
  const timestamp = new Timestamp(); const millis = Date.parse(at);
  timestamp.setSeconds(Math.floor(millis / 1000)); timestamp.setNanos(millis % 1000 * 1_000_000); channel.setTimestamp(timestamp);
  const header = new common.Header(); header.setChannelHeader(channel.serializeBinary());
  const kv = new ledger.rwset.kvrwset.KVRWSet();
  for (const [key, value] of writes) {
    const write = new ledger.rwset.kvrwset.KVWrite(); write.setKey(key); write.setValue(Buffer.from(JSON.stringify(value))); kv.getWritesList().push(write);
  }
  const namespace = new ledger.rwset.NsReadWriteSet(); namespace.setNamespace('kcl'); namespace.setRwset(kv.serializeBinary());
  const rwset = new ledger.rwset.TxReadWriteSet(); rwset.getNsRwsetList().push(namespace);
  const id = new peer.ChaincodeID(); id.setName('kcl'); id.setVersion('0.1.0');
  const action = new peer.ChaincodeAction(); action.setChaincodeId(id); action.setResults(rwset.serializeBinary());
  const response = new peer.ProposalResponsePayload(); response.setExtension$(action.serializeBinary());
  const endorsed = new peer.ChaincodeEndorsedAction(); endorsed.setProposalResponsePayload(response.serializeBinary());
  const actionPayload = new peer.ChaincodeActionPayload(); actionPayload.setAction(endorsed);
  const entry = new peer.TransactionAction(); entry.setPayload(actionPayload.serializeBinary());
  const tx = new peer.Transaction(); tx.getActionsList().push(entry);
  const payload = new common.Payload(); payload.setHeader(header); payload.setData(tx.serializeBinary());
  const envelope = new common.Envelope(); envelope.setPayload(payload.serializeBinary()); return envelope.serializeBinary();
}

function block(number: number, entries: Uint8Array[], previousHash = '', filter = entries.map(() => 0)) {
  const data = new common.BlockData(); data.setDataList(entries);
  const header = new common.BlockHeader(); header.setNumber(number); header.setPreviousHash(Buffer.from(previousHash, 'hex'));
  header.setDataHash(Buffer.from(hash(Buffer.concat(entries.map(bytes => Buffer.from(bytes)))), 'hex'));
  const metadata = new common.BlockMetadata(); metadata.setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.from(filter)]);
  const result = new common.Block(); result.setHeader(header); result.setData(data); result.setMetadata(metadata);
  return { bytes: result.serializeBinary(), hash: fabricBlockHeaderHash(header) };
}

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-fabric-pilot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = new LocalLedger(':memory:', options.channel_id); const vault = new PrivateStore(':memory:');
  let events;
  try {
    const service = new KnowledgerService(local, vault, demoDefinition()); await service.initialize(); await seedDemo(service);
    await local.execute(actorIdentity(PERSONAS[0]), { command_id: 'pilot-withdraw-fixture', type: 'withdraw', input: { agreement_id: 'agreement-sales-001', reason: 'Fictional measurement test' } });
    events = local.events(0, 1000);
  } finally { local.close(); vault.close(); }
  const path = join(root, 'fabric-projection.sqlite');
  const projection = new SqliteFabricProjection(path, options);
  const invalid = transaction('tx-invalid-pilot', [['kcl:v1:decision:not-real', { contract_type: 'ApprovalDecision', decision: 'approve' }]]);
  const blocks = [];
  blocks.push(block(0, [transaction(events[0].checkpoint.transaction_id, events[0].writes, events[0].timestamp), invalid], '', [0, 11]));
  blocks.push(block(1, events.slice(1).map(event => transaction(event.checkpoint.transaction_id, event.writes, event.timestamp)), blocks[0].hash));
  blocks.push(block(2, [invalid], blocks[1].hash, [11]));
  blocks.push(block(3, [], blocks[2].hash));
  try { for (const entry of blocks) projection.applyBlock(entry.bytes); } finally { projection.close(); }
  const genesisPath = join(root, 'genesis.json'); const observationsPath = join(root, 'observations.json');
  writeFileSync(genesisPath, JSON.stringify(genesis)); writeFileSync(observationsPath, JSON.stringify(observations));
  const cli = (extra: string[] = []) => spawnSync(process.execPath, ['tools/adoption-metrics.ts', '--mode', 'fabric', '--ledger', path,
    '--channel', options.channel_id, '--chaincode', options.chaincode_name, '--chaincode-version', options.chaincode_version,
    '--genesis', genesisPath, '--observations', observationsPath, ...extra], { cwd: join(import.meta.dirname, '../..'), encoding: 'utf8', timeout: 10_000 });
  return { root, path, events, blocks, genesisPath, observationsPath, cli,
    read: () => readFabricPilotMeasurement({ path, options, observations }) };
}

test('Fabric pilot metrics stream all VALID transactions including block zero and preserve exact bounds', { skip: !available }, async t => {
  const f = await fixture(t); const before = readFileSync(f.path);
  const result = f.read(); const expected = measureAdoption({ events: f.events, log: observations });
  assert.deepEqual(result.derived, expected.derived);
  assert.equal(result.derived.review_effort.approvals, 3);
  assert.equal(result.derived.review_effort.withdrawals, 1);
  assert.equal(result.derived.time_to_agreement.count, 3);
  assert.equal(result.derived.reuse_rate.revisions_published, 4);
  assert.equal(result.window.event_count, f.events.length);
  assert.equal(result.window.first_checkpoint?.block_number, 0);
  assert.equal(result.window.first_checkpoint?.transaction_index, 0);
  assert.equal(result.window.last_checkpoint?.block_number, 1);
  assert.equal(result.window.last_checkpoint?.transaction_index, f.events.length - 2);
  assert.equal(result.window.tip_hash, f.blocks[1].hash);
  assert.equal(result.source?.checkpoint.block_number, 3, 'empty and all-INVALID tail blocks still bind the source tip');
  assert.equal(result.source?.checkpoint.block_hash, f.blocks[3].hash);
  assert.equal(result.source?.block_count, 4);
  assert.equal(result.source?.valid_transaction_count, f.events.length);
  assert.equal(result.source?.invalid_transaction_count, 2);
  assert.match(result.source!.journal_digest, /^[a-f0-9]{64}$/);
  assert.equal(result.source?.verification, 'offline-full-block-replay');
  assert.deepEqual(readFileSync(f.path), before, 'reading does not rebuild or modify the projection database');
});

test('Fabric measurements ignore forged derived tables without repairing them', { skip: !available }, async t => {
  const f = await fixture(t); const expected = f.read();
  const db = new DatabaseSync(f.path);
  db.exec("UPDATE fabric_raw_transactions SET validation_code = 0, valid = 1, writes_json = '[]'; UPDATE fabric_raw_blocks SET result_json = 'not trusted JSON'; DELETE FROM fabric_projection_history; DELETE FROM fabric_projection_state;"); db.close();
  const before = readFileSync(f.path);
  assert.deepEqual(f.read(), expected);
  assert.deepEqual(readFileSync(f.path), before);
});

test('Fabric measurement refuses missing, empty and incorrectly bound input', { skip: !available }, async t => {
  const f = await fixture(t);
  for (const changed of [{ channel_id: 'other-channel' }, { chaincode_name: 'other-chaincode' }, { chaincode_version: '2.0.0' }, { public_genesis: { ...genesis, membership_epoch: 2 } }]) {
    assert.throws(() => readFabricPilotMeasurement({ path: f.path, options: { ...options, ...changed }, observations }), /binding mismatch/);
  }
  const missing = join(f.root, 'missing.sqlite');
  assert.throws(() => readFabricPilotMeasurement({ path: missing, options, observations })); assert.equal(existsSync(missing), false);
  const empty = join(f.root, 'empty.sqlite'); new SqliteFabricProjection(empty, options).close();
  assert.throws(() => readFabricPilotMeasurement({ path: empty, options, observations }), /journal is empty/);
});

test('Fabric measurement rejects malformed raw blocks, gaps, truncation and forged cursor metadata', { skip: !available }, async t => {
  const f = await fixture(t);
  const cases = [
    "UPDATE fabric_raw_blocks SET raw_digest = 'wrong' WHERE block_number = 1",
    "UPDATE fabric_raw_blocks SET block_bytes = x'0001' WHERE block_number = 1",
    "UPDATE fabric_raw_blocks SET previous_hash = 'wrong' WHERE block_number = 1",
    "UPDATE fabric_raw_blocks SET block_hash = 'wrong' WHERE block_number = 1",
    "UPDATE fabric_raw_blocks SET data_hash = 'wrong' WHERE block_number = 1",
    "DELETE FROM fabric_raw_blocks WHERE block_number = 0",
    "DELETE FROM fabric_raw_blocks WHERE block_number = 1",
    "DELETE FROM fabric_raw_blocks WHERE block_number = 3",
    "UPDATE fabric_raw_blocks SET block_number = -1 WHERE block_number = 0",
    "UPDATE fabric_projection_cursor SET block_number = 99",
    "DELETE FROM fabric_projection_cursor",
    "UPDATE fabric_projection_binding SET schema_version = 99",
    "DELETE FROM fabric_projection_binding",
  ];
  for (const [index, sql] of cases.entries()) {
    const path = join(f.root, `bad-${index}.sqlite`); copyFileSync(f.path, path);
    const db = new DatabaseSync(path); db.exec('PRAGMA foreign_keys = OFF'); db.exec(sql); db.close();
    assert.throws(() => readFabricPilotMeasurement({ path, options, observations }), undefined, sql);
  }
});

test('Fabric measurement rejects changed validation filters and invalid writes marked VALID', { skip: !available }, async t => {
  const f = await fixture(t);
  for (const filter of [[], [peer.TxValidationCode.NOT_VALIDATED], [0]]) {
    const path = join(f.root, `filter-${filter.join('-')}.sqlite`); copyFileSync(f.path, path);
    const changed = common.Block.deserializeBinary(f.blocks[2].bytes);
    changed.getMetadata().setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.from(filter)]);
    const bytes = changed.serializeBinary(); const db = new DatabaseSync(path);
    db.prepare('UPDATE fabric_raw_blocks SET block_bytes = ?, raw_digest = ? WHERE block_number = 2').run(bytes, hash(bytes)); db.close();
    assert.throws(() => readFabricPilotMeasurement({ path, options, observations }), undefined, `filter ${JSON.stringify(filter)}`);
  }
});

test('Fabric measurement holds one read snapshot across replay and cursor verification', { skip: !available }, async t => {
  const f = await fixture(t); const writer = new SqliteFabricProjection(f.path, options);
  const next = block(4, [], f.blocks[3].hash);
  const apply = FabricBlockProjector.prototype.applyBlock; let appended = false;
  t.mock.method(FabricBlockProjector.prototype, 'applyBlock', function(this: any, bytes: Uint8Array) {
    const result = apply.call(this, bytes);
    if (!appended) { appended = true; writer.applyBlock(next.bytes); }
    return result;
  });
  try {
    const initial = f.read(); assert.equal(appended, true);
    assert.equal(initial.source?.checkpoint.block_number, 3);
    assert.equal(f.read().source?.checkpoint.block_number, 4);
  } finally { writer.close(); }
});

test('Fabric source digest binds validation metadata even though the block header does not', { skip: !available }, async t => {
  const f = await fixture(t); const next = block(4, [transaction('tx-query-validation', [])], f.blocks[3].hash, [11]);
  const writer = new SqliteFabricProjection(f.path, options); writer.applyBlock(next.bytes); writer.close();
  const before = f.read();
  const changed = common.Block.deserializeBinary(next.bytes);
  changed.getMetadata().setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.of(0)]);
  const bytes = changed.serializeBinary(); const db = new DatabaseSync(f.path);
  db.prepare('UPDATE fabric_raw_blocks SET block_bytes = ?, raw_digest = ? WHERE block_number = 4').run(bytes, hash(bytes)); db.close();
  // A coherent, locally rewritten journal cannot authenticate itself. Its
  // identity must differ even when its Fabric header chain is unchanged.
  const after = f.read();
  assert.deepEqual(after.source?.checkpoint, before.source?.checkpoint);
  assert.notEqual(after.source?.journal_digest, before.source?.journal_digest);
  assert.equal(after.source!.valid_transaction_count, before.source!.valid_transaction_count + 1);
  assert.deepEqual(after.derived, before.derived);
});

test('Fabric measurements cover more than 1000 blocks and identify a no-event journal', { skip: !available }, t => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-fabric-pilot-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'projection.sqlite'); const writer = new SqliteFabricProjection(path, options);
  let previous = '';
  try {
    for (let number = 0; number < 1002; number++) {
      const entry = block(number, [], previous); writer.applyBlock(entry.bytes); previous = entry.hash;
    }
  } finally { writer.close(); }
  const result = readFabricPilotMeasurement({ path, options, observations });
  assert.equal(result.window.event_count, 0);
  assert.equal(result.window.first_checkpoint, undefined);
  assert.equal(result.window.last_checkpoint, undefined);
  assert.equal(result.source?.block_count, 1002);
  assert.equal(result.source?.checkpoint.block_number, 1001);
  assert.equal(result.source?.checkpoint.block_hash, previous);
  assert.equal(result.derived.time_to_agreement.count, 0);
});

test('Fabric CLI protects every input and emits only measured metadata', { skip: !available }, async t => {
  const f = await fixture(t); const out = join(f.root, 'measurement.json');
  const run = f.cli(['--out', out]); assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), result);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  assert.equal(result.source.kind, 'fabric-projection');
  assert.equal(result.evidence.observations_sha256, hash(readFileSync(f.observationsPath)));
  assert.equal(run.stdout.includes('body_markdown'), false);
  const before = new Map([f.path, f.genesisPath, f.observationsPath].map(path => [path, hash(readFileSync(path))]));
  const alias = join(f.root, 'genesis-alias.json'); linkSync(f.genesisPath, alias);
  const linked = join(f.root, 'genesis-link.json'); symlinkSync(f.genesisPath, linked);
  for (const target of [f.path, f.genesisPath, f.observationsPath, alias, linked, `${f.path}-wal`, `${f.path}-shm`, `${f.path}-journal`]) {
    const refused = f.cli(['--out', target]); assert.equal(refused.status, 1, target); assert.equal(refused.stdout, '');
  }
  for (const [path, digest] of before) assert.equal(hash(readFileSync(path)), digest);
});

test('Fabric CLI rejects omitted bindings and invalid genesis without publishing partial metrics', { skip: !available }, async t => {
  const f = await fixture(t); const out = join(f.root, 'must-not-exist.json');
  const run = spawnSync(process.execPath, ['tools/adoption-metrics.ts', '--mode', 'fabric', '--ledger', f.path,
    '--observations', f.observationsPath, '--out', out], { encoding: 'utf8' });
  assert.equal(run.status, 1); assert.equal(existsSync(out), false);
  for (const invalid of ['{"config_version":1,"config_version":2}', '[]', '{"secret_fixture":"DO_NOT_ECHO"}', 'not JSON']) {
    writeFileSync(f.genesisPath, invalid);
    const refused = f.cli(['--out', out]); assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
    assert.equal(refused.stderr.includes('DO_NOT_ECHO'), false); assert.equal(existsSync(out), false);
  }
});
