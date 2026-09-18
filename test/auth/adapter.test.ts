import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { Actor } from '../../packages/storage/local-ledger.ts';

const requireAuth = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
let available = true;
for (const dependency of ['openid-client', 'oidc-provider', 'jose']) {
  try { requireAuth.resolve(dependency); }
  catch (error) { const e = error as NodeJS.ErrnoException; if (e.code !== 'MODULE_NOT_FOUND' || !e.message.startsWith(`Cannot find module '${dependency}'`)) throw error; available = false; }
}
const adapter = available ? await import('../../packages/auth/adapter.ts') : undefined;

const sales: Actor = { org_id: 'SalesMSP', actor_id: 'person-sales-owner', kind: 'human' };
const fulfillment: Actor = { org_id: 'FulfillmentMSP', actor_id: 'person-fulfillment-owner', kind: 'human' };

test('subjectActorResolver binds only the configured issuer and subject', { skip: !available }, () => {
  assert.ok(adapter);
  const subjects = new Map([['dev-sales-owner', sales], ['dev-fulfillment-owner', fulfillment]] as const);
  const resolve = adapter.subjectActorResolver('http://127.0.0.1:4320/', subjects);
  // Browser or JWT claims never select the actor: only the operator's
  // (issuer, subject) binding resolves.
  assert.deepEqual(resolve('http://127.0.0.1:4320/', 'dev-sales-owner'), sales);
  assert.deepEqual(resolve('http://127.0.0.1:4320/', 'dev-fulfillment-owner'), fulfillment);
  assert.equal(resolve('http://127.0.0.1:4320/', 'unknown-subject'), undefined);
  assert.equal(resolve('http://127.0.0.1:9999/', 'dev-sales-owner'), undefined);
  assert.equal(resolve('https://evil.example/', 'dev-sales-owner'), undefined);
  // OIDC `iss`는 정확 문자열 일치다 — URL 정규화가 같아지는 별칭은 모두 거부다.
  assert.equal(resolve('http://127.0.0.1:4320', 'dev-sales-owner'), undefined); // 후행 슬래시 차이
  assert.equal(resolve('http://127.0.0.1:4320/./', 'dev-sales-owner'), undefined); // 닷 세그먼트
  assert.equal(resolve('HTTP://127.0.0.1:4320/', 'dev-sales-owner'), undefined); // 스킴 대소문자
  // 생략된 기본 포트와 명시된 기본 포트는 정규화상 같은 origin이지만 거부다.
  const defaultPort = adapter.subjectActorResolver('http://127.0.0.1/', subjects);
  assert.equal(defaultPort('http://127.0.0.1:80/', 'dev-sales-owner'), undefined);
  // malformed 후보 issuer는 예외가 아니라 거부다 — 리졸버는 항상 total 이어야 한다.
  assert.equal(resolve('not-a-url', 'dev-sales-owner'), undefined);
  assert.equal(resolve('', 'dev-sales-owner'), undefined);
  assert.equal(resolve('http://[::1', 'dev-sales-owner'), undefined);
});

test('subjectActorResolver snapshots the subject map and refuses an empty one', { skip: !available }, () => {
  assert.ok(adapter);
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  const resolve = adapter.subjectActorResolver('http://127.0.0.1:4320/', subjects);
  // 팩토리 이후 원본 맵 변이는 해석에 영향을 주지 못한다.
  subjects.delete('dev-sales-owner');
  subjects.set('injected', fulfillment);
  assert.deepEqual(resolve('http://127.0.0.1:4320/', 'dev-sales-owner'), sales);
  assert.equal(resolve('http://127.0.0.1:4320/', 'injected'), undefined);
  assert.throws(() => adapter.subjectActorResolver('http://127.0.0.1:4320/', new Map()), /subject binding/);
});

