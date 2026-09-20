import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseStrictJson } from '../fabric/canonical.ts';
import { DELIVERY_MAX_BYTES, DeliveryError, deliveryHash, deliveryId, validateReviewPacket, validateReviewReceipt } from './delivery-contract.ts';
import type { ReviewPacket, ReviewTransport } from './delivery-contract.ts';

export interface ReviewDeliveryPeer { key_id: string; secret: Uint8Array; source_id: string; org_id: string }
const signature = (secret: Uint8Array, key: string, timestamp: string, digest: string) => createHmac('sha256', secret)
  .update(`knowledger-review-delivery-v1\n${key}\n${timestamp}\n${digest}`).digest('hex');
const secretCopy = (value: Uint8Array) => { if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 128) throw new TypeError('Review delivery requires a 32 to 128 byte secret'); return Buffer.from(value); };

/** Fixed operator-configured URL; user input never selects the network destination. */
export function createReviewHttpTransport(options: { endpoint: string; key_id: string; secret: Uint8Array; allowInsecureLoopback?: boolean; fetch?: typeof fetch }): ReviewTransport {
  const url = new URL(options.endpoint);
  if (!deliveryId(options.key_id) || url.username || url.password || url.search || url.hash
    || !(url.protocol === 'https:' || options.allowInsecureLoopback === true && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Review delivery requires a fixed HTTPS endpoint');
  const secret = secretCopy(options.secret); const key = options.key_id;
  const fetchImpl = options.fetch ?? fetch;
  return { binding: deliveryHash({ endpoint: url.href }), async send(input, signal) {
    const packet = validateReviewPacket(input); const timestamp = String(Math.floor(Date.now() / 1000));
    try {
      const response = await fetchImpl(url.href, { method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'X-Knowledger-Delivery-Key': key, 'X-Knowledger-Delivery-Time': timestamp,
          'X-Knowledger-Delivery-Signature': signature(secret, key, timestamp, packet.payload_digest) }, body: JSON.stringify(packet) });
      if (!response.ok) {
        try { await response.body?.cancel(); } catch { /* Never read remote error diagnostics. */ }
        throw new DeliveryError(`DELIVERY_HTTP_${response.status}`, response.status, [408, 429, 500, 502, 503, 504].includes(response.status));
      }
      if (!response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')) {
        try { await response.body?.cancel(); } catch { /* discard */ }
        throw new DeliveryError('INVALID_DELIVERY_RECEIPT', 502, true);
      }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > DELIVERY_MAX_BYTES) { await reader.cancel(); throw new DeliveryError('INVALID_DELIVERY_RECEIPT', 502, true); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      return validateReviewReceipt(parseStrictJson(Buffer.concat(chunks)), packet);
    } catch (error) {
      if (error instanceof DeliveryError) throw error;
      throw new DeliveryError(signal.aborted ? 'DELIVERY_TIMEOUT' : 'DELIVERY_UNAVAILABLE', 503, true);
    }
  } };
}

/** The sending application attests the author; this is not an individual human approval signature. */
export function createReviewDeliveryAuthenticator(input: ReviewDeliveryPeer[]) {
  if (!Array.isArray(input) || input.length > 32) throw new TypeError('Invalid review delivery peers');
  const peers = new Map<string, ReviewDeliveryPeer>();
  for (const peer of input) {
    if (![peer.key_id, peer.source_id, peer.org_id].every(deliveryId) || peers.has(peer.key_id)) throw new TypeError('Invalid review delivery peers');
    peers.set(peer.key_id, { ...peer, secret: secretCopy(peer.secret) });
  }
  return (packet: ReviewPacket, headers: Record<string, string | string[] | undefined>) => {
    const key = headers['x-knowledger-delivery-key']; const time = headers['x-knowledger-delivery-time']; const supplied = headers['x-knowledger-delivery-signature'];
    const peer = typeof key === 'string' ? peers.get(key) : undefined;
    if (!peer || typeof time !== 'string' || !/^[0-9]{10,11}$/.test(time) || Math.abs(Date.now() / 1000 - Number(time)) > 300
      || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
      || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(signature(peer.secret, peer.key_id, time, packet.payload_digest), 'hex'))
      || packet.message.source_id !== peer.source_id || packet.message.comment.author.org_id !== peer.org_id) throw new DeliveryError('DELIVERY_UNAUTHENTICATED', 401);
    return { source_id: peer.source_id, org_id: peer.org_id };
  };
}
