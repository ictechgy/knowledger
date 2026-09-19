import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import type { ApplicationLedger } from '../../packages/storage/ledger-port.ts';
import type { Actor } from '../../packages/storage/local-ledger.ts';
import type { ApplicationAuthentication, AuthenticatedSession } from '../../packages/auth/types.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { ApiError, KnowledgerService, onlyFields } from './service.ts';
import type { ModelEgressPolicy } from './service.ts';
import { parseJsonStrict } from './json.ts';
import { ensureRuntimeScope } from '../../packages/storage/runtime-scope.ts';
import type { RuntimeScopeOrganization } from '../../packages/storage/runtime-scope.ts';
import { ensureConfigurationScope, readConfigurationScope } from '../../packages/storage/configuration-scope.ts';
import type { ConfiguredRuntimeBinding } from '../../packages/storage/configuration-scope.ts';
import { actorIdentity } from '../../packages/config/types.ts';
import type { ApplicationDefinition, Persona } from '../../packages/config/types.ts';
import { ReadinessMonitor } from './readiness.ts';
import { closeHttpServer } from '../../packages/http/graceful-close.ts';
import type { VectorCandidateIndex } from '../../packages/storage/vector-index.ts';

interface Session { id: string; csrf: string; actor: Actor; expires: number }
type RequestSession = Session | AuthenticatedSession;
const MAX_BODY = 768 * 1024;
const token = () => randomBytes(32).toString('hex');
const equal = (a: string, b: string) => a.length > 0 && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

function decodeResourceId(value:string):string {
  try{return decodeURIComponent(value);}catch{throw new ApiError('INVALID_INPUT','올바른 경로 식별자가 필요합니다.');}
}

function pageQuery(url: URL, allowed: string[] = ['limit', 'cursor']): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new ApiError('INVALID_QUERY', '허용되지 않은 목록 조건입니다.');
    if (key.endsWith('limit')) {
      const number = /^[1-9][0-9]*$/.test(value) ? Number(value) : NaN;
      if (!Number.isSafeInteger(number) || number > 50) throw new ApiError('INVALID_QUERY', '목록 크기는 1부터 50까지여야 합니다.');
      result[key] = number;
    } else result[key] = value;
  }
  return result;
}

export interface AppOptions {
  dataDir: string; definition: ApplicationDefinition; ledger?: ApplicationLedger; personas?: Persona[];
  authentication?: ApplicationAuthentication; organization?: RuntimeScopeOrganization;
  binding?: ConfiguredRuntimeBinding; publicOrigin?: string;
  /** 소유권은 앱으로 넘어간다 — createApp이 종료와 초기화 실패 시 색인을 닫는다. */
  vectorIndex?: VectorCandidateIndex;
  /**
   * 외부 색인과 같은 임베딩 공간의 질의 임베더 — 같은 입력에 같은 출력을
   * 돌려야 한다(커서는 순위 해시로 후보 집합을 고정). embedRevision과 반드시
   * 쌍으로 설정한다.
   */
  embedQuery?: (text: string) => readonly number[] | Promise<readonly number[]>;
  /** embedQuery와 같은 임베딩 공간의 개정본 임베더 — 색인에 기록된 행의 임베더와 차원이 같아야 한다. */
  embedRevision?: (title: string, body: string) => readonly number[] | Promise<readonly number[]>;
  /** 모델 egress 정책 — allows가 어댑터별 현재 전송 권한을 재확인하고 policy_version이 manifest에 결속된다. */
  modelEgress?: ModelEgressPolicy;
  /** 종료 시 진행 중 요청이 끝나기를 기다리는 상한(ms) — 기본 5_000, 초과 시 잔여 연결을 강제 해제한다. */
  shutdownDeadlineMs?: number;
}

