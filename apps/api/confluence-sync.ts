import { randomUUID } from 'node:crypto';
import type { Actor } from '../../packages/domain/index.ts';
import type { PrivateStore } from '../../packages/storage/private-store.ts';
import { deliveryHash, deliveryId, samePerson } from '../../packages/review/delivery-contract.ts';
import { syncConfluenceSource, validateConfluenceSourceOptions } from '../../packages/connectors/confluence.ts';
import type { ConfluenceSourceOptions } from '../../packages/connectors/confluence.ts';
import type { SyncClient } from '../../packages/connectors/sync-markdown.ts';

export interface ConfluenceSchedule {
  owner: { org_id: string; actor_id: string }; source: Omit<ConfluenceSourceOptions, 'signal'>;
  intervalMs?: number; timeoutMs?: number;
}
export interface ConfluenceSyncOptions { sources: ConfluenceSchedule[]; pollMs?: number }
interface Context {
  workspaceId: string; authorize(actor: Actor, signal: AbortSignal): Promise<void>;
  request(actor: Actor, sourceId: string, path: string, options: { method?: 'GET' | 'POST'; body?: any }, guard: () => Promise<void>): Promise<any>;
}
interface ScheduleState {
  binding: string; next_run_at: number; last_run_at: number | null; status: 'running' | 'completed' | 'failed';
  lease_token: string | null; lease_until: number | null; last_code: string | null;
  counts: { imported: number; unchanged: number; skipped: number; removed: number } | null;
}
type Target = { owner: Actor; source: Omit<ConfluenceSourceOptions, 'signal'>; binding: string; interval: number; timeout: number };
const bound = (n: number, min: number, max: number) => { if (!Number.isSafeInteger(n) || n < min || n > max) throw new TypeError('Invalid Confluence schedule'); return n; };
const safeTime = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < 253402300799999;

