import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { ReviewDeliveryWorker } from '../../packages/review/delivery-worker.ts';
import { deliveryHash } from '../../packages/review/delivery-contract.ts';
import type { ReviewPacket, ReviewReceipt } from '../../packages/review/delivery-contract.ts';

const author = { org_id: 'AlphaMSP', actor_id: 'reviewer', kind: 'human' as const };
function enqueue(vault: PrivateStore, now = Date.now()) {
  const message = { schema_version: 1 as const, delivery_id: 'delivery-fixture', source_id: 'source-alpha', workspace_id: 'knowledge',
    slot: { channel_id: 'channel-test', document_id: 'doc-test', context_id: 'context-test', scope_id: 'scope-test', usage_scope: 'reference/v1' },
    revision_digest: `sha256:${'a'.repeat(64)}`, recipient: { org_id: 'BetaMSP', actor_id: 'reviewer' },
    comment: { event_id: 'comment-fixture', author, created_at: new Date().toISOString(), body: 'Fictional comment' } };
  const packet: ReviewPacket = { message, payload_digest: deliveryHash(message) };
  return vault.deliveries.enqueue(author, 'send-fixture', { event_id: 'comment-fixture' }, { id: 'target-beta', binding: deliveryHash('target-beta') }, packet, now);
}
const receipt = (packet: ReviewPacket): ReviewReceipt => ({ schema_version: 1, delivery_id: packet.message.delivery_id, payload_digest: packet.payload_digest, received_at: new Date().toISOString() });

test('durable leases prevent concurrent claims and stale completion cannot overwrite the new owner', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-delivery-lease-')); const path = join(root, 'private.sqlite');
  const first = new PrivateStore(path); const second = new PrivateStore(path);
  try {
    enqueue(first, 1000);
    const old = first.deliveries.claim(1000, 100, 3)!; assert.equal(second.deliveries.claim(1000, 100, 3), null);
    const current = second.deliveries.claim(1101, 100, 3)!; assert.equal(current.attempts, 2); assert.notEqual(old.lease_token, current.lease_token);
    assert.equal(first.deliveries.settle(old, 'delivered', 1102, null, receipt(old.packet)), false);
    assert.equal(second.deliveries.settle(current, 'delivered', 1102, null, receipt(current.packet)), true);
    assert.equal(first.deliveries.get(author, old.packet.message.delivery_id).status, 'delivered');
  } finally { first.close(); second.close(); rmSync(root, { recursive: true, force: true }); }
});

test('a lost final attempt becomes unconfirmed after lease expiry instead of silently resending forever', () => {
  const vault = new PrivateStore(':memory:');
  try {
    enqueue(vault, 1000); assert.ok(vault.deliveries.claim(1000, 100, 1));
    assert.equal(vault.deliveries.claim(1101, 100, 1), null);
    const row = vault.deliveries.get(author, 'delivery-fixture'); assert.equal(row.status, 'failed'); assert.equal(row.last_code, 'DELIVERY_UNCONFIRMED');
    vault.deliveries.retry(author, 'delivery-fixture', 1102); assert.equal(vault.deliveries.claim(1102, 100, 1)!.total_attempts, 2);
  } finally { vault.close(); }
});

test('deadline is bounded even if a transport ignores abort and late success cannot change a failed job', async () => {
  const vault = new PrivateStore(':memory:'); const job = enqueue(vault); let release!: (value: ReviewReceipt) => void;
  const worker = new ReviewDeliveryWorker(vault.deliveries, async () => new Promise(resolve => { release = resolve; }), { timeoutMs: 20, maxAttempts: 1, pollMs: 0 });
  try {
    const one = worker.runOnce(); assert.equal(worker.runOnce(), one); await one;
    assert.equal(vault.deliveries.get(author, 'delivery-fixture').status, 'failed');
    release(receipt(job.packet)); await delay(10);
    assert.equal(vault.deliveries.get(author, 'delivery-fixture').status, 'failed');
  } finally { await worker.close(); vault.close(); }
});

test('shutdown aborts an in-flight transport and drains before the vault can be closed', async () => {
  const vault = new PrivateStore(':memory:'); enqueue(vault); let signal: AbortSignal | undefined;
  const worker = new ReviewDeliveryWorker(vault.deliveries, async (_job, current) => { signal = current; return new Promise(() => {}); }, { timeoutMs: 30000, pollMs: 0 });
  const work = worker.runOnce(); await worker.close(); await work;
  assert.equal(signal!.aborted, true); assert.equal(vault.deliveries.get(author, 'delivery-fixture').last_code, 'DELIVERY_SHUTDOWN');
  assert.equal(await worker.runOnce(), 0); vault.close();
});

test('queue mutation failure is atomic and invalid stored packets cannot reach the transport', async () => {
  const vault = new PrivateStore(':memory:'); const db = (vault as any).db; const prepare = db.prepare.bind(db); let fail = true;
  db.prepare = (sql: string) => { if (fail && sql.startsWith('INSERT INTO review_delivery_outbox')) throw new Error('Synthetic write failure'); return prepare(sql); };
  assert.throws(() => enqueue(vault)); assert.equal(vault.deliveries.list(author, {}).jobs.length, 0); fail = false;
  const job = enqueue(vault); const corrupt = structuredClone(job.packet); corrupt.message.comment.body = 'Changed';
  db.prepare('UPDATE review_delivery_outbox SET packet_json=?').run(JSON.stringify(corrupt));
  let calls = 0; const worker = new ReviewDeliveryWorker(vault.deliveries, async () => { calls++; return receipt(job.packet); }, { pollMs: 0 });
  try { await assert.rejects(worker.runOnce(), (error: any) => error.code === 'DELIVERY_STORE_CORRUPT'); assert.equal(calls, 0); }
  finally { await worker.close(); vault.close(); }
});

test('the optional poller delivers queued work and closes without leaving another timer', async () => {
  const vault = new PrivateStore(':memory:'); const job = enqueue(vault); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const worker = new ReviewDeliveryWorker(vault.deliveries, async () => { entered(); return receipt(job.packet); }, { pollMs: 5 });
  // Unref'd pollers should not keep a process alive; this bounded fixture wait holds the test open.
  const keepAlive = setTimeout(() => {}, 1000);
  try { worker.start(); await started; await worker.runOnce(); assert.equal(vault.deliveries.get(author, 'delivery-fixture').status, 'delivered'); }
  finally { await worker.close(); clearTimeout(keepAlive); vault.close(); }
});