export async function createApp(options: AppOptions) {
  let ledger: ApplicationLedger | undefined = options.ledger;
  let vault: PrivateStore | undefined;
  let service: KnowledgerService | undefined;
  const authentication = options.authentication;
  const definition = options.definition;
  const personas = options.personas ?? definition?.personas ?? [];
  const workspaceRoot = definition ? `/v1/workspaces/${encodeURIComponent(definition.workspace.id)}` : '';
  let publicOrigin: string | undefined;
  try {
    if (options.organization && (options.ledger?.mode !== 'fabric-test-network' || !authentication)) throw new Error('Organization scope requires an authenticated Fabric runtime');
    if (options.binding) ensureConfigurationScope(options.dataDir, options.binding);
    else {
      if (readConfigurationScope(options.dataDir)) throw new Error('Configured data requires its project configuration');
      ensureRuntimeScope(options.dataDir, options.organization);
    }
    if (!definition) throw new Error('An explicit application definition is required');
    if (options.publicOrigin) {
      const url = new URL(options.publicOrigin);
      if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid public origin');
      if (url.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Public origins require HTTPS');
      if (!authentication && !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Development sessions require loopback');
      publicOrigin = url.origin;
    }
    ledger = options.ledger ?? new LocalLedger(join(options.dataDir, 'shared-ledger.sqlite'), definition.genesis.channel_id);
    if (ledger.mode !== 'local-simulation' && !definition.demo && !authentication) throw new Error('Fabric requires configured authentication');
    if (ledger.mode !== 'local-simulation' && !options.personas) throw new Error('Fabric test network requires an explicit signer persona list');
    vault = new PrivateStore(join(options.dataDir, 'private-local.sqlite'));
    service = new KnowledgerService(ledger, vault, definition, personas, { vectorIndex: options.vectorIndex, embedQuery: options.embedQuery, embedRevision: options.embedRevision, modelEgress: options.modelEgress });
    await service.initialize();
  } catch (error) {
    // 색인 정리 실패가 원래 초기화 오류를 가리지 않게 원인에 부착한다.
    try { await options.vectorIndex?.close?.(); }
    catch (closeError) { (error as any).vectorIndexClose = closeError; }
    finally { try { await ledger?.close(); } finally { try { vault?.close(); } finally { await authentication?.close(); } } }
    throw error;
  }
  const sessions = new Map<string, Session>();
  const rateLimits = new Map<string, { minute: number; count: number; touched: number }>();
  const readiness = new ReadinessMonitor(() => service.refresh());
  const startedAt = performance.now();

  function json(res: ServerResponse, status: number, value: any) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  }
  function localCookieName(): string {
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return `knowledger_local_${createHash('sha256').update(`${publicOrigin ?? port}|${definition.workspace.id}`).digest('hex').slice(0,16)}`;
  }
  function currentSession(req: IncomingMessage): Session | undefined {
    const id = new RegExp(`(?:^|;\\s*)${localCookieName()}=([0-9a-f]{64})(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
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
    const identity = session && definition.genesis.identities.find(item => item.org_id === session.actor.org_id && item.actor_id === session.actor.actor_id);
    const metadata = { workspace:session ? definition.workspace : {id:definition.workspace.id,label:definition.workspace.label},
      organizations:session ? definition.organizations : [], demo:definition.demo,
      capabilities:identity ? {publish_contexts:identity.publish_contexts,can_propose:identity.can_propose} : {publish_contexts:[],can_propose:false} };
    if (authentication) return session
      ? { ...metadata, actor:session.actor, personas:[], csrf_token:session.csrf, logout_url:'/auth/logout', auth_mode:authentication.mode, mode:ledger!.mode }
      : { ...metadata, actor:null, personas:[], login_url:'/auth/login', auth_mode:authentication.mode, mode:ledger!.mode };
    if (!session) throw new ApiError('UNAUTHENTICATED', '개발 세션을 시작해 주세요.', 401);
    return { ...metadata, actor:session.actor, personas, csrf_token:session.csrf, mode:ledger!.mode };
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
      const allowedHosts = publicOrigin ? [new URL(publicOrigin).host] : [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes((req.headers.host ?? '').toLowerCase())) throw new ApiError('HOST_REJECTED', '이 서버는 로컬 접근만 허용합니다.', 403);
      const origin = publicOrigin ?? `http://${req.headers.host}`;
      const url = new URL(req.url ?? '/', origin);
      const path = url.pathname;
      const resourcePath = path.startsWith(`${workspaceRoot}/`) ? path.slice(workspaceRoot.length) : '';
      const staticPage = req.method === 'GET' && ['/', '/app.js', '/style.css', '/revision-diff.js'].includes(path);
      const authPath = Boolean(authentication && ['/auth/login', '/auth/callback', '/auth/logout'].includes(path));
      const callbackException = Boolean(authentication && req.method === 'GET' && path === '/auth/callback' && url.origin === authentication.origin);
      if (url.origin !== origin || (authentication && authPath && url.origin !== authentication.origin)) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      if (!callbackException && !staticPage && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && req.headers.origin !== origin))) throw new ApiError('ORIGIN_REJECTED', '요청 출처를 확인할 수 없습니다.', 403);
      if (authentication && authPath && await authentication.handle(req, res, url)) return;
      if (req.method === 'GET' && ['/', '/app.js', '/style.css', '/revision-diff.js'].includes(path)) {
        const file = path === '/' ? 'index.html' : path.slice(1);
        const contents = await readFile(new URL(`../web/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(contents); return;
      }
      if (req.method === 'GET' && path === '/healthz') {
        json(res, 200, { status: 'ok', healthy: true, state: 'live' }); return;
      }
      if (req.method === 'GET' && path === '/readyz') {
        const sample = readiness.read();
        json(res, sample.healthy ? 200 : 503, sample); return;
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
          const defaultPersona = personas.find(item => definition.default_actor && item.org_id === definition.default_actor.org_id && item.actor_id === definition.default_actor.actor_id) ?? personas.find(item => item.kind === 'human') ?? personas[0];
          if (!defaultPersona) throw new ApiError('LEDGER_NOT_READY', '사용 가능한 서명자 구성이 없습니다.', 503, true);
          session = { id: token(), csrf: token(), actor: actorIdentity(defaultPersona), expires: Date.now() + 30 * 60_000 };
          sessions.set(session.id, session);
          res.setHeader('Set-Cookie', `${localCookieName()}=${session.id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
        }
        json(res, 200, sessionResponse(session)); return;
      }
      const session = await authorize(req);
      const actor = session.actor;
      const run = <T>(operation: () => Promise<T>) => runAuthorized(session, operation, requestStarted);
      if (req.method === 'POST') {
        if (authentication && path === '/api/session') throw new ApiError('ROLE_SWITCH_FORBIDDEN', '로그인 계정의 역할은 브라우저에서 바꿀 수 없습니다.', 403);
        const csrf = req.headers['x-knowledger-csrf'];
        if (typeof csrf !== 'string' || !equal(csrf, session.csrf)) throw new ApiError('CSRF_REJECTED', '세션을 새로고침한 뒤 다시 시도해 주세요.', 403);
        const input = await body(req);
        if (path === '/api/session') {
          onlyFields(input, ['org_id', 'actor_id']);
          const matches = personas.filter(item => item.actor_id === input.actor_id && (input.org_id === undefined || item.org_id === input.org_id));
          if (matches.length > 1) throw new ApiError('ORGANIZATION_REQUIRED', '계정과 조직을 함께 선택해 주세요.', 400);
          const persona = matches[0];
          if (!persona) throw new ApiError('NOT_FOUND', '계정을 찾을 수 없습니다.', 404);
          const selectedActor = actorIdentity(persona);
          await service.refresh();
          service.actor(selectedActor);
          session.actor = selectedActor; session.csrf = token();
          json(res, 200, sessionResponse(session)); return;
        }
        const root = workspaceRoot;
        const routes: Record<string, () => Promise<any>> = {
          [`${root}/source-manifests/validate`]: () => service.validateSourceManifest(actor,input),
          [`${root}/drafts`]: () => service.draft(actor, input),
          [`${root}/draft-imports/markdown`]: () => service.importMarkdown(actor, input),
          [`${root}/publication-previews`]: () => service.preview(actor, input),
          [`${root}/revisions`]: () => service.publish(actor, input),
          [`${root}/agreement-proposals`]: () => service.propose(actor, input),
          [`${root}/search`]: () => service.search(actor, input),
          [`${root}/vector-search`]: () => service.vectorSearch(actor, input),
          [`${root}/vector-index/rebuild`]: () => service.rebuildVectorIndex(actor, input),
          [`${root}/resolve`]: () => service.resolve(actor, input),
        };
        const respond = (value: any) => json(res, value?.status === 'pending' ? 202 : 200, value);
        if (Object.hasOwn(routes, path)) { respond(await run(routes[path])); return; }
        const sourceMatch=/^\/sources\/([^/]+)\/(markdown|reconcile)$/.exec(resourcePath);
        if(sourceMatch){respond(await run(()=>sourceMatch[2]==='markdown'?service.importSourceMarkdown(actor,decodeResourceId(sourceMatch[1]),input):service.reconcileSource(actor,decodeResourceId(sourceMatch[1]),input)));return;}
        const retryMatch = /^\/commands\/([A-Za-z][A-Za-z0-9._:-]{2,63})\/retry$/.exec(resourcePath);
        if (retryMatch) { respond(await run(()=>service.retryCommand(actor,retryMatch[1],input))); return; }
        let draftMatch = /^\/drafts\/([A-Za-z][A-Za-z0-9._:-]{2,63})\/edits$/.exec(resourcePath);
        if (draftMatch) { respond(await run(() => service.resumeDraft(actor, draftMatch![1], input))); return; }
        let match = /^\/agreement-proposals\/([A-Za-z0-9._:-]+)\/(decisions|activate)$/.exec(resourcePath);
        if (match) { respond(await run(() => match![2] === 'decisions' ? service.decide(actor, match![1], input) : service.activate(actor, match![1], input))); return; }
        match = /^\/agreements\/([A-Za-z0-9._:-]+)\/(withdraw|suspend)$/.exec(resourcePath);
        if (match) { respond(await run(() => service.changeAgreement(actor, match![1], match![2] as 'withdraw' | 'suspend', input))); return; }
        match = /^\/runs\/([A-Za-z0-9._:-]+)\/revalidate$/.exec(resourcePath);
        if (match) { respond(await run(() => service.revalidate(actor, match![1], input))); return; }
      }
      if (req.method === 'GET') {
        if(path===`${workspaceRoot}/sources`){
          const keys=[...url.searchParams.keys()];const raw=url.searchParams.get('limit');const limit=raw===null?20:/^\d+$/.test(raw)?Number(raw):NaN;const cursor=url.searchParams.get('cursor')??undefined;
          if(keys.some(key=>!['limit','cursor'].includes(key))||new Set(keys).size!==keys.length||!Number.isSafeInteger(limit)||limit<1||limit>50||(cursor!==undefined&&!/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(cursor)))throw new ApiError('INVALID_QUERY','올바른 원본 목록 조건이 필요합니다.');
          json(res,200,await run(()=>service.listSources(actor,limit,cursor)));return;
        }
        const sourceMatch=/^\/sources\/([^/]+)$/.exec(resourcePath);
        if(sourceMatch){json(res,200,await run(()=>service.getSource(actor,decodeResourceId(sourceMatch[1]))));return;}
        const proposalMatch = /^\/agreement-proposals\/([^/]+)$/.exec(resourcePath);
        if (proposalMatch) { json(res, 200, await run(() => service.getProposal(actor, decodeResourceId(proposalMatch[1])))); return; }
        const revisionBrowse = /^\/revisions\/([^/]+)\/(view|history)$/.exec(resourcePath);
        if (revisionBrowse) {
          const digest = decodeResourceId(revisionBrowse[1]);
          const view = revisionBrowse[2] === 'view';
          const input = pageQuery(url, view ? ['proposal_limit', 'proposal_cursor'] : ['limit', 'cursor']);
          const result = view ? await run(() => service.revisionView(actor, digest, input)) : await run(() => service.revisionHistory(actor, digest, input));
          json(res, 200, result); return;
        }
        const revisionMatch=/^\/revisions\/([^/]+)$/.exec(resourcePath);
        if(revisionMatch){let digest;try{digest=decodeURIComponent(revisionMatch[1]);}catch{throw new ApiError('INVALID_INPUT','올바른 개정 digest가 필요합니다.');}json(res,200,await run(()=>service.getRevision(actor,digest)));return;}
        if (path === `${workspaceRoot}/commands`) {
          const keys=[...url.searchParams.keys()];
          if(keys.some(key=>!['limit','cursor'].includes(key))||new Set(keys).size!==keys.length) throw new ApiError('INVALID_QUERY','올바른 요청 목록 조건이 필요합니다.');
          const raw=url.searchParams.get('limit');const limit=raw===null?20:/^\d+$/.test(raw)?Number(raw):NaN;
          const cursor=url.searchParams.get('cursor')??undefined;
          if(!Number.isSafeInteger(limit)||limit<1||limit>50||(cursor!==undefined&&!/^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(cursor))) throw new ApiError('INVALID_QUERY','올바른 요청 목록 조건이 필요합니다.');
          json(res,200,await run(()=>service.listCommands(actor,limit,cursor)));return;
        }
        const commandMatch=/^\/commands\/([A-Za-z][A-Za-z0-9._:-]{2,63})$/.exec(resourcePath);
        if(commandMatch){json(res,200,await run(()=>service.getCommand(actor,commandMatch[1])));return;}
        if (path === `${workspaceRoot}/drafts`) {
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
        const draftDetail = /^\/drafts\/([A-Za-z][A-Za-z0-9._:-]{2,63})$/.exec(resourcePath);
        if (draftDetail) { json(res, 200, await run(() => service.getDraft(actor, draftDetail[1]))); return; }
        if (path === `${workspaceRoot}/overview`) { const input = pageQuery(url, ['limit', 'cursor', 'proposal_limit', 'proposal_cursor']); json(res, 200, await run(() => service.overview(actor, input))); return; }
        if (path === `${workspaceRoot}/operations`) { json(res, 200, { ...await run(() => service.operations(actor)), readiness: readiness.read(), process_uptime_ms: Math.round(performance.now() - startedAt) }); return; }
        if (path === `${workspaceRoot}/events`) {
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0) throw new ApiError('INVALID_CURSOR', '올바른 커서가 필요합니다.');
          json(res, 200, await run(async () => { await service.refresh(); service.actor(actor); return { events: ledger.events(cursor), checkpoint: ledger.checkpoint() }; })); return;
        }
        const match = /^\/(documents|agreements)\/([^/]+)$/.exec(resourcePath);
        if (match) {
          const id = decodeResourceId(match[2]);
          if (match[1] === 'documents') { const input = pageQuery(url); json(res, 200, await run(() => service.documentRevisions(actor, id, input))); return; }
          const found = await run(() => service.getAgreement(actor, id));
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
          resolve(publicOrigin ?? `http://127.0.0.1:${address.port}`);
        });
      });
    },
    async close() {
      readiness.close();
      // keep-alive 재사용이나 끝나지 않는 요청이 close()를 멈추지 못하게 유휴 스윕·강제 해제 마감을 두고, 종료 실패 시에도 자원 해제는 진행한다.
      try { await closeHttpServer(server, { deadlineMs: options.shutdownDeadlineMs, label: 'api' }); }
      finally { try { await options.vectorIndex?.close?.(); } finally { try { await ledger.close(); } finally { try { vault.close(); } finally { await authentication?.close(); } } } }
    },
  };
}
