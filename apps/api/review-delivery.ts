import { randomUUID } from 'node:crypto';
import { canonicalize } from '../../packages/domain/index.ts';
import type { Actor } from '../../packages/domain/index.ts';
import { slotFields } from '../../packages/config/types.ts';
import type { PrivateStore } from '../../packages/storage/private-store.ts';
import type { DeliveryJob } from '../../packages/storage/review-delivery-store.ts';
import { DeliveryError, deliveryHash, deliveryId, samePerson, validateReviewPacket } from '../../packages/review/delivery-contract.ts';
import type { ReviewDestination, ReviewPacket } from '../../packages/review/delivery-contract.ts';
import { ReviewDeliveryWorker } from '../../packages/review/delivery-worker.ts';
import type { DeliveryWorkerOptions } from '../../packages/review/delivery-worker.ts';
import { createReviewDeliveryAuthenticator } from '../../packages/review/http-delivery.ts';
import type { ReviewDeliveryPeer } from '../../packages/review/http-delivery.ts';

export interface ReviewDeliveryOptions {
  source_id: string; source_org_id: string;
  destinations?: ReviewDestination[]; peers?: ReviewDeliveryPeer[]; worker?: DeliveryWorkerOptions;
}
export interface ReviewDeliveryContext {
  workspaceId: string; channelId: string; refresh(): Promise<void>; actor(actor: Actor): void;
  currentActor?(actor: Actor): Promise<void>;
  config(): any; revision(digest: string): any;
}
const only = (input: any, allowed: string[]) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new DeliveryError('INVALID_INPUT'); };
type Target = ReviewDestination & { binding: string };

