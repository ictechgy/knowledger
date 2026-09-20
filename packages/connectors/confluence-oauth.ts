import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { boundedJson } from '../http/bounded-json.ts';
import { canonicalize } from '../domain/index.ts';

interface GrantBase { version: number; grant_id: string; client_id: string }
export type ConfluenceGrant = GrantBase & ({ state: 'ready'; access_token: string; refresh_token: string; expires_at: number; scope: string }
  | { state: 'refreshing'; attempt_id: string; started_at: number });
/** A secret backend must persist CAS atomically across processes; versions must never be reused. */
export interface ConfluenceGrantStore {
  load(grantId: string, signal: AbortSignal): Promise<ConfluenceGrant>;
  compareAndSwap(grantId: string, expectedVersion: number, next: ConfluenceGrant, signal: AbortSignal): Promise<boolean>;
}
export interface ConfluenceOAuthOptions {
  grantId: string; clientId: string; store: ConfluenceGrantStore;
  getClientSecret(signal: AbortSignal): string | Promise<string>;
  allows?: (request: { grant_id: string; phase: 'use' | 'refresh'; signal: AbortSignal }) => boolean | Promise<boolean>;
  timeoutMs?: number; refreshBeforeMs?: number; fetch?: typeof fetch;
}
export class ConfluenceOAuthError extends Error {
  readonly code: string; readonly status = 503;
  constructor(code: string) { super('Confluence 인증 상태를 확인하거나 다시 연결해야 합니다.'); this.code = code; }
}
const token = (value: unknown): value is string => typeof value === 'string' && /^[!-~]{1,8192}$/.test(value);
const time = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) < 253402300799999;
function grant(value: any, id: string, client: string): ConfluenceGrant {
  const fields = value?.state === 'ready' ? 'access_token,client_id,expires_at,grant_id,refresh_token,scope,state,version' : 'attempt_id,client_id,grant_id,started_at,state,version';
  if (!value || Object.keys(value).sort().join(',') !== fields || value.grant_id !== id || value.client_id !== client
    || !Number.isSafeInteger(value.version) || value.version < 1 || value.version > Number.MAX_SAFE_INTEGER - 2
    || (value.state === 'ready' ? !token(value.access_token) || !token(value.refresh_token) || !time(value.expires_at)
      || typeof value.scope !== 'string' || value.scope.length > 4096 || !value.scope.split(' ').includes('read:page:confluence')
      : value.state !== 'refreshing' || !/^[a-f0-9-]{36}$/.test(value.attempt_id) || !time(value.started_at))) throw new ConfluenceOAuthError('OAUTH_STORE_UNAVAILABLE');
  return structuredClone(value);
}

