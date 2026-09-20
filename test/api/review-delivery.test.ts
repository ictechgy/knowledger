import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createReviewHttpTransport } from '../../packages/review/http-delivery.ts';
import { deliveryHash } from '../../packages/review/delivery-contract.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any, opts: { fetch?: typeof fetch; allows?: () => boolean | Promise<boolean>; maxAttempts?: number; timeoutMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-delivery-')); let senderDir = join(root, 'sender');
  const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'relay-test'); const author = config.bootstrap_actor;
  const recipient = { org_id: 'BetaMSP', actor_id: 'maintainer', kind: 'human' as const };
  const secret = randomBytes(32);
  const receiver = await createConfiguredApp(config, { dataDir: join(root, 'receiver'), port: 0, reviewDelivery: {
    source_id: 'beta-app', source_org_id: 'BetaMSP', peers: [{ key_id: 'alpha-key', secret, source_id: 'alpha-app', org_id: 'AlphaMSP' }], worker: { pollMs: 0 },
  } });
  const receiverOrigin = await receiver.listen(0); const endpoint = `${receiverOrigin}/v1/workspaces/relay-test/review-deliveries/receive`;
  const target = { id: 'beta-reviewer', label: 'Beta review inbox', version: 1, recipient: { org_id: recipient.org_id, actor_id: recipient.actor_id },
    transport: createReviewHttpTransport({ endpoint, key_id: 'alpha-key', secret, allowInsecureLoopback: true, fetch: opts.fetch }), allows: opts.allows };
  const options = { source_id: 'alpha-app', source_org_id: 'AlphaMSP', destinations: [target], worker: { pollMs: 0, timeoutMs: opts.timeoutMs ?? 2000, retryBaseMs: 30, maxAttempts: opts.maxAttempts ?? 3 } };
  let sender = await createConfiguredApp(config, { dataDir: senderDir, port: 0, reviewDelivery: options });
  t.after(async () => { await sender.close(); await receiver.close(); rmSync(root, { recursive: true, force: true }); });
  const policy = config.genesis.policies[0];
  const draft = await sender.service.draft(author, { document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope,
    title: 'Public fixture', body_markdown: '# PUBLIC_REVISION_BODY_NOT_IN_PACKET' });
  const preview = await sender.service.preview(author, { draft_id: draft.draft_id });
  await sender.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'delivery-publish' });
  // Two isolated local simulations: copy the same public revision, never claim a Fabric commit.
  await receiver.service.ledger.execute(author, { command_id: 'delivery-public-fixture', type: 'publish_revision', input: { revision: draft.revision,
    publication: { revision_digest: draft.revision.revision_digest, config_version: 1, membership_epoch: 1 } } });
  const digest = draft.revision.revision_digest;
  const comment = await sender.service.commentOnReview(author, digest, { operation_id: 'delivery-comment', body: 'Explicitly shared fixture comment <img src=x>', mentions: [] });
  const input = { operation_id: 'send-comment', event_id: comment.event_id, destination_id: target.id, destination_version: 1, confirm_shared: true };
  const enqueue = (extra = {}) => sender.service.reviewDelivery!.enqueue(author, digest, { ...input, ...extra });
  const signed = (packet: any, timestamp = String(Math.floor(Date.now() / 1000))) => ({ 'Content-Type': 'application/json',
    'X-Knowledger-Delivery-Key': 'alpha-key', 'X-Knowledger-Delivery-Time': timestamp,
    'X-Knowledger-Delivery-Signature': createHmac('sha256', secret).update(`knowledger-review-delivery-v1\nalpha-key\n${timestamp}\n${packet.payload_digest}`).digest('hex') });
  return { get sender() { return sender; }, receiver, author, recipient, digest, comment, input, enqueue, endpoint, signed, target,
    packet(id: string) { return (sender.service as any).vault.deliveries.get(author, id).packet; },
    async restart(snapshot = false) {
      await sender.close();
      if (snapshot) { const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir: senderDir, snapshotDir }); senderDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir: senderDir, snapshotDir }); }
      sender = await createConfiguredApp(config, { dataDir: senderDir, port: 0, reviewDelivery: options });
    } };
}
const rejects = (task: Promise<any>, code: string) => assert.rejects(task, (error: any) => error.code === code);