export class ReviewDeliveryRuntime {
  readonly worker: ReviewDeliveryWorker;
  private vault: PrivateStore; private context: ReviewDeliveryContext;
  private sourceId: string; private sourceOrg: string;
  private destinations = new Map<string, Target>();
  private authenticate: ReturnType<typeof createReviewDeliveryAuthenticator>;
  private inbound = new Map<AbortController, () => void>();
  private closed = false;
  constructor(vault: PrivateStore, context: ReviewDeliveryContext, options: ReviewDeliveryOptions) {
    this.vault = vault; this.context = context;
    if (!deliveryId(options.source_id) || !deliveryId(options.source_org_id) || !Array.isArray(options.destinations ?? []) || (options.destinations?.length ?? 0) > 32) throw new TypeError('Invalid review delivery configuration');
    this.sourceId = options.source_id; this.sourceOrg = options.source_org_id;
    for (const target of options.destinations ?? []) {
      if (!deliveryId(target.id) || this.destinations.has(target.id) || typeof target.label !== 'string' || !target.label.trim() || target.label.length > 120
        || !Number.isSafeInteger(target.version) || target.version < 1 || !deliveryId(target.recipient?.org_id) || !deliveryId(target.recipient?.actor_id)
        || Object.keys(target.recipient).sort().join(',') !== 'actor_id,org_id'
        || typeof target.transport?.binding !== 'string' || !target.transport.binding || target.transport.binding.length > 512 || typeof target.transport.send !== 'function'
        || (target.allows !== undefined && typeof target.allows !== 'function')) throw new TypeError('Invalid review delivery destination');
      const binding = deliveryHash({ id: target.id, version: target.version, recipient: target.recipient, transport: target.transport.binding });
      this.destinations.set(target.id, { ...target, recipient: { ...target.recipient }, transport: { binding: target.transport.binding, send: target.transport.send.bind(target.transport) }, binding });
    }
    this.authenticate = createReviewDeliveryAuthenticator(options.peers ?? []);
    this.worker = new ReviewDeliveryWorker(vault.deliveries, (job, signal) => this.deliver(job, signal), options.worker);
  }
  private async authorize(actor: Actor, signal?: AbortSignal) {
    if (this.closed) throw new DeliveryError('DELIVERY_SHUTDOWN', 503, true);
    signal?.throwIfAborted();
    await this.context.refresh(); signal?.throwIfAborted();
    if (this.closed) throw new DeliveryError('DELIVERY_SHUTDOWN', 503, true);
    this.context.actor(actor);
    await this.context.currentActor?.(actor); signal?.throwIfAborted();
    if (this.closed) throw new DeliveryError('DELIVERY_SHUTDOWN', 503, true);
    this.context.actor(actor);
  }
  private member(actor: Actor) {
    if (!this.context.config()?.identities?.some((identity: Actor) => samePerson(identity, actor) && identity.kind === actor.kind)) throw new DeliveryError('DELIVERY_MEMBER_UNAVAILABLE', 403);
  }
  private target(id: string): Target {
    const target = this.destinations.get(id);
    if (!target) throw new DeliveryError('DELIVERY_DESTINATION_UNAVAILABLE', 403);
    this.member({ ...target.recipient, kind: 'human' }); return target;
  }
  private validateMessage(packet: ReviewPacket) {
    const message = packet.message;
    if (message.workspace_id !== this.context.workspaceId || message.slot.channel_id !== this.context.channelId) throw new DeliveryError('DELIVERY_SCOPE_MISMATCH', 403);
    let revision;
    try { revision = this.context.revision(message.revision_digest); }
    catch (error: any) { if (error?.status === 404) throw new DeliveryError('DELIVERY_REVISION_UNAVAILABLE', 503, true); throw error; }
    if (canonicalize(slotFields(revision.payload)) !== canonicalize(message.slot)) throw new DeliveryError('DELIVERY_SCOPE_MISMATCH', 403);
    this.member(message.comment.author); this.member({ ...message.recipient, kind: 'human' });
  }
  private originComment(packet: ReviewPacket) {
    const m = packet.message;
    if (m.source_id !== this.sourceId || m.comment.author.org_id !== this.sourceOrg) throw new DeliveryError('DELIVERY_SOURCE_CHANGED', 403);
    const event = this.vault.reviews.event(m.comment.event_id);
    if (!event || event.kind !== 'comment' || event.revision_digest !== m.revision_digest
      || canonicalize({ event_id: event.event_id, author: event.author, created_at: event.created_at, body: event.body }) !== canonicalize(m.comment)) throw new DeliveryError('DELIVERY_COMMENT_MISMATCH', 403);
  }
  private summary(job: DeliveryJob) {
    return { delivery_id: job.packet.message.delivery_id, event_id: job.packet.message.comment.event_id, revision_digest: job.packet.message.revision_digest,
      target_id: job.target_id, recipient: job.packet.message.recipient, status: job.status, attempts: job.attempts, total_attempts: job.total_attempts,
      next_attempt_at: new Date(job.next_attempt_at).toISOString(), last_code: job.last_code, receipt: job.receipt };
  }
  async targets(actor: Actor) {
    await this.authorize(actor);
    return { enabled: true, targets: actor.org_id === this.sourceOrg ? [...this.destinations.values()].filter(target => this.context.config().identities.some((i: Actor) => samePerson(i, target.recipient) && i.kind === 'human'))
      .map(target => ({ id: target.id, label: target.label, version: target.version, recipient: { ...target.recipient } })) : [] };
  }
  async enqueue(actor: Actor, digest: string, input: any) {
    only(input, ['operation_id', 'event_id', 'destination_id', 'destination_version', 'confirm_shared']);
    if (![input.operation_id, input.event_id, input.destination_id].every(deliveryId) || !Number.isSafeInteger(input.destination_version) || input.destination_version < 1
      || input.confirm_shared !== true) throw new DeliveryError('DELIVERY_CONFIRMATION_REQUIRED');
    await this.authorize(actor);
    if (actor.org_id !== this.sourceOrg) throw new DeliveryError('DELIVERY_SOURCE_MISMATCH', 403);
    const target = this.target(input.destination_id);
    if (target.version !== input.destination_version) throw new DeliveryError('DELIVERY_DESTINATION_CHANGED', 409);
    const event = this.vault.reviews.event(input.event_id);
    if (!event || event.revision_digest !== digest || event.kind !== 'comment' || !samePerson(event.author, actor) || event.author.kind !== actor.kind) throw new DeliveryError('NOT_FOUND', 404);
    const revision = this.context.revision(digest);
    const message = { schema_version: 1 as const, delivery_id: `delivery-${randomUUID()}`, source_id: this.sourceId, workspace_id: this.context.workspaceId,
      slot: slotFields(revision.payload), revision_digest: digest, recipient: target.recipient,
      comment: { event_id: event.event_id, author: event.author, created_at: event.created_at, body: event.body } };
    const packet = validateReviewPacket({ message, payload_digest: deliveryHash(message) });
    return this.summary(this.vault.deliveries.enqueue(actor, input.operation_id, { digest, input, target_binding: target.binding }, target, packet, Date.now()));
  }
  private async deliver(job: DeliveryJob, signal: AbortSignal) {
    try {
      const packet = validateReviewPacket(job.packet); const author = packet.message.comment.author;
      await this.authorize(author, signal); this.validateMessage(packet); this.originComment(packet);
      const target = this.target(job.target_id);
      if (target.binding !== job.target_binding || !samePerson(target.recipient, packet.message.recipient)) throw new DeliveryError('DELIVERY_DESTINATION_CHANGED', 403);
      if (target.allows && await target.allows({ author: { ...author }, recipient: { ...target.recipient }, revision_digest: packet.message.revision_digest, signal }) !== true) throw new DeliveryError('DELIVERY_POLICY_DENIED', 403);
      // Policy hooks can wait while membership or serving state changes; refresh again before sending.
      await this.authorize(author, signal); this.validateMessage(packet); this.context.actor(author); signal.throwIfAborted();
      return await target.transport.send(structuredClone(packet), signal);
    } catch (error: any) {
      if (error instanceof DeliveryError) throw error;
      if (error?.status >= 400 && error?.status < 500) throw new DeliveryError('DELIVERY_AUTHORIZATION_DENIED', 403);
      throw new DeliveryError('DELIVERY_UNAVAILABLE', 503, true);
    }
  }
  async list(actor: Actor, input: { limit?: number; cursor?: string }) {
    only(input, ['limit', 'cursor']); await this.authorize(actor);
    const page = this.vault.deliveries.list(actor, input);
    return { deliveries: page.jobs.map(job => this.summary(job)), next_cursor: page.next_cursor };
  }
  async retry(actor: Actor, id: string, input: any) {
    only(input, []); if (!deliveryId(id)) throw new DeliveryError('INVALID_INPUT'); await this.authorize(actor);
    const job = this.vault.deliveries.get(actor, id); const target = this.target(job.target_id);
    if (target.binding !== job.target_binding) throw new DeliveryError('DELIVERY_DESTINATION_CHANGED', 409);
    this.validateMessage(job.packet); this.originComment(job.packet);
    return this.summary(this.vault.deliveries.retry(actor, id, Date.now()));
  }
  async receive(input: any, headers: Record<string, string | string[] | undefined>) {
    if (this.closed) throw new DeliveryError('DELIVERY_SHUTDOWN', 503, true);
    const packet = validateReviewPacket(input); this.authenticate(packet, headers);
    if (packet.message.recipient.org_id !== this.sourceOrg) throw new DeliveryError('DELIVERY_RECIPIENT_MISMATCH', 403);
    if (this.inbound.size >= 4) throw new DeliveryError('DELIVERY_RECEIVER_BUSY', 429, true);
    const controller = new AbortController();
    let rejectDeadline!: (reason: unknown) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const cancel = () => { controller.abort(); rejectDeadline(new DeliveryError('DELIVERY_RECEIVER_TIMEOUT', 503, true)); };
    this.inbound.set(controller, cancel);
    const timer = setTimeout(cancel, 10000);
    try {
      return await Promise.race([deadline, (async () => {
        await this.authorize({ ...packet.message.recipient, kind: 'human' }, controller.signal);
        this.validateMessage(packet); controller.signal.throwIfAborted();
        return this.vault.deliveries.receive(packet);
      })()]);
    } finally { clearTimeout(timer); controller.abort(); this.inbound.delete(controller); }
  }
  async inbox(actor: Actor, input: { limit?: number; cursor?: string }) {
    only(input, ['limit', 'cursor']); await this.authorize(actor);
    const page = this.vault.deliveries.inbox(actor, input);
    for (const delivery of page.deliveries) this.context.revision(delivery.packet.message.revision_digest);
    return page;
  }
  async close() {
    this.closed = true;
    for (const cancel of this.inbound.values()) cancel();
    await this.worker.close();
  }
}