/** Refresh-only 3LO lifecycle. Initial consent and the durable secret backend belong to deployment. */
export function createConfluenceOAuthProvider(options: ConfluenceOAuthOptions) {
  const { grantId, clientId, store, getClientSecret, allows } = options;
  const timeout = options.timeoutMs ?? 10000; const margin = options.refreshBeforeMs ?? 30000; const fetchImpl = options.fetch ?? fetch;
  if (typeof grantId !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(grantId) || !token(clientId)
    || typeof store?.load !== 'function' || typeof store.compareAndSwap !== 'function' || typeof getClientSecret !== 'function'
    || (allows !== undefined && typeof allows !== 'function') || !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 30000
    || !Number.isSafeInteger(margin) || margin < 0 || margin > 300000) throw new TypeError('Invalid Confluence OAuth configuration');
  const controllers = new Set<AbortController>(); let closed = false;
  return {
    async getAccessToken(signal: AbortSignal): Promise<string> {
      const controller = new AbortController(); controllers.add(controller); const deadline = performance.now() + timeout;
      const check = () => { if (closed || controller.signal.aborted || performance.now() >= deadline) throw new ConfluenceOAuthError('OAUTH_CANCELLED'); };
      let reject!: (error: ConfluenceOAuthError) => void; const cancelled = new Promise<never>((_, fail) => { reject = fail; });
      const abort = () => controller.abort(); const onAbort = () => reject(new ConfluenceOAuthError('OAUTH_CANCELLED'));
      controller.signal.addEventListener('abort', onAbort, { once: true }); signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeout); if (closed || signal.aborted) abort();
      const permit = async (phase: 'use' | 'refresh') => { check(); const allowed = await allows?.({ grant_id: grantId, phase, signal: controller.signal }); check(); if (allowed !== true) throw new ConfluenceOAuthError('OAUTH_ACCESS_DENIED'); };
      const load = async () => { check(); const value = await store.load(grantId, controller.signal); check(); return grant(value, grantId, clientId); };
      const work = async () => {
        await permit('use'); const current = await load();
        if (current.state === 'refreshing') throw new ConfluenceOAuthError('OAUTH_REFRESH_UNCONFIRMED');
        if (current.expires_at > Date.now() + margin) {
          await permit('use'); const latest = await load();
          if (latest.version !== current.version || canonicalize(latest) !== canonicalize(current) || current.expires_at <= Date.now()) throw new ConfluenceOAuthError('OAUTH_GRANT_CHANGED');
          return current.access_token;
        }
        await permit('refresh'); const secret = await getClientSecret(controller.signal); check();
        if (!token(secret)) throw new ConfluenceOAuthError('OAUTH_CREDENTIAL_UNAVAILABLE');
        await permit('refresh');
        const marked: ConfluenceGrant = { grant_id: grantId, client_id: clientId, version: current.version + 1, state: 'refreshing', attempt_id: randomUUID(), started_at: Date.now() };
        const claimed = await store.compareAndSwap(grantId, current.version, marked, controller.signal); check();
        if (claimed !== true) throw new ConfluenceOAuthError('OAUTH_GRANT_CHANGED');
        // Persist intent before the rotating token can be consumed. A lost response never reuses it.
        await permit('refresh');
        const ownership = await load();
        if (ownership.state !== 'refreshing' || ownership.version !== marked.version || ownership.attempt_id !== marked.attempt_id) throw new ConfluenceOAuthError('OAUTH_GRANT_CHANGED');
        const started = Date.now();
        const response = await fetchImpl('https://auth.atlassian.com/oauth/token', { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ grant_type: 'refresh_token', client_id: clientId, client_secret: secret, refresh_token: current.refresh_token }) });
        try { check(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new ConfluenceOAuthError('OAUTH_RECONNECT_REQUIRED'); }
        const value: any = await boundedJson(response, 32 * 1024, controller.signal); check();
        if (!token(value?.access_token) || !token(value?.refresh_token) || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86400
          || (value.token_type !== undefined && value.token_type !== 'Bearer') || typeof value.scope !== 'string') throw new ConfluenceOAuthError('OAUTH_INVALID_RESPONSE');
        const next = grant({ version: marked.version + 1, grant_id: grantId, client_id: clientId, state: 'ready',
          access_token: value.access_token, refresh_token: value.refresh_token, expires_at: started + value.expires_in * 1000, scope: value.scope }, grantId, clientId);
        check(); const saved = await store.compareAndSwap(grantId, marked.version, next, controller.signal); check();
        if (saved !== true) throw new ConfluenceOAuthError('OAUTH_GRANT_CHANGED');
        await permit('use'); const latest = await load();
        if (latest.state !== 'ready' || canonicalize(latest) !== canonicalize(next) || latest.expires_at <= Date.now()) throw new ConfluenceOAuthError('OAUTH_GRANT_CHANGED');
        return latest.access_token;
      };
      try { return await Promise.race([work(), cancelled]); }
      catch (error) { if (error instanceof ConfluenceOAuthError) throw error; throw new ConfluenceOAuthError('OAUTH_UNAVAILABLE'); }
      finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); controllers.delete(controller); controller.abort(); }
    },
    close() { closed = true; for (const controller of controllers) controller.abort(); },
  };
}