test('delivery is opt-in, author-owned, revision-bound and scoped to a configured recipient', async t => {
  const f = await fixture(t); const ledgerBefore = f.sender.service.ledger.checkpoint();
  assert.equal((await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries.length, 0);
  await rejects(f.enqueue({ confirm_shared: false }), 'DELIVERY_CONFIRMATION_REQUIRED');
  await rejects(f.enqueue({ destination_version: 2 }), 'DELIVERY_DESTINATION_CHANGED');
  await rejects(f.enqueue({ endpoint: 'https://unselected.invalid' }), 'INVALID_INPUT');
  await rejects(f.sender.service.reviewDelivery!.enqueue(f.recipient, f.digest, f.input), 'DELIVERY_SOURCE_MISMATCH');
  const queued = await f.enqueue(); assert.equal(queued.status, 'pending');
  assert.deepEqual(await f.enqueue(), queued);
  const other = await f.sender.service.commentOnReview(f.author, f.digest, { operation_id: 'other-local-comment', body: 'Different comment' });
  await rejects(f.enqueue({ event_id: other.event_id }), 'IDEMPOTENCY_CONFLICT');
  await rejects(f.enqueue({ event_id: 'another-event' }), 'NOT_FOUND');
  assert.equal(JSON.stringify(f.packet(queued.delivery_id)).includes('PUBLIC_REVISION_BODY_NOT_IN_PACKET'), false);
  assert.equal((await f.sender.service.reviewDelivery!.list(f.recipient, {})).deliveries.length, 0);
  assert.equal(await f.sender.service.reviewDelivery!.worker.runOnce(), 1);
  const delivered = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0];
  assert.equal(delivered.status, 'delivered'); assert.equal(delivered.receipt!.delivery_id, queued.delivery_id);
  assert.equal((await f.receiver.service.reviewDelivery!.inbox(f.author, {})).deliveries.length, 0);
  const incoming = (await f.receiver.service.reviewDelivery!.inbox(f.recipient, {})).deliveries;
  assert.equal(incoming.length, 1); assert.equal(incoming[0].packet.message.comment.body, f.comment.body);
  assert.equal((await f.receiver.service.review(f.recipient, f.digest)).events.length, 0, 'received comments do not become local shared threads');
  assert.equal(f.receiver.service.values('decision').length, 0); assert.deepEqual(f.sender.service.ledger.checkpoint(), ledgerBefore);
});

test('lost receipt retries identical bytes and produces one recipient record', async t => {
  const packets: string[] = []; let lose = true;
  const f = await fixture(t, { fetch: async (url, init) => {
    packets.push(String(init!.body)); const response = await fetch(url, init);
    if (lose) { lose = false; await response.json(); throw new Error('SENSITIVE_REMOTE_DIAGNOSTIC'); }
    return response;
  } });
  const queued = await f.enqueue(); await f.sender.service.reviewDelivery!.worker.runOnce();
  let job = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0];
  assert.equal(job.status, 'pending'); assert.equal(job.last_code, 'DELIVERY_UNAVAILABLE');
  assert.equal(JSON.stringify(job).includes('SENSITIVE_REMOTE_DIAGNOSTIC'), false);
  await delay(40); await f.sender.service.reviewDelivery!.worker.runOnce();
  job = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0];
  assert.equal(job.status, 'delivered'); assert.equal(job.attempts, 2); assert.deepEqual(packets[0], packets[1]);
  const inbox = await f.receiver.service.reviewDelivery!.inbox(f.recipient, {});
  assert.equal(inbox.deliveries.length, 1); assert.equal(inbox.deliveries[0].receipt.delivery_id, queued.delivery_id);
});

test('queued delivery survives stopped-app backup restore and destination changes block rerouting', async t => {
  const f = await fixture(t); const queued = await f.enqueue(); await f.restart(true);
  assert.equal((await f.enqueue()).delivery_id, queued.delivery_id);
  f.target.version = 2; await f.restart();
  await f.sender.service.reviewDelivery!.worker.runOnce();
  const row = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0];
  assert.equal(row.status, 'blocked'); assert.equal(row.last_code, 'DELIVERY_DESTINATION_CHANGED');
  await rejects(f.sender.service.reviewDelivery!.retry(f.author, queued.delivery_id, {}), 'DELIVERY_DESTINATION_CHANGED');
  assert.equal((await f.receiver.service.reviewDelivery!.inbox(f.recipient, {})).deliveries.length, 0);
});

test('membership freeze and a current authorization revocation stop dispatch before transport', async t => {
  let calls = 0; const f = await fixture(t, { fetch: async (url, init) => { calls++; return fetch(url, init); } });
  const queued = await f.enqueue();
  const context = (f.sender.service.reviewDelivery as any).context;
  context.currentActor = async () => { throw Object.assign(new Error('Revoked'), { status: 403 }); };
  await f.sender.service.reviewDelivery!.worker.runOnce();
  assert.equal(calls, 0); assert.equal((await f.sender.service.reviewDelivery!.worker.runOnce()), 0);
  context.currentActor = undefined;
  assert.equal((await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0].status, 'blocked');
  await f.sender.service.reviewDelivery!.retry(f.author, queued.delivery_id, {});
  const read = f.sender.service.ledger.read.bind(f.sender.service.ledger);
  f.sender.service.ledger.read = (key: string, at: any) => { const result = read(key, at); return key === keyFor.config() ? { ...result, serving_enabled: false } : result; };
  await f.sender.service.reviewDelivery!.worker.runOnce(); assert.equal(calls, 0);
  f.sender.service.ledger.read = read;
});

