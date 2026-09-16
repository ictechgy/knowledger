import test from 'node:test';
import assert from 'node:assert/strict';
import { FabricApplicationLedger } from '../../packages/fabric/application-ledger.ts';
import { demoFixtures, PERSONAS, actorIdentity } from '../../examples/order-workflow/config.ts';
import { idempotencyDigest, keyFor } from '../../packages/domain/index.ts';

const actor = actorIdentity(PERSONAS[1]);
const command = { command_id: 'command-application-ledger', type: 'fence', input: { nonce: 'fence-application-ledger-001' } };
const originalTx = 'a'.repeat(64);
const checkpoint = { channel_id: 'kcl-demo', block_number: 2, transaction_index: 0, transaction_id: originalTx, block_hash: 'b'.repeat(64) };

function fixture() {
  const records = new Map<string, any>([[keyFor.config(), demoFixtures().config], [keyFor.eligibilityEpoch(), 0]]);
  let online = true;
  let submissions = 0;
  let receiptReads = 0;
  let submit: () => void = () => {};
  const projection = {
    channelId: 'kcl-demo',
    blockCheckpoint: () => ({ channel_id: 'kcl-demo', block_number: 2, block_hash: checkpoint.block_hash, data_hash: 'c'.repeat(64) }),
    applyBlock() { throw new Error('No extra blocks exist in this middleware fixture'); },
    read(key: string) { return structuredClone(records.get(key)); },
    entries: () => [...records.entries()], checkpoint: () => checkpoint,
    checkpointForTransaction(id: string) { receiptReads++; assert.equal(id, originalTx); return checkpoint; },
    checkpointForStateCreation: () => checkpoint, assertCheckpoint() {}, events: () => [], close() {},
  };
  const ledger = new FabricApplicationLedger({ projection, source: {
    async getTip() { if (!online) throw new Error('peer offline'); return { height: 3, block_hash: checkpoint.block_hash }; },
    async getBlock() { throw new Error('Unexpected block fetch'); },
  }, routes: [{ actor, transport: {
    async execute() { submissions++; submit(); return { status: 'valid', tx_id: 'd'.repeat(64), payload_digest: idempotencyDigest(command), result: { unverified_wire_result: true } }; },
    async recoverPending() { return []; },
  } }] });
  const commit = () => records.set(keyFor.idempotency(actor.org_id, command.command_id), {
    record_type: 'IdempotencyRecord', command_id: command.command_id, command_type: command.type,
    command_digest: idempotencyDigest(command), actor, tx_id: originalTx,
    result: { status: 'fenced', nonce: command.input.nonce, eligibility_epoch: 0, tx_id: originalTx },
  });
  return { ledger, records, commit, offline: () => { online = false; }, onSubmit: (fn: () => void) => { submit = fn; }, counts: () => ({ submissions, receiptReads }) };
}

test('Fabric application adapter requires the exact certified actor route', async t => {
  const f = fixture(); t.after(() => f.ledger.close());
  await assert.rejects(() => f.ledger.execute({ ...actor, actor_id: 'another-person' }, command), (error: any) => error.code === 'SIGNER_FORBIDDEN');
  assert.equal(f.counts().submissions, 0);
});

test('Gateway VALID without a projected authoritative command remains pending', async t => {
  const f = fixture(); t.after(() => f.ledger.close());
  const result = await f.ledger.execute(actor, command);
  assert.equal(result.status, 'pending');
  assert.equal(f.counts().receiptReads, 0);
  assert.equal(f.records.has(keyFor.fence(command.input.nonce)), false, 'Preflight must not persist simulated writes');
});

test('committed receipt uses the original VALID projected transaction, not an attempted duplicate', async t => {
  const f = fixture(); t.after(() => f.ledger.close()); f.onSubmit(f.commit);
  const result = await f.ledger.execute(actor, command);
  assert.equal(result.status, 'committed');
  if (result.status !== 'committed') return;
  assert.deepEqual(result.checkpoint, checkpoint);
  assert.equal(result.result.tx_id, originalTx);
  assert.equal(result.result.unverified_wire_result, undefined);
  const retry = await f.ledger.execute(actor, command);
  assert.deepEqual(retry, result);
  assert.equal(f.counts().submissions, 1);
  await assert.rejects(() => f.ledger.execute(actor, { ...command, input: { nonce: 'another-fence-nonce-001' } }), (error: any) => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('loss of the trusted peer prevents serving a cached application view', async t => {
  const f = fixture(); t.after(() => f.ledger.close());
  await f.ledger.refresh(); assert.ok(f.ledger.read(keyFor.config()));
  f.offline();
  await assert.rejects(() => f.ledger.refresh(), (error: any) => error.code === 'FRESHNESS_UNAVAILABLE');
  assert.throws(() => f.ledger.read(keyFor.config()), (error: any) => error.code === 'FRESHNESS_UNAVAILABLE');
});

test('domain preflight rejects invalid commands before any Fabric submission', async t => {
  const f = fixture(); t.after(() => f.ledger.close());
  await assert.rejects(() => f.ledger.execute(actor, { ...command, input: { nonce: 'short' } }), (error: any) => error.code === 'INVALID_INPUT');
  assert.equal(f.counts().submissions, 0);
});

test('command observation accepts only projected receipts and never creates another attempt',async t=>{
  const f=fixture();t.after(()=>f.ledger.close());await f.ledger.refresh();
  assert.equal(await f.ledger.observeCommand(actor,command,false),undefined);
  f.commit();const observed=await f.ledger.observeCommand(actor,command,true);
  assert.equal(observed?.status,'committed');assert.deepEqual(observed?.checkpoint,checkpoint);assert.equal(f.counts().submissions,0);
  await assert.rejects(f.ledger.observeCommand({...actor,actor_id:'another-person'},command,true),/서명|신원/);
});
