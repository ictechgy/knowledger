import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { OidcTestBrowser } from '../../tools/oidc-test-browser.ts';
import type { Actor } from '../../packages/storage/local-ledger.ts';

const requireAuth = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
let available = true;
for (const dependency of ['openid-client', 'oidc-provider', 'jose']) {
  try { requireAuth.resolve(dependency); }
  catch (error) { const e = error as NodeJS.ErrnoException; if (e.code !== 'MODULE_NOT_FOUND' || !e.message.startsWith(`Cannot find module '${dependency}'`)) throw error; available = false; }
}
const modules = available ? await Promise.all([import('../../packages/auth/oidc.ts'), import('../../examples/order-workflow/issuer.ts')]) : undefined;
const sales: Actor = { org_id: 'SalesMSP', actor_id: 'person-sales-owner', kind: 'human' };

async function fixture(t: any) {
  assert.ok(modules);
  const [{ OidcAuthentication }, { startDevelopmentIssuer }] = modules;
  let auth: Awaited<ReturnType<typeof OidcAuthentication.create>>;
  let now = Date.now();
  let enabledBinding = true;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (await auth.handle(req, res, url)) return;
      if (url.pathname === '/') { res.end('Application'); return; }
      const session = await auth.session(req);
      if (!session) { res.writeHead(401).end(); return; }
      if (url.pathname === '/session') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ actor: session.actor, csrf: session.csrf })); return; }
      await auth.run(session, async () => { await auth.assertCurrentActor(sales); });
      res.end('authorized');
    } catch (error) { res.writeHead(typeof error === 'object' && error && 'status' in error ? Number(error.status) : 500).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: `${origin}/auth/callback` });
  auth = await OidcAuthentication.create({ issuer: issuer.issuer, clientId: 'kcl-development-client', redirectUri: `${origin}/auth/callback`, development: true,
    authorizationVersionClaim: 'account_version', now: () => now, resolveActor: (receivedIssuer, subject) => enabledBinding && receivedIssuer === issuer.issuer && subject === 'dev-sales-owner' ? sales : undefined });
  t.after(async () => { auth.close(); await new Promise<void>(resolve => server.close(() => resolve())); await issuer.close(); });
  return { auth, issuer, origin, browser: new OidcTestBrowser([origin, issuer.issuer]), expire: () => { now += 1_000_000; }, revokeBinding: () => { enabledBinding = false; } };
}

test('OIDC login binds issuer/subject and rejects callback replay and unbound accounts', { skip: !available }, async t => {
  const f = await fixture(t);
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 401);
  assert.equal((await f.browser.login(f.origin, 'dev-sales-owner')).status, 200);
  const session = await (await f.browser.request(`${f.origin}/session`)).json();
  assert.deepEqual(session.actor, sales);
  assert.equal((await f.browser.replayCallback()).status, 401);
  assert.equal((await f.browser.login(f.origin, 'dev-settlement-owner')).status, 403);
  assert.equal((await new OidcTestBrowser([f.origin, f.issuer.issuer]).login(f.origin, 'dev-settlement-owner')).status, 403);
});

test('OIDC rejects tampered state, nonce and PKCE instead of creating a session', { skip: !available }, async t => {
  const f = await fixture(t);
  for (const mutate of [
    { callback: (url: URL) => url.searchParams.set('state', 'tampered-state') },
    { authorization: (url: URL) => url.searchParams.set('nonce', 'tampered-nonce') },
    { authorization: (url: URL) => url.searchParams.set('code_challenge', 'A'.repeat(43)) },
  ]) {
    const browser = new OidcTestBrowser([f.origin, f.issuer.issuer]);
    assert.equal((await browser.login(f.origin, 'dev-sales-owner', mutate)).status, 401);
    assert.equal((await browser.request(`${f.origin}/session`)).status, 401);
  }
});

test('OIDC logout, expiry, disabled account and changed authorization version revoke access', { skip: !available }, async t => {
  const f = await fixture(t);
  await f.browser.login(f.origin, 'dev-sales-owner');
  const session = await (await f.browser.request(`${f.origin}/session`)).json();
  assert.equal((await f.browser.request(`${f.origin}/auth/logout`, { method: 'POST', headers: { Origin: 'https://untrusted.example', 'X-KCL-CSRF': session.csrf } })).status, 403);
  assert.equal((await f.browser.request(`${f.origin}/auth/logout`, { method: 'POST', headers: { Origin: f.origin, 'X-KCL-CSRF': 'wrong' } })).status, 403);
  assert.equal((await f.browser.request(`${f.origin}/auth/logout`, { method: 'POST', headers: { Origin: f.origin, 'X-KCL-CSRF': session.csrf } })).status, 204);
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 401);
  await f.browser.login(f.origin, 'dev-sales-owner');
  f.issuer.setAccountVersion('dev-sales-owner', 2);
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 401);
  await f.browser.login(f.origin, 'dev-sales-owner');
  f.issuer.setAccountEnabled('dev-sales-owner', false);
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 401);
  f.issuer.setAccountEnabled('dev-sales-owner', true);
  await f.browser.login(f.origin, 'dev-sales-owner'); f.expire();
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 401);
});

test('OIDC binding removal and missing authorization context fail closed', { skip: !available }, async t => {
  const f = await fixture(t);
  await assert.rejects(() => f.auth.assertCurrentActor(sales));
  await f.browser.login(f.origin, 'dev-sales-owner'); f.revokeBinding();
  assert.equal((await f.browser.request(`${f.origin}/session`)).status, 403);
});

test('two loopback applications keep independent browser sessions and logout boundaries', { skip: !available }, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const browser = new OidcTestBrowser([first.origin, first.issuer.issuer, second.origin, second.issuer.issuer]);
  assert.equal((await browser.login(first.origin, 'dev-sales-owner')).status, 200);
  assert.equal((await browser.login(second.origin, 'dev-sales-owner')).status, 200);
  const response = await browser.request(`${first.origin}/session`);
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal((await browser.request(`${first.origin}/auth/logout`, { method: 'POST', headers: { Origin: first.origin, 'X-KCL-CSRF': session.csrf } })).status, 204);
  assert.equal((await browser.request(`${first.origin}/session`)).status, 401);
  assert.equal((await browser.request(`${second.origin}/session`)).status, 200);
});
