import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Actor } from '../../packages/storage/local-ledger.ts';
import type { ApplicationAuthentication, AuthenticatedSession } from '../../packages/auth/types.ts';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';
import { performance } from 'node:perf_hooks';

const actor: Actor = { org_id: 'FulfillmentMSP', actor_id: 'person-fulfillment-owner', kind: 'human' };

class FakeAuthentication implements ApplicationAuthentication {
  readonly mode = 'oidc-development' as const;
  readonly issuer = 'http://issuer.fake/';
  private boundOrigin = '';
  private authenticated = false;
  revoked = false;
  closed = false;
  runCount = 0;
  readonly csrf = 'a'.repeat(64);
  readonly sessionId = 'b'.repeat(64);
  get origin() { return this.boundOrigin; }
  bind(origin: string) { this.boundOrigin = origin; }
  loginCookie() { return 'fake_auth=1'; }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname === '/auth/login' && req.method === 'GET') {
      this.authenticated = true;
      res.setHeader('Set-Cookie', 'fake_auth=1; HttpOnly; SameSite=Lax; Path=/');
      res.writeHead(302, { Location: '/' }); res.end(); return true;
    }
    if (url.pathname === '/auth/logout' && req.method === 'POST') {
      if (this.authenticated && req.headers['x-knowledger-csrf'] !== this.csrf) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 'CSRF_REJECTED' })); return true;
      }
      this.authenticated = false; req.resume(); res.writeHead(204); res.end(); return true;
    }
    return false;
  }

  async session(req: IncomingMessage): Promise<AuthenticatedSession | undefined> {
    if (!this.authenticated || !/(?:^|;\s*)fake_auth=1(?:;|$)/.test(req.headers.cookie ?? '') || this.revoked) return undefined;
    return { id: this.sessionId, csrf: this.csrf, actor, expires: Date.now() + 60_000 };
  }

  async run<T>(session: AuthenticatedSession, operation: () => Promise<T>): Promise<T> {
    this.runCount++;
    assert.equal(session.actor.actor_id, actor.actor_id);
    return operation();
  }
  async assertCurrentActor() {}
  close() { this.closed = true; }
}

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-auth-api-test-'));
  const authentication = new FakeAuthentication();
  const app = await createApp({ dataDir: directory, authentication });
  const url = await app.listen(0);
  authentication.bind(url);
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, authentication, url };
}

test('authentication mode does not create a demo identity for anonymous sessions', async t => {
  const api = await fixture(t);
  const response = await fetch(`${api.url}/api/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspace: { id: 'demo', label: 'Order workflow demo' }, organizations: [], demo: true, capabilities: { publish_contexts: [], can_propose: false }, actor: null, personas: [], login_url: '/auth/login', auth_mode: 'oidc-development', mode: 'local-simulation' });
  assert.equal((await fetch(`${api.url}/v1/workspaces/demo/overview`)).status, 401);
});

test('authenticated sessions cannot inject a role and protected work uses auth.run', async t => {
  const api = await fixture(t);
  const login = await fetch(`${api.url}/auth/login`, { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = api.authentication.loginCookie();
  const sessionResponse = await fetch(`${api.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json() as any;
  assert.equal(session.actor.actor_id, actor.actor_id);
  assert.deepEqual(session.personas, []);
  assert.equal(session.logout_url, '/auth/logout');
  const injected = await fetch(`${api.url}/api/session`, { method: 'POST', headers: { Cookie: cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify({ org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' }) });
  assert.equal(injected.status, 403);
  const overview = await fetch(`${api.url}/v1/workspaces/demo/overview`, { headers: { Cookie: cookie } });
  assert.equal(overview.status, 200);
  assert.equal(api.authentication.runCount, 1);
});

test('authentication mutations require CSRF and logout revokes access', async t => {
  const api = await fixture(t);
  await fetch(`${api.url}/auth/login`, { redirect: 'manual' });
  const cookie = api.authentication.loginCookie();
  const route = `${api.url}/v1/workspaces/demo/search`;
  const noCsrf = await fetch(route, { method: 'POST', headers: { Cookie: cookie, Origin: api.url, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const logout = await fetch(`${api.url}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: api.url } });
  assert.equal(logout.status, 403);
  const okLogout = await fetch(`${api.url}/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: api.url, 'X-KNOWLEDGER-CSRF': api.authentication.csrf } });
  assert.equal(okLogout.status, 204);
  assert.equal((await fetch(`${api.url}/v1/workspaces/demo/overview`, { headers: { Cookie: cookie } })).status, 401);
});

test('revoked authentication loses protected access without exposing session details', async t => {
  const api = await fixture(t);
  await fetch(`${api.url}/auth/login`, { redirect: 'manual' });
  api.authentication.revoked = true;
  const response = await fetch(`${api.url}/v1/workspaces/demo/overview`, { headers: { Cookie: api.authentication.loginCookie() } });
  assert.equal(response.status, 401);
  const body = await response.json() as any;
  assert.equal(body.code, 'UNAUTHENTICATED');
  assert.equal(JSON.stringify(body).includes(api.authentication.csrf), false);
});

test('a revoked OIDC session exposes only the anonymous login metadata', async t => {
  const api = await fixture(t);
  t.mock.method(api.authentication, 'session', async () => { throw Object.assign(new Error('Revoked'), { status: 401, code: 'AUTHORIZATION_REVOKED' }); });
  const response = await fetch(`${api.url}/api/session`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { workspace: { id: 'demo', label: 'Order workflow demo' }, organizations: [], demo: true, capabilities: { publish_contexts: [], can_propose: false }, actor: null, personas: [], login_url: '/auth/login', auth_mode: 'oidc-development', mode: 'local-simulation' });
  assert.equal((await fetch(`${api.url}/v1/workspaces/demo/overview`)).status, 401);
});

test('strict freshness includes the final authentication check before the response', async t => {
  const api = await fixture(t);
  await fetch(`${api.url}/auth/login`, { redirect: 'manual' });
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  t.mock.method(api.authentication, 'run', async (_session: AuthenticatedSession, operation: () => Promise<unknown>) => {
    const result = await operation(); elapsed = 31_000; return result;
  });
  const response = await fetch(`${api.url}/v1/workspaces/demo/resolve`, { method: 'POST', headers: { Cookie: api.authentication.loginCookie(), Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.authentication.csrf },
    body: JSON.stringify({ document_ids: ['doc-fulfillment-delivery-definition-001'], context_id: 'context-fulfillment', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'FRESHNESS_UNAVAILABLE');
});
