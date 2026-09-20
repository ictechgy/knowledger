import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createReviewHttpTransport, createReviewDeliveryAuthenticator } from '../../packages/review/http-delivery.ts';
import { DELIVERY_MAX_BYTES, deliveryHash } from '../../packages/review/delivery-contract.ts';
const message = { schema_version: 1 as const, delivery_id: 'delivery-http', source_id: 'source-app', workspace_id: 'knowledge',
  slot: { channel_id: 'channel-test', document_id: 'doc-test', context_id: 'context-test', scope_id: 'scope-test', usage_scope: 'reference/v1' },
  revision_digest: `sha256:${'a'.repeat(64)}`, recipient: { org_id: 'ReceiverMSP', actor_id: 'reader' },
  comment: { event_id: 'event-comment', author: { org_id: 'SenderMSP', actor_id: 'writer', kind: 'human' as const }, created_at: new Date().toISOString(), body: 'Test comment' } };
const packet = { message, payload_digest: deliveryHash(message) };
const receipt = { schema_version: 1, delivery_id: message.delivery_id, payload_digest: packet.payload_digest, received_at: new Date().toISOString() };

test('HTTP transport uses a fixed address, authenticates its exact payload and never follows redirects', async () => {
  const secret = randomBytes(32); const authenticate = createReviewDeliveryAuthenticator([{ key_id: 'peer-key', secret, source_id: 'source-app', org_id: 'SenderMSP' }]);
  let calls = 0;
  const transport = createReviewHttpTransport({ endpoint: 'https://receiver.invalid/receive', key_id: 'peer-key', secret, fetch: async (url, options) => {
    calls++; assert.equal(url, 'https://receiver.invalid/receive'); assert.equal(options!.redirect, 'error');
    const received = JSON.parse(String(options!.body));
    assert.deepEqual(authenticate(received, Object.fromEntries(new Headers(options!.headers).entries())), { source_id: 'source-app', org_id: 'SenderMSP' });
    return new Response(JSON.stringify(receipt), { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.deepEqual(await transport.send(packet, new AbortController().signal), receipt); assert.equal(calls, 1);
  await assert.rejects(transport.send({ ...packet, message: { ...message, revision_digest: 'wrong' } }, new AbortController().signal)); assert.equal(calls, 1);
  for (const endpoint of ['http://example.invalid/receive', 'https://user:password@example.invalid/receive', 'https://example.invalid/receive?token=x', 'https://example.invalid/receive#fragment']) {
    assert.throws(() => createReviewHttpTransport({ endpoint, key_id: 'peer-key', secret, allowInsecureLoopback: true }));
  }
});

test('transport returns only bounded diagnostic codes and requires an exact receipt, even for HTTP 200', async () => {
  for (const [status, retryable] of [[403, false], [409, false], [429, true], [503, true]] as const) {
    const transport = createReviewHttpTransport({ endpoint: 'https://receiver.invalid', key_id: 'peer-key', secret: randomBytes(32),
      fetch: async () => new Response('PRIVATE_REMOTE_ERROR', { status }) });
    await assert.rejects(transport.send(packet, new AbortController().signal), (error: any) => error.code === `DELIVERY_HTTP_${status}` && error.retryable === retryable && !String(error).includes('PRIVATE_REMOTE_ERROR'));
  }
  for (const response of [JSON.stringify({ ...receipt, delivery_id: 'another-delivery' }), JSON.stringify({ ...receipt, payload_digest: deliveryHash('other') }), 'x'.repeat(DELIVERY_MAX_BYTES + 1)]) {
    const transport = createReviewHttpTransport({ endpoint: 'https://receiver.invalid', key_id: 'peer-key', secret: randomBytes(32),
      fetch: async () => new Response(response, { headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(transport.send(packet, new AbortController().signal), (error: any) => error.code === 'INVALID_DELIVERY_RECEIPT');
  }
});
