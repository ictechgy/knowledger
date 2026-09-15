import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import type { ApplicationLedger } from '../../packages/storage/ledger-port.ts';
import type { Actor } from '../../packages/storage/local-ledger.ts';
import type { ApplicationAuthentication, AuthenticatedSession } from '../../packages/auth/types.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { ApiError, KclService, onlyFields } from './service.ts';
import { parseJsonStrict } from './json.ts';
import { CHANNEL_ID, PERSONAS, actorIdentity } from './demo-config.ts';

interface Session { id: string; csrf: string; actor: Actor; expires: number }
type RequestSession = Session | AuthenticatedSession;
const MAX_BODY = 768 * 1024;
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createApp(options: { dataDir: string; seed?: boolean; ledger?: ApplicationLedger; personas?: typeof PERSONAS; authentication?: ApplicationAuthentication }) {
  let ledger: ApplicationLedger | undefined;
  let vault: PrivateStore | undefined;
  let service: KclService | undefined;
  const authentication = options.authentication;
  const personas = options.personas ?? PERSONAS;
  try {
    ledger = options.ledger ?? new LocalLedger(join(options.dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
    if (ledger.mode === 'fabric-test-network' && !options.personas) throw new Error('Fabric test network requires an explicit signer persona list');
    vault = new PrivateStore(join(options.dataDir, 'private-local.sqlite'));
    service = new KclService(ledger, vault, personas);
    await service.initialize(options.seed ?? true);
  } catch (error) {
    try { await ledger?.close(); } finally { try { vault?.close(); } finally { await authentication?.close(); } }
    throw error;
  }
  const sessions = new Map<string, Session>();
  const rateLimits = new Map<string, { minute: number; count: number; touched: number }>();

  function json(res: ServerResponse, status: number, value: any) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function currentSession(req: IncomingMessage): Session | undefined {
    const id = /(?:^|;\s*)kcl_session=([0-9a-f]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const session = id ? sessions.get(id) : undefined;
    if (session && session.expires > Date.now()) return session;
    if (id) sessions.delete(id);
    return undefined;
  }
  function cleanupRateLimits(now: number): void {
    if (rateLimits.size <= 256) return;
    for (const [id, value] of rateLimits) if (now - value.touched > 120_000) rateLimits.delete(id);
    if (rateLimits.size <= 256) return;
    let removed = 0;
    for (const id of rateLimits.keys()) { rateLimits.delete(id); if (++removed >= 32) break; }
  }
  async function authorize(req: IncomingMessage): Promise<RequestSession> {
    const session = authentication ? await authentication.session(req) : currentSession(req);
    if (!session) throw new ApiError('UNAUTHENTICATED', authentication ? '로그인 후 다시 시도해 주세요.' : '로컬 데모 세션을 시작해 주세요.', 401);
    const now = Date.now();
    cleanupRateLimits(now);
    const minute = Math.floor(Date.now() / 60_000);
    const limit = rateLimits.get(session.id);
    if (!limit || limit.minute !== minute) rateLimits.set(session.id, { minute, count: 1, touched: now });
    else { limit.count++; limit.touched = now; if (limit.count > 180) throw new ApiError('RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429, true); }
    return session;
  }
  async function body(req: IncomingMessage): Promise<any> {
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new ApiError('CONTENT_TYPE_REQUIRED', 'application/json 요청이 필요합니다.', 415);
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new ApiError('PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.', 413);
    const parts: Buffer[] = []; let bytes = 0;
    for await (const part of req) {
      bytes += part.length;
      if (bytes > MAX_BODY) throw new ApiError('PAYLOAD_TOO_LARGE', '요청 본문이 너무 큽니다.', 413);
      parts.push(part);
    }
    try {
      const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
      const parsed = parseJsonStrict(source);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
      return parsed;
    } catch { throw new ApiError('INVALID_JSON', '중복 필드가 없는 올바른 UTF-8 JSON 객체가 필요합니다.'); }
  }
  function sessionResponse(session: RequestSession | undefined): Record<string, unknown> {
    if (authentication) return session
      ? { actor: session.actor, personas: [], csrf_token: session.csrf, logout_url: '/auth/logout', auth_mode: authentication.mode, mode: ledger!.mode }
      : { actor: null, personas: [], login_url: '/auth/login', auth_mode: authentication.mode, mode: ledger!.mode };
    if (!session) throw new ApiError('UNAUTHENTICATED', '로컬 데모 세션을 시작해 주세요.', 401);
    return { actor: session.actor, personas, csrf_token: session.csrf, mode: ledger!.mode };
  }
  async function runAuthorized<T>(session: RequestSession, operation: () => Promise<T>, started: number): Promise<T> {
    const result = authentication ? await authentication.run(session, operation) : await operation();
    if (result && typeof result === 'object' && 'status' in result && (result.status === 'provided' || result.status === 'valid') && performance.now() - started > 30_000) {
      throw new ApiError('FRESHNESS_UNAVAILABLE', '권한과 원장 상태를 확인하는 동안 제공 유효 시간이 지났습니다.', 503, true);
    }
    return result;
  }

  const server = createServer(async (req, res) => {
    const requestStarted = performance.now();
    const requestId = `request-${randomUUID()}`;
    res.setHeader('X-Request-ID', requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host ?? '')) throw new ApiError('HOST_REJECTED', '이 서버는 로컬 접근만 허용합니다.', 403);
      const origin = `http://${req.headers.host}`;
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      const authPath = Boolean(authentication && ['/auth/login', '/auth/callback', '/auth/logout'].includes(path));
      const callbackException = Boolean(authentication && req.method === 'GET' && path === '/auth/callback' && url.origin === authentication.origin);
      if (url.origin !== origin || (authentication && authPath && url.origin !== authentication.origin)) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      if (!callbackException && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin))) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      if (authentication && authPath && await authentication.handle(req, res, url)) return;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const contents = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(contents); return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        let healthy = true;
        let checkpoint: ReturnType<ApplicationLedger['checkpoint']> = null;
        try { await service.refresh(); checkpoint = ledger.checkpoint(); } catch { healthy = false; }
        json(res, healthy ? 200 : 503, { status: healthy ? 'ok' : 'unavailable', healthy, mode: ledger.mode, channel_id: ledger.channelId, checkpoint, state: healthy ? 'ready' : 'peer-unavailable' }); return;
      }
      if (req.method === 'GET' && path === '/api/session') {
        if (authentication) {
          let authenticated: AuthenticatedSession | undefined;
          try { authenticated = await authentication.session(req); }
          catch (error) {
            if (!error || typeof error !== 'object' || !('status' in error) || ![401, 403].includes(Number(error.status))) throw error;
          }
          json(res, 200, sessionResponse(authenticated)); return;
        }
        let session = currentSession(req);
        if (!session) {
          for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
          if (sessions.size >= 256) throw new ApiError('SESSION_LIMIT', '로컬 세션 수가 너무 많습니다.', 429, true);
          const defaultPersona = personas.find(item => item.actor_id === PERSONAS[1].actor_id) ?? personas[0];
          if (!defaultPersona) throw new ApiError('LEDGER_NOT_READY', '사용 가능한 서명자 구성이 없습니다.', 503, true);
          session = { id: token(), csrf: token(), actor: actorIdentity(defaultPersona), expires: Date.now() + 30 * 60_000 };
          sessions.set(session.id, session);
          res.setHeader('Set-Cookie', `kcl_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
        }
        json(res, 200, sessionResponse(session)); return;
      }
      const session = await authorize(req);
      const actor = session.actor;
      const run = <T>(operation: () => Promise<T>) => runAuthorized(session, operation, requestStarted);
      if (req.method === 'POST') {
        if (authentication && path === '/api/session') throw new ApiError('ROLE_SWITCH_FORBIDDEN', '로그인 계정의 역할은 브라우저에서 바꿀 수 없습니다.', 403);
        const csrf = req.headers['x-kcl-csrf'];
        if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError('CSRF_REJECTED', '세션을 새로고침한 뒤 다시 시도해 주세요.', 403);
        const input = await body(req);
        if (path === '/api/session') {
          onlyFields(input, ['actor_id']);
          const persona = personas.find(item => item.actor_id === input.actor_id);
          if (!persona) throw new ApiError('NOT_FOUND', '데모 역할을 찾을 수 없습니다.', 404);
          const selectedActor = actorIdentity(persona);
          await service.refresh();
          service.actor(selectedActor);
          session.actor = selectedActor; session.csrf = token();
          json(res, 200, sessionResponse(session)); return;
        }
        const root = '/v1/workspaces/demo';
        const routes: Record<string, () => Promise<any>> = {
          [`${root}/drafts`]: () => service.draft(actor, input),
          [`${root}/draft-imports/markdown`]: () => service.importMarkdown(actor, input),
          [`${root}/publication-previews`]: () => service.preview(actor, input),
          [`${root}/revisions`]: () => service.publish(actor, input),
          [`${root}/agreement-proposals`]: () => service.propose(actor, input),
          [`${root}/search`]: () => service.search(actor, input),
          [`${root}/resolve`]: () => service.resolve(actor, input),
        };
        const respond = (value: any) => json(res, value?.status === 'pending' ? 202 : 200, value);
        if (Object.hasOwn(routes, path)) { respond(await run(routes[path])); return; }
        let draftMatch = /^\/v1\/workspaces\/demo\/drafts\/([A-Za-z][A-Za-z0-9._:-]{2,63})\/edits$/.exec(path);
        if (draftMatch) { respond(await run(() => service.resumeDraft(actor, draftMatch![1], input))); return; }
        let match = /^\/v1\/workspaces\/demo\/agreement-proposals\/([A-Za-z0-9._:-]+)\/(decisions|activate)$/.exec(path);
        if (match) { respond(await run(() => match![2] === 'decisions' ? service.decide(actor, match![1], input) : service.activate(actor, match![1], input))); return; }
        match = /^\/v1\/workspaces\/demo\/agreements\/([A-Za-z0-9._:-]+)\/(withdraw|suspend)$/.exec(path);
        if (match) { respond(await run(() => service.changeAgreement(actor, match![1], match![2] as 'withdraw' | 'suspend', input))); return; }
        match = /^\/v1\/workspaces\/demo\/runs\/([A-Za-z0-9._:-]+)\/revalidate$/.exec(path);
        if (match) { respond(await run(() => service.revalidate(actor, match![1], input))); return; }
      }
      if (req.method === 'GET') {
        if (path === '/v1/workspaces/demo/drafts') {
          const allowed = new Set(['limit', 'cursor']);
          const seen = new Set<string>();
          for (const [key] of url.searchParams) {
            if (!allowed.has(key) || seen.has(key)) throw new ApiError('INVALID_QUERY', '올바른 초안 목록 조회 조건이 필요합니다.');
            seen.add(key);
          }
          const rawLimit = url.searchParams.get('limit');
          const limit = rawLimit === null ? 20 : /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN;
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError('INVALID_QUERY', '초안 목록 limit은 1에서 50 사이여야 합니다.');
          const cursor = url.searchParams.get('cursor') ?? undefined;
          if (cursor !== undefined && !/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(cursor)) throw new ApiError('INVALID_QUERY', '올바른 초안 cursor가 필요합니다.');
          json(res, 200, await run(() => service.listDrafts(actor, limit, cursor))); return;
        }
        const draftDetail = /^\/v1\/workspaces\/demo\/drafts\/([A-Za-z][A-Za-z0-9._:-]{2,63})$/.exec(path);
        if (draftDetail) { json(res, 200, await run(() => service.getDraft(actor, draftDetail[1]))); return; }
        if (path === '/v1/workspaces/demo/overview') { json(res, 200, await run(() => service.overview(actor))); return; }
        if (path === '/v1/workspaces/demo/events') {
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError('INVALID_CURSOR', '올바른 커서가 필요합니다.');
          json(res, 200, await run(async () => { await service.refresh(); service.actor(actor); return { events: ledger.events(cursor), checkpoint: ledger.checkpoint() }; })); return;
        }
        const match = /^\/v1\/workspaces\/demo\/(documents|agreements)\/([A-Za-z0-9._:-]+)$/.exec(path);
        if (match) {
          const found = await run(async () => {
            const overview = await service.overview(actor);
            return match![1] === 'documents' ? overview.documents.filter(item => item.payload.document_id === match![2]) : service.values('agreement').find(item => item.agreement_id === match![2]);
          });
          if (!found || (Array.isArray(found) && !found.length)) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없거나 접근할 수 없습니다.', 404);
          json(res, 200, found); return;
        }
      }
      throw new ApiError('NOT_FOUND', '대상을 찾을 수 없거나 접근할 수 없습니다.', 404);
    } catch (error: any) {
      const known = typeof error?.code === 'string' && Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599;
      json(res, known ? error.status : 500, { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '요청을 처리하지 못했습니다.', retryable: known ? Boolean(error.retryable) : false, request_id: requestId });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return {
    server, service,
    listen(port = 4317): Promise<string> {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', onError);
          const address = server.address() as { port: number };
          resolve(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    async close() {
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      try { await ledger.close(); } finally { try { vault.close(); } finally { await authentication?.close(); } }
    },
  };
}
