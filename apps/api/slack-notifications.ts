import type { Actor } from '../../packages/domain/index.ts';
import type { PrivateStore } from '../../packages/storage/private-store.ts';
import { DeliveryError, deliveryHash, deliveryId, samePerson } from '../../packages/review/delivery-contract.ts';
import { validateSlackResolution } from '../../packages/storage/slack-notice-store.ts';
import type { SlackNotice } from '../../packages/storage/slack-notice-store.ts';
import { createSlackAdapter } from '../../packages/review/slack.ts';
import type { SlackAdapterOptions, SlackAddress } from '../../packages/review/slack.ts';
import { ReviewReminderWorker } from '../../packages/review/reminder-worker.ts';
import type { ReviewReminderOptions } from '../../packages/review/reminder-worker.ts';

export interface SlackNotificationTarget extends SlackAdapterOptions {
  recipient: { org_id: string; actor_id: string }; version: number;
  /** Missing policy denies all external calls. Metadata only; no title, body or comment is supplied. */
  allows?: (request: { recipient: Actor; address: SlackAddress; reminder_id: string; revision_digest: string; phase: 'due' | 'overdue'; signal: AbortSignal }) => boolean | Promise<boolean>;
}
export interface SlackNotificationOptions { targets: SlackNotificationTarget[]; worker?: Pick<ReviewReminderOptions, 'pollMs' | 'timeoutMs' | 'batchSize'> }
interface Context {
  workspaceId: string; refresh(): Promise<void>; actor(actor: Actor): void; currentActor?(actor: Actor): Promise<void>;
  config(): any; revision(digest: string): any;
}
type Target = { recipient: Actor; binding: string; adapter: ReturnType<typeof createSlackAdapter>; allows: SlackNotificationTarget['allows'] };