test('delivery policy denial is terminal until an explicit owner retry', async t => {
  let allowed = false; const f = await fixture(t, { allows: () => allowed }); const queued = await f.enqueue();
  await f.sender.service.reviewDelivery!.worker.runOnce();
  assert.equal((await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0].last_code, 'DELIVERY_POLICY_DENIED');
  await rejects(f.sender.service.reviewDelivery!.retry(f.recipient, queued.delivery_id, {}), 'NOT_FOUND');
  allowed = true; await f.sender.service.reviewDelivery!.retry(f.author, queued.delivery_id, {}); await f.sender.service.reviewDelivery!.worker.runOnce();
  const row = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0]; assert.equal(row.status, 'delivered'); assert.equal(row.total_attempts, 2);
});

test('receiver rejects forged, stale and scope-confused packets and ID reuse with changed content', async t => {
  const f = await fixture(t); const queued = await f.enqueue(); const packet = f.packet(queued.delivery_id);
  const post = async (input: any, headers = f.signed(input)) => fetch(f.endpoint, { method: 'POST', headers, body: JSON.stringify(input) });
  assert.equal((await post(packet, { ...f.signed(packet), 'X-Knowledger-Delivery-Signature': '0'.repeat(64) })).status, 401);
  assert.equal((await post(packet, f.signed(packet, String(Math.floor(Date.now() / 1000) - 1000)))).status, 401);
  for (const field of ['workspace_id', 'source_id']) {
    const altered = structuredClone(packet); altered.message[field] = 'another-source'; altered.payload_digest = deliveryHash(altered.message);
    assert.ok([401, 403].includes((await post(altered)).status));
  }
  const wrongScope = structuredClone(packet); wrongScope.message.slot.scope_id = 'scope-wrong'; wrongScope.payload_digest = deliveryHash(wrongScope.message);
  assert.equal((await post(wrongScope)).status, 403);
  const first = await (await post(packet)).json(); assert.deepEqual(await (await post(packet)).json(), first);
  const changed = structuredClone(packet); changed.message.comment.body = 'Different content'; changed.payload_digest = deliveryHash(changed.message);
  assert.equal((await post(changed)).status, 409);
  assert.equal((await f.receiver.service.reviewDelivery!.inbox(f.recipient, {})).deliveries.length, 1);
});

test('bad receipts and service outages exhaust a bounded retry budget without claiming confirmed delivery', async t => {
  const f = await fixture(t, { maxAttempts: 2, fetch: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }) });
  await f.enqueue(); await f.sender.service.reviewDelivery!.worker.runOnce(); await delay(40); await f.sender.service.reviewDelivery!.worker.runOnce();
  const row = (await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0];
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 2); assert.equal(row.receipt, null);
  assert.equal(await f.sender.service.reviewDelivery!.worker.runOnce(), 0);
});

test('HTTP enqueue retains session CSRF while machine receive requires peer authentication', async t => {
  const f = await fixture(t); const origin = await f.sender.listen(0); const root = origin + '/v1/workspaces/relay-test';
  const session = await fetch(origin + '/api/session'); const cookie = session.headers.get('set-cookie')!.split(';')[0]; const login = await session.json() as any;
  const path = `${root}/revisions/${encodeURIComponent(f.digest)}/review/deliveries`;
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': login.csrf_token, Origin: origin };
  assert.equal((await fetch(path, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(f.input) })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers, body: JSON.stringify(f.input) })).status, 202);
  for (const suffix of ['/review-delivery-targets', '/review-deliveries', '/review-deliveries/received']) assert.equal((await fetch(root + suffix, { headers: { Cookie: cookie } })).status, 200);
  const packet = f.packet((await f.enqueue()).delivery_id);
  assert.equal((await fetch(f.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(packet) })).status, 401);
});

test('an authorization hook resolving after the delivery deadline cannot start a late network send', async t => {
  let release!: (allowed: boolean) => void; const permission = new Promise<boolean>(resolve => { release = resolve; }); let sends = 0;
  const f = await fixture(t, { timeoutMs: 30, allows: () => permission, fetch: async (url, input) => { sends++; return fetch(url, input); } });
  await f.enqueue(); await f.sender.service.reviewDelivery!.worker.runOnce();
  assert.equal((await f.sender.service.reviewDelivery!.list(f.author, {})).deliveries[0].last_code, 'DELIVERY_TIMEOUT');
  release(true); await delay(10); assert.equal(sends, 0);
});

test('receiver shutdown cancels pending authorization and cannot write a late incoming comment', async t => {
  const f = await fixture(t); const queued = await f.enqueue(); const packet = f.packet(queued.delivery_id);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  (f.receiver.service.reviewDelivery as any).context.currentActor = async () => { entered(); await gate; };
  const receiving = f.receiver.service.reviewDelivery!.receive(packet, Object.fromEntries(new Headers(f.signed(packet)).entries()));
  const rejected = assert.rejects(receiving, (error: any) => error.code === 'DELIVERY_RECEIVER_TIMEOUT');
  await started; await f.receiver.service.reviewDelivery!.close(); await rejected;
  release(); await delay(10);
  assert.equal((f.receiver.service as any).vault.deliveries.inbox(f.recipient, {}).deliveries.length, 0);
});