/** Durable source leases and due times; source imports retain their own CAS and private ownership. */
export class ConfluenceSyncRuntime {
  private vault: PrivateStore; private context: Context; private targets: Target[]; private poll: number;
  private timer?: ReturnType<typeof setTimeout>; private controller?: AbortController; private flight?: Promise<void>;
  private closed = false; private started = false;
  constructor(vault: PrivateStore, context: Context, options: ConfluenceSyncOptions) {
    this.vault = vault; this.context = context; this.poll = bound(options.pollMs ?? 1000, 0, 3600000);
    if (!Array.isArray(options.sources) || options.sources.length > 16) throw new TypeError('Invalid Confluence schedules');
    this.targets = options.sources.map(target => {
      if (!target.owner || Object.keys(target.owner).sort().join(',') !== 'actor_id,org_id' || !deliveryId(target.owner.org_id) || !deliveryId(target.owner.actor_id)
        || !deliveryId(target.source?.source_id) || typeof target.source.getAccessToken !== 'function' || typeof target.source.allows !== 'function'
        || !Array.isArray(target.source.pages)) throw new TypeError('Invalid Confluence schedule');
      const source = { ...target.source, pages: structuredClone(target.source.pages) };
      validateConfluenceSourceOptions(source);
      const owner: Actor = { ...target.owner, kind: 'human' };
      return { source, owner, interval: bound(target.intervalMs ?? 900000, 1000, 86400000), timeout: bound(target.timeoutMs ?? 60000, 10, 120000),
        binding: deliveryHash({ workspace: context.workspaceId, owner, cloud_id: source.cloud_id, source_id: source.source_id, pages: source.pages }) };
    });
    if (this.targets.some((target, i) => this.targets.slice(0, i).some(other => samePerson(other.owner, target.owner) && other.source.source_id === target.source.source_id))) throw new TypeError('Duplicate Confluence schedule');
  }
  private state(target: Target): ScheduleState | undefined {
    const value = this.vault.get('source-schedule', target.source.source_id, target.owner);
    if (!value) return undefined;
    if (!/^sha256:[a-f0-9]{64}$/.test(value.binding) || !safeTime(value.next_run_at) || (value.last_run_at !== null && !safeTime(value.last_run_at))
      || !['running', 'completed', 'failed'].includes(value.status) || (value.last_code !== null && !/^[A-Z_]{3,64}$/.test(value.last_code))
      || (value.status === 'running' ? !/^[a-f0-9-]{36}$/.test(value.lease_token) || !safeTime(value.lease_until) : value.lease_token !== null || value.lease_until !== null)
      || (value.counts !== null && (Object.keys(value.counts).sort().join(',') !== 'imported,removed,skipped,unchanged' || Object.values(value.counts).some(n => !Number.isSafeInteger(n) || (n as number) < 0)))) throw new Error('CONFLUENCE_SCHEDULE_CORRUPT');
    return value;
  }
  start() {
    if (this.started || this.closed || !this.poll) return; this.started = true;
    const tick = async () => { try { await this.runOnce(); } catch { /* fixed status codes are persisted per source */ }
      if (!this.closed) { this.timer = setTimeout(tick, this.poll); this.timer.unref(); } };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve(); if (this.flight) return this.flight;
    const work = this.run().finally(() => { if (this.flight === work) this.flight = undefined; }); this.flight = work; return work;
  }
  private async run() {
    for (const target of this.targets) {
      if (this.closed) return; const now = Date.now();
      const claimed = this.vault.atomic(() => {
        const previous = this.state(target);
        if (previous?.status === 'running' && previous.lease_until! > now || previous?.binding === target.binding && previous.next_run_at > now) return null;
        const next: ScheduleState = { binding: target.binding, status: 'running', lease_token: randomUUID(), lease_until: now + target.timeout + 5000,
          next_run_at: now, last_run_at: now, last_code: null, counts: null };
        this.vault.replace('source-schedule', target.source.source_id, target.owner, next); return next;
      });
      if (!claimed) continue;
      const controller = new AbortController(); this.controller = controller;
      let reject!: (error: Error) => void; const cancelled = new Promise<never>((_, fail) => { reject = fail; });
      const abort = () => reject(new Error('CONFLUENCE_SYNC_CANCELLED')); controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(), target.timeout);
      const guard = async () => {
        controller.signal.throwIfAborted(); if (this.closed) throw new Error('CONFLUENCE_SYNC_CANCELLED');
        await this.context.authorize(target.owner, controller.signal); controller.signal.throwIfAborted();
        const current = this.state(target);
        if (!current || current.binding !== target.binding || current.lease_token !== claimed.lease_token || current.lease_until! <= Date.now()) throw new Error('CONFLUENCE_SYNC_CANCELLED');
      };
      const client: SyncClient = { request: async <T>(path: string, input: any) => {
        await guard(); const result = await this.context.request(target.owner, target.source.source_id, path, input, guard); controller.signal.throwIfAborted(); return result as T;
      } };
      let counts: ScheduleState['counts'] = null; let code: string | null = null;
      try {
        const work = async () => { await guard(); return syncConfluenceSource(client, { ...target.source, signal: controller.signal,
          getAccessToken: async signal => { await guard(); const value = await target.source.getAccessToken(signal); await guard(); return value; },
          allows: async request => { await guard(); const allowed = await target.source.allows(request); await guard(); return allowed; },
        }); };
        counts = (await Promise.race([work(), cancelled])).counts;
      } catch (error: any) {
        const known = ['CONFLUENCE_ACCESS_DENIED', 'CONFLUENCE_NOT_ACCESSIBLE', 'CONFLUENCE_SOURCE_CHANGED', 'CONFLUENCE_VERSION_CONFLICT', 'CONFLUENCE_UNSUPPORTED_CONTENT',
          'OAUTH_REFRESH_UNCONFIRMED', 'OAUTH_RECONNECT_REQUIRED', 'OAUTH_ACCESS_DENIED'];
        code = controller.signal.aborted ? 'CONFLUENCE_SYNC_CANCELLED' : known.includes(error?.code) ? error.code : 'CONFLUENCE_SYNC_UNAVAILABLE';
      } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort(); this.controller = undefined; }
      this.vault.atomic(() => {
        const current = this.state(target); if (current?.lease_token !== claimed.lease_token) return;
        this.vault.replace('source-schedule', target.source.source_id, target.owner, { ...claimed, status: code ? 'failed' : 'completed',
          lease_token: null, lease_until: null, next_run_at: Date.now() + target.interval, last_code: code, counts });
      });
    }
  }
  list(actor: Actor) {
    return this.targets.filter(target => samePerson(target.owner, actor)).map(target => {
      const state = this.state(target);
      return { source_id: target.source.source_id, interval_ms: target.interval, enabled: Boolean(this.poll), status: state?.status ?? 'pending',
        next_run_at: state ? new Date(state.next_run_at).toISOString() : null, last_run_at: state?.last_run_at ? new Date(state.last_run_at).toISOString() : null,
        last_code: state?.last_code ?? null, counts: state?.counts ?? null };
    });
  }
  async close() { this.closed = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.flight; }
}