/** Opt-in external deadline notices. Never writes review events or shared ledger state. */
export class SlackNotificationRuntime {
  readonly worker: ReviewReminderWorker;
  private vault: PrivateStore; private context: Context; private targets: Target[] = [];
  private targetIndex = 0; private cursors = new Map<string, string>(); private closed = false;
  private runs = new Set<Promise<unknown>>();
  private actions = new Set<AbortController>();
  constructor(vault: PrivateStore, context: Context, options: SlackNotificationOptions) {
    this.vault = vault; this.context = context;
    if (!Array.isArray(options.targets) || options.targets.length > 32) throw new TypeError('Invalid Slack notification configuration');
    for (const target of options.targets) {
      if (!target.recipient || Object.keys(target.recipient).sort().join(',') !== 'actor_id,org_id'
        || !deliveryId(target.recipient.org_id) || !deliveryId(target.recipient.actor_id) || !Number.isSafeInteger(target.version) || target.version < 1
        || (target.allows !== undefined && typeof target.allows !== 'function')
        || this.targets.some(previous => samePerson(previous.recipient, target.recipient))) throw new TypeError('Invalid Slack notification target');
      const adapter = createSlackAdapter(target);
      if (this.targets.some(previous => previous.adapter.address.team_id === adapter.address.team_id && previous.adapter.address.dm_id === adapter.address.dm_id)) throw new TypeError('Slack DM must identify one configured recipient');
      const recipient: Actor = { ...target.recipient, kind: 'human' };
      const binding = deliveryHash({ recipient, address: adapter.address, app_url: adapter.appUrl, version: target.version, workspace: context.workspaceId, format: 'deadline-link/v1' });
      this.targets.push({ recipient, adapter, binding, allows: target.allows });
    }
    this.worker = new ReviewReminderWorker((now, signal) => this.generate(now, signal), { pollMs: 60000, timeoutMs: 30000, batchSize: 10, ...options.worker });
  }
  private check(signal: AbortSignal) { signal.throwIfAborted(); if (this.closed) throw new Error('SLACK_SHUTDOWN'); }
  private async authorize(actor: Actor, signal: AbortSignal) {
    this.check(signal); await this.context.refresh(); this.check(signal);
    if (!this.context.config()?.serving_enabled) return false;
    this.context.actor(actor); await this.context.currentActor?.(actor); this.check(signal); this.context.actor(actor);
    return this.context.config()?.identities?.some((identity: Actor) => identity.kind === 'human' && samePerson(identity, actor)) === true;
  }
  private async generate(_now: number, signal: AbortSignal) {
    this.check(signal); if (!this.targets.length) return { scanned: 0, created: 0 };
    const target = this.targets[this.targetIndex++ % this.targets.length]; const actor = target.recipient;
    const cursor = this.cursors.get(target.binding);
    const page = this.vault.reviews.reminders(actor, { limit: Math.min(20, this.worker.batchSize), cursor });
    // No candidate means no ledger refresh and no external calls.
    let created = 0;
    for (const reminder of page.reminders) {
      this.check(signal);
      if (!this.vault.reviews.outboundReminder(actor, reminder.reminder_id, new Date().toISOString())) continue;
      if (!await this.authorize(actor, signal)) continue;
      this.context.revision(reminder.revision_digest); this.check(signal);
      const job = this.vault.slackNotices.claim(actor, reminder.reminder_id, target.binding, target.adapter.address.team_id, target.adapter.address.dm_id, Date.now(), 45000);
      if (!job) continue;
      const sending = (async () => {
        const result = await target.adapter.send(reminder.phase as 'due' | 'overdue', async currentSignal => {
          if (!await this.authorize(actor, currentSignal)) return false;
          const current = this.vault.reviews.outboundReminder(actor, reminder.reminder_id, new Date().toISOString());
          if (!current || current.revision_digest !== reminder.revision_digest || current.phase !== reminder.phase) return false;
          this.context.revision(current.revision_digest);
          if (await target.allows?.({ recipient: { ...actor }, address: { ...target.adapter.address }, reminder_id: reminder.reminder_id,
            revision_digest: reminder.revision_digest, phase: reminder.phase as 'due' | 'overdue', signal: currentSignal }) !== true) return false;
          if (!await this.authorize(actor, currentSignal)) return false;
          this.check(currentSignal); this.context.revision(reminder.revision_digest);
          return Boolean(this.vault.reviews.outboundReminder(actor, reminder.reminder_id, new Date().toISOString()))
            && this.vault.slackNotices.owns(actor, job, Date.now());
        }, signal);
        // Persist an uncertain send during cancellation before the private database is closed.
        this.vault.slackNotices.settle(actor, job, target.adapter.address.team_id, target.adapter.address.dm_id, result, Date.now());
        return result;
      })();
      this.runs.add(sending);
      let result; try { result = await sending; } finally { this.runs.delete(sending); }
      if (result.status === 'provider_accepted') created++;
      this.check(signal);
    }
    if (page.next_cursor) this.cursors.set(target.binding, page.next_cursor); else this.cursors.delete(target.binding);
    return { scanned: page.reminders.length, created };
  }
  private publicJob(actor: Actor, job: SlackNotice, target: Target | undefined) {
    const changed = !target || job.binding !== target.binding;
    const status = job.status === 'sending' && job.lease_until! <= Date.now() ? 'unknown'
      : changed && !['sending', 'provider_accepted', 'user_confirmed', 'dismissed'].includes(job.status) ? 'blocked' : job.status;
    const terminal = ['unknown', 'blocked', 'failed'].includes(status);
    return { reminder_id: job.reminder_id, status, attempts: job.attempts, total_attempts: job.total_attempts, version: job.version, receipt: job.receipt,
      next_attempt_at: status === 'retry_wait' ? new Date(job.next_attempt_at).toISOString() : null,
      last_code: changed ? 'SLACK_TARGET_CHANGED' : job.last_code,
      can_resolve: terminal, can_retry: terminal && target?.binding === job.binding && Boolean(this.vault.reviews.outboundReminder(actor, job.reminder_id, new Date().toISOString())),
      resolutions: this.vault.slackNotices.history(actor, job.reminder_id) };
  }
  summary(actor: Actor, id: string) {
    const target = this.targets.find(target => samePerson(target.recipient, actor));
    if (!target) return null;
    const job = this.vault.slackNotices.get(actor, id);
    if (!job) return { status: this.vault.reviews.outboundReminder(actor, id, new Date().toISOString()) ? 'pending' : 'skipped', attempts: 0, receipt: null, next_attempt_at: null, last_code: null };
    return this.publicJob(actor, job, target);
  }
  private async action<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(); this.actions.add(controller);
    let reject!: (reason: Error) => void; const cancelled = new Promise<never>((_, fail) => { reject = fail; });
    const abort = () => controller.abort(); const onAbort = () => reject(new DeliveryError('SLACK_ACTION_UNAVAILABLE', 503));
    controller.signal.addEventListener('abort', onAbort, { once: true }); signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 10000); if (signal.aborted || this.closed) abort();
    try { return await Promise.race([operation(controller.signal), cancelled]); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); this.actions.delete(controller); controller.abort(); }
  }
  list(actor: Actor, input: { limit?: number; cursor?: string }, signal: AbortSignal) {
    return this.action(signal, current => this.listCurrent(actor, input, current));
  }
  private async listCurrent(actor: Actor, input: { limit?: number; cursor?: string }, signal: AbortSignal) {
    if (!await this.authorize(actor, signal) || actor.kind !== 'human') throw new DeliveryError('SLACK_ACCESS_DENIED', 403);
    const target = this.targets.find(target => samePerson(target.recipient, actor));
    const page = this.vault.slackNotices.list(actor, input);
    return { enabled: true, next_cursor: page.next_cursor, notices: page.notices.map(job => {
      const ref = this.vault.reviews.reminderReference(actor, job.reminder_id); if (!ref) throw new DeliveryError('SLACK_RECORD_UNAVAILABLE', 503);
      const revision = this.context.revision(ref.revision_digest);
      return { ...this.publicJob(actor, job, target), ...ref, title: revision.payload.title };
    }) };
  }
  resolve(actor: Actor, id: string, value: unknown, signal: AbortSignal) {
    return this.action(signal, current => this.resolveCurrent(actor, id, value, current));
  }
  private async resolveCurrent(actor: Actor, id: string, value: unknown, signal: AbortSignal) {
    const input = validateSlackResolution(value); if (!deliveryId(id)) throw new DeliveryError('INVALID_INPUT');
    if (!await this.authorize(actor, signal) || actor.kind !== 'human') throw new DeliveryError('SLACK_ACCESS_DENIED', 403);
    const target = this.targets.find(target => samePerson(target.recipient, actor));
    const replay = this.vault.slackNotices.resolutionReplay(actor, id, input); if (replay) return this.publicJob(actor, replay, target);
    const reference = this.vault.reviews.reminderReference(actor, id); if (!reference) throw new DeliveryError('NOT_FOUND', 404);
    this.context.revision(reference.revision_digest);
    if (input.outcome === 'retry') {
      if (!target || !this.vault.reviews.outboundReminder(actor, id, new Date().toISOString())) throw new DeliveryError('SLACK_RETRY_NOT_ALLOWED', 409);
      if (await target.allows?.({ recipient: { ...actor }, address: { ...target.adapter.address }, reminder_id: id,
        revision_digest: reference.revision_digest, phase: reference.phase, signal }) !== true) throw new DeliveryError('SLACK_ACCESS_DENIED', 403);
      if (!await this.authorize(actor, signal)) throw new DeliveryError('SLACK_ACCESS_DENIED', 403);
      this.context.revision(reference.revision_digest);
    }
    this.check(signal);
    const job = this.vault.slackNotices.resolve(actor, id, target?.binding ?? null, input,
      () => Boolean(this.vault.reviews.outboundReminder(actor, id, new Date().toISOString())), Date.now());
    return this.publicJob(actor, job, target);
  }
  async close() {
    this.closed = true; for (const action of this.actions) action.abort(); await this.worker.close();
    // Adapter cancellation races callbacks, so every active DB settlement ends promptly.
    await Promise.allSettled([...this.runs]);
  }
}
