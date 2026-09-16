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
  let browseQueries = 0;
  let submit: () => void = () => {};
  const projection = {
    channelId: 'kcl-demo',
    blockCheckpoint: () => ({ channel_id: 'kcl-demo', block_number: 2, block_hash: checkpoint.block_hash, data_hash: 'c'.repeat(64) }),
    applyBlock() { throw new Error('No extra blocks exist in this middleware fixture'); },
    read(key: string) { return structuredClone(records.get(key)); },
    entries: () => [...records.entries()], checkpoint: () => checkpoint,
    checkpointForTransaction(id: string) { receiptReads++; assert.equal(id, originalTx); return checkpoint; },
    checkpointForStateCreation: () => checkpoint, assertCheckpoint() {},
    queryBrowse(query: unknown) { browseQueries++; return { query }; },
    events: () => [], close() {},
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
  return { ledger, records, commit, offline: () => { online = false; }, onSubmit: (fn: () => void) => { submit = fn; }, counts: () => ({ submissions, receiptReads, browseQueries }) };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function controlledFixture(options: { maxPendingCommands?: number } = {}) {
  const records = new Map<string, any>([[keyFor.config(), demoFixtures().config], [keyFor.eligibilityEpoch(), 0]]);
  const oldTip = { height: 3, block_hash: checkpoint.block_hash };
  let tip = oldTip;
  let projected = { channel_id: checkpoint.channel_id, block_number: checkpoint.block_number, block_hash: checkpoint.block_hash, data_hash: 'c'.repeat(64) };
  let online = true;
  let tipReads = 0;
  let blockReads = 0;
  let getTip: (() => Promise<{ height: number; block_hash: string }>) | undefined;
  let getBlock: ((number: number) => Promise<Uint8Array>) | undefined;
  let applyBlock: ((bytes: Uint8Array) => void) | undefined;
  let execute: (() => Promise<{ status: 'valid' | 'invalid' | 'pending'; tx_id: string; payload_digest: string; result?: unknown }>) | undefined;
  const projection = {
    channelId: 'kcl-demo',
    blockCheckpoint: () => projected,
    applyBlock(bytes: Uint8Array) { if (applyBlock) applyBlock(bytes); else throw new Error('No extra blocks exist in this middleware fixture'); },
    read(key: string) { return structuredClone(records.get(key)); },
    entries: () => [...records.entries()], checkpoint: () => checkpoint,
    checkpointForTransaction(id: string) { assert.equal(id, originalTx); return checkpoint; },
    checkpointForStateCreation: () => checkpoint, assertCheckpoint() {}, events: () => [], close() {},
  };
  const ledger = new FabricApplicationLedger({ projection, source: {
    async getTip() {
      tipReads += 1;
      if (!online) throw new Error('peer offline');
      return getTip ? getTip() : tip;
    },
    async getBlock(number: number) { blockReads += 1; return getBlock ? getBlock(number) : Promise.reject(new Error(`Unexpected block fetch ${number}`)); },
  }, routes: [{ actor, transport: {
    async execute() {
      if (execute) return execute();
      return { status: 'valid', tx_id: 'd'.repeat(64), payload_digest: idempotencyDigest(command), result: { unverified_wire_result: true } };
    },
    async recoverPending() { return []; },
  } }], maxPendingCommands: options.maxPendingCommands });
  return {
    ledger,
    records,
    oldTip,
    get tip() { return tip; },
    setTip(value: { height: number; block_hash: string }) { tip = value; },
    setProjection(value: typeof projected) { projected = value; },
    setGetTip(fn: () => Promise<{ height: number; block_hash: string }>) { getTip = fn; },
    setGetBlock(fn: (number: number) => Promise<Uint8Array>) { getBlock = fn; },
    setApplyBlock(fn: (bytes: Uint8Array) => void) { applyBlock = fn; },
    setExecute(fn: () => Promise<{ status: 'valid' | 'invalid' | 'pending'; tx_id: string; payload_digest: string; result?: unknown }>) { execute = fn; },
    offline() { online = false; },
    counts() { return { tipReads, blockReads }; },
  };
}

async function completesBefore<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`operation did not complete within ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

test('forwards indexed browse queries only after the trusted peer is ready', async t => {
  const f = fixture(); t.after(() => f.ledger.close());
  const query = { kind: 'revisions' as const, mode: 'all' as const, at: checkpoint, offset: 0, limit: 10 };
  assert.ok(f.ledger.queryBrowse);
  assert.throws(() => f.ledger.queryBrowse!(query), (error: any) => error.code === 'FRESHNESS_UNAVAILABLE');
  await f.ledger.refresh();
  assert.deepEqual(f.ledger.queryBrowse!(query), { query });
  assert.equal(f.counts().browseQueries, 1);
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

test('concurrent refresh calls share one peer read', async t => {
  const f = controlledFixture(); t.after(() => f.ledger.close());
  const tipStarted = deferred<void>(); const releaseTip = deferred<void>();
  f.setGetTip(async () => { tipStarted.resolve(); await releaseTip.promise; return f.oldTip; });
  const first = f.ledger.refresh();
  await tipStarted.promise;
  const second = f.ledger.refresh();
  releaseTip.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(f.counts(), { tipReads: 1, blockReads: 0 });
});

test('concurrent refresh failure is shared and leaves the view unavailable', async t => {
  const f = controlledFixture(); t.after(() => f.ledger.close());
  const tipStarted = deferred<void>(); const releaseTip = deferred<void>();
  f.setGetTip(async () => { tipStarted.resolve(); await releaseTip.promise; throw new Error('peer offline'); });
  const first = f.ledger.refresh();
  await tipStarted.promise;
  const second = f.ledger.refresh();
  releaseTip.resolve();
  const results = await Promise.allSettled([first, second]);
  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'rejected');
  assert.deepEqual(f.counts(), { tipReads: 1, blockReads: 0 });
  assert.throws(() => f.ledger.read(keyFor.config()), (error: any) => error.code === 'FRESHNESS_UNAVAILABLE');
});

test('refresh remains available while external command transport is slow', async t => {
  const f = controlledFixture(); t.after(() => f.ledger.close());
  const executeStarted = deferred<void>(); const releaseExecute = deferred<void>();
  f.setExecute(async () => { executeStarted.resolve(); await releaseExecute.promise; return { status: 'valid', tx_id: 'd'.repeat(64), payload_digest: idempotencyDigest(command) }; });
  const execution = f.ledger.execute(actor, command);
  await executeStarted.promise;
  await completesBefore(f.ledger.refresh());
  releaseExecute.resolve();
  const result = await execution;
  assert.equal(result.status, 'pending');
  assert.ok(f.counts().tipReads >= 2, 'initial and concurrent refreshes should both reach the peer');
});

test('a post-write refresh does not join a stale refresh already in flight', async t => {
  const f = controlledFixture(); t.after(() => f.ledger.close());
  const staleTipStarted = deferred<void>(); const releaseStaleTip = deferred<void>();
  const executeStarted = deferred<void>(); const releaseExecute = deferred<void>(); const executeReturned = deferred<void>();
  const nextTip = { height: 4, block_hash: 'e'.repeat(64) };
  f.setGetTip(async () => {
    if (f.counts().tipReads === 1) return f.oldTip;
    if (f.counts().tipReads === 2) { staleTipStarted.resolve(); await releaseStaleTip.promise; return f.oldTip; }
    return nextTip;
  });
  f.setGetBlock(async number => { assert.equal(number, 3); return new Uint8Array([number]); });
  f.setProjection({ channel_id: 'kcl-demo', block_number: 2, block_hash: checkpoint.block_hash, data_hash: 'c'.repeat(64) });
  f.setApplyBlock(() => f.setProjection({ channel_id: 'kcl-demo', block_number: 3, block_hash: nextTip.block_hash, data_hash: 'f'.repeat(64) }));
  f.setExecute(async () => { executeStarted.resolve(); await releaseExecute.promise; executeReturned.resolve(); return { status: 'valid', tx_id: 'd'.repeat(64), payload_digest: idempotencyDigest(command) }; });
  const execution = f.ledger.execute(actor, command);
  await executeStarted.promise;
  const staleRefresh = f.ledger.refresh();
  await staleTipStarted.promise;
  releaseExecute.resolve();
  await executeReturned.promise;
  await Promise.resolve();
  releaseStaleTip.resolve();
  const result = await execution;
  await staleRefresh;
  assert.equal(result.status, 'pending');
  assert.deepEqual(f.counts(), { tipReads: 3, blockReads: 1 });
});

test('command queue rejects excess work with retryable backpressure', async t => {
  const f = controlledFixture({ maxPendingCommands: 1 }); t.after(() => f.ledger.close());
  const executeStarted = deferred<void>(); const releaseExecute = deferred<void>();
  f.setExecute(async () => { executeStarted.resolve(); await releaseExecute.promise; return { status: 'valid', tx_id: 'd'.repeat(64), payload_digest: idempotencyDigest(command) }; });
  const first = f.ledger.execute(actor, command);
  await executeStarted.promise;
  await assert.rejects(() => f.ledger.execute(actor, { ...command, command_id: 'command-application-ledger-2' }), (error: any) => {
    assert.equal(error.code, 'LEDGER_BUSY'); assert.equal(error.status, 429); assert.equal(error.retryable, true); return true;
  });
  releaseExecute.resolve();
  await first;
});
