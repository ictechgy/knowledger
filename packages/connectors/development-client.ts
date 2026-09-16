import { KnowledgerClient, KnowledgerClientError } from '../client/knowledge-client.ts';
import { parseStrictJson } from '../fabric/canonical.ts';

const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/u;
const MAX_HANDSHAKE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export interface DevelopmentClientOptions {
  baseUrl: string;
  workspaceId: string;
  orgId: string;
  actorId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function fail(code: string, status?: number): never {
  throw new KnowledgerClientError(code, '개발 클라이언트 handshake를 확인할 수 없습니다.', status, Boolean(status && status >= 500));
}

function id(value: unknown): string { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_CLIENT_OPTIONS'); return value; }

function loopback(hostname: string): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(hostname); }

async function boundedJson(response: Response): Promise<any> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_HANDSHAKE_BYTES)) fail('HANDSHAKE_RESPONSE_TOO_LARGE', response.status);
  try {
    let bytes: Uint8Array;
    if (!response.body) {
      const value = await response.arrayBuffer();
      bytes = new Uint8Array(value);
    } else {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > MAX_HANDSHAKE_BYTES) { await reader.cancel(); fail('HANDSHAKE_RESPONSE_TOO_LARGE', response.status); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    }
    if (bytes.byteLength > MAX_HANDSHAKE_BYTES) fail('HANDSHAKE_RESPONSE_TOO_LARGE', response.status);
    try { return parseStrictJson(bytes); } catch { fail('INVALID_HANDSHAKE_RESPONSE', response.status); }
  } catch (error) {
    if (error instanceof KnowledgerClientError) throw error;
    fail('HANDSHAKE_NETWORK_ERROR');
  }
}

async function handshakeRequest(fetchImpl: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; value: any }> {
  const controller = new AbortController();
  let rejectTimeout!: (error: KnowledgerClientError) => void;
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new KnowledgerClientError('HANDSHAKE_TIMEOUT', '개발 클라이언트 handshake 시간이 초과되었습니다.', undefined, true)); }, timeoutMs);
  try {
    const result = await Promise.race([
      (async () => {
        let response: Response;
        try { response = await fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal }); }
        catch { fail('HANDSHAKE_NETWORK_ERROR'); }
        if (!response.ok) { try { await response.body?.cancel(); } catch { /* discard safely */ } fail('HANDSHAKE_FAILED', response.status); }
        return { response, value: await boundedJson(response) };
      })(),
      new Promise<never>((_, reject) => { rejectTimeout = reject; }),
    ]);
    return result;
  } finally { clearTimeout(timer); }
}

function verifySession(value: unknown, workspaceId: string, expectedOrg?: string, expectedActor?: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_HANDSHAKE_RESPONSE');
  const response = value as Record<string, any>;
  if (response.mode !== 'local-simulation' || Object.hasOwn(response, 'auth_mode') || !response.workspace || response.workspace.id !== workspaceId) fail('DEVELOPMENT_MODE_REQUIRED');
  const actor = response.actor;
  if (!actor || (expectedOrg !== undefined && actor.org_id !== expectedOrg) || (expectedActor !== undefined && actor.actor_id !== expectedActor) || (actor.kind !== 'human' && actor.kind !== 'agent')) fail('ACTOR_BINDING_FAILED');
  if (typeof response.csrf_token !== 'string' || response.csrf_token.length < 1) fail('INVALID_HANDSHAKE_RESPONSE');
  return response.csrf_token;
}

export async function createDevelopmentClient(options: DevelopmentClientOptions): Promise<KnowledgerClient> {
  let base: URL;
  try { base = new URL(options.baseUrl); } catch { fail('INVALID_ORIGIN'); }
  if (!['http:', 'https:'].includes(base.protocol) || !loopback(base.hostname) || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) fail('INVALID_ORIGIN');
  const workspaceId = id(options.workspaceId);
  const orgId = id(options.orgId);
  const actorId = id(options.actorId);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) fail('INVALID_TIMEOUT');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') fail('FETCH_UNAVAILABLE');
  const initial = await handshakeRequest(fetchImpl.bind(globalThis), `${base.origin}/api/session`, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
  const setCookies = typeof (initial.response.headers as any).getSetCookie === 'function'
    ? (initial.response.headers as any).getSetCookie() as string[]
    : (initial.response.headers.get('set-cookie') ? [initial.response.headers.get('set-cookie')!] : []);
  if (setCookies.length !== 1 || !/^[^=;,]+=[^;,]+$/u.test(setCookies[0].split(';', 1)[0])) fail('COOKIE_CAPTURE_FAILED');
  const cookie = setCookies[0].split(';', 1)[0];
  const firstCsrf = verifySession(initial.value, workspaceId);
  const selected = await handshakeRequest(fetchImpl.bind(globalThis), `${base.origin}/api/session`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Origin: base.origin, Cookie: cookie, 'X-KNOWLEDGER-CSRF': firstCsrf },
    body: JSON.stringify({ org_id: orgId, actor_id: actorId }),
  }, timeoutMs);
  const csrf = verifySession(selected.value, workspaceId, orgId, actorId);
  const client = new KnowledgerClient({ baseUrl: base.origin, workspaceId, fetch: fetchImpl, timeoutMs, headers: () => ({ Accept: 'application/json', Origin: base.origin, Cookie: cookie, 'X-KNOWLEDGER-CSRF': csrf }) });
  return client;
}