test('createOidcAdapter wires the subject map into the authentication boundary', { skip: !available }, async t => {
  assert.ok(adapter);
  const { startDevelopmentIssuer } = await import('../../examples/order-workflow/issuer.ts');
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: 'http://127.0.0.1:49999/auth/callback' });
  t.after(() => issuer.close());
  // The adapter produces a real ApplicationAuthentication over the development
  // issuer — the local IdP is one implementation of the SSO boundary.
  const authentication = await adapter.createOidcAdapter({ issuer: issuer.issuer, clientId: 'knowledger-development-client', redirectUri: 'http://127.0.0.1:49999/auth/callback', development: true, subjects });
  t.after(() => authentication.close());
  assert.equal(authentication.mode, 'oidc-development');
  assert.equal(authentication.origin, 'http://127.0.0.1:49999');
  assert.equal(authentication.issuer, issuer.issuer);
});

test('createOidcAdapter fails fast when the configured issuer differs from the provider issuer', { skip: !available }, async t => {
  assert.ok(adapter);
  const { startDevelopmentIssuer } = await import('../../examples/order-workflow/issuer.ts');
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: 'http://127.0.0.1:49999/auth/callback' });
  t.after(() => issuer.close());
  // 후행 슬래시만 다른 설정 issuer는 discovery를 통과하지만 세션 `iss`와는
  // 정확 일치가 아니므로, 모든 로그인이 조용히 거부되기 전에 생성에서 실패해야 한다.
  await assert.rejects(
    () => adapter.createOidcAdapter({ issuer: `${issuer.issuer}/`, clientId: 'knowledger-development-client', redirectUri: 'http://127.0.0.1:49999/auth/callback', development: true, subjects }),
    /does not match the provider issuer/,
  );
});

test('createOidcAdapter resolves the configured subject through a real login', { skip: !available }, async t => {
  assert.ok(adapter);
  const { startDevelopmentIssuer } = await import('../../examples/order-workflow/issuer.ts');
  const { createServer } = await import('node:http');
  const { OidcTestBrowser } = await import('../../tools/oidc-test-browser.ts');
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  // 서버가 어댑터 경계에 요청을 위임한다 — 로그인 → 세션 → actor 해석이
  // 리졸버 배선을 통해 실제로 동작하는지 검증한다.
  let authentication: Awaited<ReturnType<typeof adapter.createOidcAdapter>>;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, `http://${req.headers.host}`);
      if (await authentication.handle(req, res, url)) return;
      const session = await authentication.session(req);
      if (!session) { res.writeHead(401).end(); return; }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ actor: session.actor }));
    } catch (error) { res.writeHead(typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: `${origin}/auth/callback` });
  authentication = await adapter.createOidcAdapter({ issuer: issuer.issuer, clientId: 'knowledger-development-client', redirectUri: `${origin}/auth/callback`, development: true, subjects });
  t.after(async () => { authentication.close(); await new Promise<void>(resolve => server.close(() => resolve())); await issuer.close(); });
  const browser = new OidcTestBrowser([origin, issuer.issuer]);
  assert.equal((await browser.login(origin, 'dev-sales-owner')).status, 200);
  const body = await (await browser.request(`${origin}/session`)).json();
  assert.deepEqual(body.actor, sales);
  // 바인딩되지 않은 subject는 로그인 자체가 거부된다.
  const stranger = new OidcTestBrowser([origin, issuer.issuer]);
  assert.equal((await stranger.login(origin, 'dev-settlement-owner')).status, 403);
});

test('createOidcAdapter refuses a non-loopback HTTP issuer without development mode', { skip: !available }, async () => {
  assert.ok(adapter);
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  await assert.rejects(() => adapter.createOidcAdapter({ issuer: 'http://idp.example.com/', clientId: 'knowledger-development-client', redirectUri: 'https://app.example.com/auth/callback', subjects }), /HTTPS/);
});

test('createOidcAdapter fails fast on an empty subject map and rejects configuration errors', { skip: !available }, async () => {
  assert.ok(adapter);
  await assert.rejects(() => adapter.createOidcAdapter({ issuer: 'https://idp.example.com/', clientId: 'c', redirectUri: 'https://app.example.com/cb', subjects: new Map() }), /subject binding/);
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  await assert.rejects(() => adapter.createOidcAdapter({ issuer: 'not-a-url', clientId: 'c', redirectUri: 'https://app.example.com/cb', subjects }), /issuer is not a valid URL/);
});
