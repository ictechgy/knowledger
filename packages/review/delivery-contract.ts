import { createHash } from 'node:crypto';
import { canonicalize } from '../domain/index.ts';
import type { Actor, Slot } from '../domain/index.ts';
import type { ReviewPerson } from '../storage/review-store.ts';

export const DELIVERY_MAX_BYTES = 32 * 1024;
export const deliveryId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(value);
export const deliveryIso = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const deliveryHash = (value: unknown): string => `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
export const samePerson = (a: ReviewPerson, b: ReviewPerson): boolean => a.org_id === b.org_id && a.actor_id === b.actor_id;
const fields = (value: any, names: string[]) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === names.sort().join(',');
const person = (value: any) => fields(value, ['org_id', 'actor_id']) && deliveryId(value.org_id) && deliveryId(value.actor_id);

export interface ReviewMessage {
  schema_version: 1; delivery_id: string; source_id: string; workspace_id: string;
  slot: Slot; revision_digest: string; recipient: ReviewPerson;
  comment: { event_id: string; author: Actor; created_at: string; body: string };
}
export interface ReviewPacket { message: ReviewMessage; payload_digest: string }
export interface ReviewReceipt { schema_version: 1; delivery_id: string; payload_digest: string; received_at: string }
export class DeliveryError extends Error {
  readonly code: string; readonly status: number; readonly retryable: boolean;
  constructor(code: string, status = 400, retryable = false) {
    super('검토 전달 요청 또는 현재 전달 상태를 확인할 수 없습니다.'); this.code = code; this.status = status; this.retryable = retryable;
  }
}
export function validateReviewPacket(value: any): ReviewPacket {
  try {
    if (!fields(value, ['message', 'payload_digest']) || Buffer.byteLength(canonicalize(value)) > DELIVERY_MAX_BYTES) throw new Error();
    const m = value.message;
    if (!fields(m, ['schema_version', 'delivery_id', 'source_id', 'workspace_id', 'slot', 'revision_digest', 'recipient', 'comment']) || m.schema_version !== 1
      || ![m.delivery_id, m.source_id, m.workspace_id].every(deliveryId) || !person(m.recipient)
      || !/^sha256:[a-f0-9]{64}$/.test(m.revision_digest) || !fields(m.slot, ['channel_id', 'document_id', 'context_id', 'scope_id', 'usage_scope'])
      || ![m.slot.channel_id, m.slot.document_id, m.slot.context_id, m.slot.scope_id].every(deliveryId)
      || typeof m.slot.usage_scope !== 'string' || !/^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/.test(m.slot.usage_scope)
      || !fields(m.comment, ['event_id', 'author', 'created_at', 'body']) || !deliveryId(m.comment.event_id) || !deliveryIso(m.comment.created_at)
      || !fields(m.comment.author, ['org_id', 'actor_id', 'kind']) || !deliveryId(m.comment.author.org_id) || !deliveryId(m.comment.author.actor_id)
      || !['human', 'agent'].includes(m.comment.author.kind) || typeof m.comment.body !== 'string' || !m.comment.body.trim() || m.comment.body.length > 4000
      || value.payload_digest !== deliveryHash(m)) throw new Error();
    return structuredClone(value);
  } catch { throw new DeliveryError('INVALID_DELIVERY_PACKET'); }
}
export function validateReviewReceipt(value: any, packet: ReviewPacket): ReviewReceipt {
  if (!fields(value, ['schema_version', 'delivery_id', 'payload_digest', 'received_at']) || value.schema_version !== 1
    || value.delivery_id !== packet.message.delivery_id || value.payload_digest !== packet.payload_digest || !deliveryIso(value.received_at)) {
    throw new DeliveryError('INVALID_DELIVERY_RECEIPT', 502, true);
  }
  return structuredClone(value);
}
/** A receipt confirms receiver storage, never human review or a Fabric commit. */
export interface ReviewTransport {
  /** Stable destination identity, including endpoint and tenant. Changing it blocks old queue entries. */
  binding: string;
  send(packet: ReviewPacket, signal: AbortSignal): Promise<ReviewReceipt>;
}
export interface ReviewDestination {
  id: string; label: string; version: number; recipient: ReviewPerson; transport: ReviewTransport;
  allows?: (input: { author: Actor; recipient: ReviewPerson; revision_digest: string; signal: AbortSignal }) => boolean | Promise<boolean>;
}
