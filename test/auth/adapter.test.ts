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
  assert.equal(resolve('http://127.0.0.1:80/', 'dev-sales-owner'), undefined); // 기본 포트 명시
  assert.equal(resolve('http://127.0.0.1:4320/./', 'dev-sales-owner'), undefined); // 닷 세그먼트
  assert.equal(resolve('HTTP://127.0.0.1:4320/', 'dev-sales-owner'), undefined); // 스킴 대소문자
  // malformed 후보 issuer는 예외가 아니라 거부다 — 리졸버는 항상 total 이어야 한다.
  assert.equal(resolve('not-a-url', 'dev-sales-owner'), undefined);
  assert.equal(resolve('', 'dev-sales-owner'), undefined);
  assert.equal(resolve('http://[::1', 'dev-sales-owner'), undefined);
});

test('createOidcAdapter wires the subject map into the authentication boundary', { skip: !available }, async t => {
  assert.ok(adapter);
  const { startDevelopmentIssuer } = await import('../../examples/order-workflow/issuer.ts');
  const subjects = new Map([['dev-sales-owner', sales]] as const);
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: 'http://127.0.0.1:49999/auth/callback' });
  // The adapter produces a real ApplicationAuthentication over the development
  // issuer — the local IdP is one implementation of the SSO boundary.
  const authentication = await adapter.createOidcAdapter({ issuer: issuer.issuer, clientId: 'knowledger-development-client', redirectUri: 'http://127.0.0.1:49999/auth/callback', development: true, subjects });
  t.after(() => { authentication.close(); issuer.close(); });
  assert.equal(authentication.mode, 'oidc-development');
  assert.equal(authentication.origin, 'http://127.0.0.1:49999');
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
