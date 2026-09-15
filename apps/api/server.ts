import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import type { Actor } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { ApiError, KclService, onlyFields } from './service.ts';
import { parseJsonStrict } from './json.ts';
import { CHANNEL_ID, PERSONAS, actorIdentity } from './demo-config.ts';

interface Session { id: string; csrf: string; actor: Actor; expires: number; minute: number; count: number }
const MAX_BODY = 768 * 1024;
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => /^[0-9a-f]{64}$/.test(a) && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createApp(options: { dataDir: string; seed?: boolean }) {
  const ledger = new LocalLedger(join(options.dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const vault = new PrivateStore(join(options.dataDir, 'private-local.sqlite'));
  const service = new KclService(ledger, vault);
  try { await service.initialize(options.seed ?? true); }
  catch (error) { ledger.close(); vault.close(); throw error; }
  const sessions = new Map<string, Session>();

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
  function authorize(req: IncomingMessage): Session {
    const session = currentSession(req);
    if (!session) throw new ApiError('UNAUTHENTICATED', '로컬 데모 세션을 시작해 주세요.', 401);
    const minute = Math.floor(Date.now() / 60_000);
    if (session.minute !== minute) { session.minute = minute; session.count = 0; }
    if (++session.count > 180) throw new ApiError('RATE_LIMITED', '요청이 많습니다. 잠시 후 다시 시도해 주세요.', 429, true);
    service.actor(session.actor);
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

  const server = createServer(async (req, res) => {
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
      if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin)) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      const url = new URL(req.url ?? '/', origin);
      if (url.origin !== origin) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      const path = url.pathname;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const contents = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(contents); return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { status: 'ok', mode: 'local-simulation', channel_id: CHANNEL_ID }); return;
      }
      if (req.method === 'GET' && path === '/api/session') {
        let session = currentSession(req);
        if (!session) {
          for (const [id, value] of sessions) if (value.expires <= Date.now()) sessions.delete(id);
          if (sessions.size >= 256) throw new ApiError('SESSION_LIMIT', '로컬 세션 수가 너무 많습니다.', 429, true);
          session = { id: token(), csrf: token(), actor: actorIdentity(PERSONAS[1]), expires: Date.now() + 30 * 60_000, minute: 0, count: 0 };
          sessions.set(session.id, session);
          res.setHeader('Set-Cookie', `kcl_session=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
        }
        json(res, 200, { actor: session.actor, personas: PERSONAS, csrf_token: session.csrf, mode: 'local-simulation' }); return;
      }
      const session = authorize(req);
      const actor = session.actor;
      if (req.method === 'POST') {
        const csrf = req.headers['x-kcl-csrf'];
        if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError('CSRF_REJECTED', '세션을 새로고침한 뒤 다시 시도해 주세요.', 403);
        const input = await body(req);
        if (path === '/api/session') {
          onlyFields(input, ['actor_id']);
          const persona = PERSONAS.find(item => item.actor_id === input.actor_id);
          if (!persona) throw new ApiError('NOT_FOUND', '데모 역할을 찾을 수 없습니다.', 404);
          session.actor = actorIdentity(persona); session.csrf = token();
          json(res, 200, { actor: session.actor, personas: PERSONAS, csrf_token: session.csrf, mode: 'local-simulation' }); return;
        }
        const root = '/v1/workspaces/demo';
        const routes: Record<string, () => Promise<any>> = {
          [`${root}/drafts`]: () => service.draft(actor, input),
          [`${root}/publication-previews`]: () => service.preview(actor, input),
          [`${root}/revisions`]: () => service.publish(actor, input),
          [`${root}/agreement-proposals`]: () => service.propose(actor, input),
          [`${root}/search`]: () => service.search(actor, input),
          [`${root}/resolve`]: () => service.resolve(actor, input),
        };
        if (Object.hasOwn(routes, path)) { json(res, 200, await routes[path]()); return; }
        let match = /^\/v1\/workspaces\/demo\/agreement-proposals\/([A-Za-z0-9._:-]+)\/(decisions|activate)$/.exec(path);
        if (match) { json(res, 200, match[2] === 'decisions' ? await service.decide(actor, match[1], input) : await service.activate(actor, match[1], input)); return; }
        match = /^\/v1\/workspaces\/demo\/agreements\/([A-Za-z0-9._:-]+)\/(withdraw|suspend)$/.exec(path);
        if (match) { json(res, 200, await service.changeAgreement(actor, match[1], match[2] as 'withdraw' | 'suspend', input)); return; }
        match = /^\/v1\/workspaces\/demo\/runs\/([A-Za-z0-9._:-]+)\/revalidate$/.exec(path);
        if (match) { json(res, 200, await service.revalidate(actor, match[1], input)); return; }
      }
      if (req.method === 'GET') {
        if (path === '/v1/workspaces/demo/overview') { json(res, 200, await service.overview(actor)); return; }
        if (path === '/v1/workspaces/demo/events') {
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError('INVALID_CURSOR', '올바른 커서가 필요합니다.');
          json(res, 200, { events: ledger.events(cursor), checkpoint: ledger.checkpoint() }); return;
        }
        const match = /^\/v1\/workspaces\/demo\/(documents|agreements)\/([A-Za-z0-9._:-]+)$/.exec(path);
        if (match) {
          const overview = await service.overview(actor);
          const found = match[1] === 'documents' ? overview.documents.filter(item => item.payload.document_id === match[2]) : service.values('agreement').find(item => item.agreement_id === match[2]);
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
      ledger.close(); vault.close();
    },
  };
}
