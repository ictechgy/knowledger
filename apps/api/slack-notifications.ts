import type { Actor } from '../../packages/domain/index.ts';
import type { PrivateStore } from '../../packages/storage/private-store.ts';
import { deliveryHash, deliveryId, samePerson } from '../../packages/review/delivery-contract.ts';
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
  summary(actor: Actor, id: string) {
    const target = this.targets.find(target => samePerson(target.recipient, actor));
    if (!target) return null;
    const job = this.vault.slackNotices.get(actor, id);
    if (!job) return { status: this.vault.reviews.outboundReminder(actor, id, new Date().toISOString()) ? 'pending' : 'skipped', attempts: 0, receipt: null, next_attempt_at: null, last_code: null };
    const status = job.status === 'sending' && job.lease_until! <= Date.now() ? 'unknown'
      : job.binding !== target.binding && job.status !== 'provider_accepted' ? 'blocked' : job.status;
    return { status, attempts: job.attempts, receipt: job.receipt,
      next_attempt_at: status === 'retry_wait' ? new Date(job.next_attempt_at).toISOString() : null,
      last_code: job.binding !== target.binding ? 'SLACK_TARGET_CHANGED' : job.last_code };
  }
  async close() {
    this.closed = true; await this.worker.close();
    // Adapter cancellation races callbacks, so every active DB settlement ends promptly.
    await Promise.allSettled([...this.runs]);
  }
}
