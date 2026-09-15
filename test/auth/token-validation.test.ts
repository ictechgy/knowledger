import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { OidcTestBrowser } from '../../tools/oidc-test-browser.ts';

const requireAuth = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
let available = true;
for (const dependency of ['openid-client', 'jose']) {
  try { requireAuth.resolve(dependency); }
  catch (error) { const e = error as NodeJS.ErrnoException; if (e.code !== 'MODULE_NOT_FOUND' || !e.message.startsWith(`Cannot find module '${dependency}'`)) throw error; available = false; }
}

test('OIDC validates ID-token signature, audience, issuer and expiry', { skip: !available }, async t => {
  const { OidcAuthentication } = await import('../../packages/auth/oidc.ts');
  const { generateKeyPair, exportJWK, SignJWT } = await import(requireAuth.resolve('jose'));
  const [trusted, untrusted] = await Promise.all([generateKeyPair('RS256'), generateKeyPair('RS256')]);
  const publicJwk = { ...await exportJWK(trusted.publicKey), kid: 'primary', alg: 'RS256', use: 'sig' };
  let tokenCase = 'valid';
  let userInfoFailure = 0;
  const codes = new Map<string, { nonce: string; challenge: string; redirect: string }>();
  const accessToken = randomBytes(32).toString('base64url');
  const issuerServer = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
      const url = new URL(req.url!, issuer);
      if (url.pathname === '/.well-known/openid-configuration') {
        res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'] })); return;
      }
      if (url.pathname === '/jwks') { res.end(JSON.stringify({ keys: [publicJwk] })); return; }
      if (url.pathname === '/authorize') {
        const code = randomBytes(32).toString('base64url');
        codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')!, redirect: url.searchParams.get('redirect_uri')! });
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', code); callback.searchParams.set('state', url.searchParams.get('state')!); callback.searchParams.set('iss', issuer);
        res.writeHead(302, { Location: callback.href }); res.end(); return;
      }
      if (url.pathname === '/token') {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const record = codes.get(form.get('code') ?? ''); codes.delete(form.get('code') ?? '');
        if (!record || record.redirect !== form.get('redirect_uri') || createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') !== record.challenge) { res.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' })); return; }
        const now = Math.floor(Date.now() / 1000);
        const idToken = await new SignJWT({ nonce: record.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'primary' }).setSubject('known-subject')
          .setIssuer(tokenCase === 'issuer' ? `${issuer}/different` : issuer).setAudience(tokenCase === 'audience' ? 'other-client' : 'test-client')
          .setIssuedAt(now).setExpirationTime(tokenCase === 'expiry' ? now - 60 : now + 600).sign(tokenCase === 'signature' ? untrusted.privateKey : trusted.privateKey);
        res.end(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 600, id_token: idToken })); return;
      }
      if (url.pathname === '/userinfo' && req.headers.authorization === `Bearer ${accessToken}`) {
        if (userInfoFailure) { const status = userInfoFailure; userInfoFailure = 0; res.writeHead(status).end(JSON.stringify({ error: 'temporarily_unavailable' })); return; }
        res.end(JSON.stringify({ sub: 'known-subject' })); return;
      }
      res.writeHead(404).end();
    } catch { res.writeHead(500).end(JSON.stringify({ error: 'test_issuer_error' })); }
  });
  await new Promise<void>(resolve => issuerServer.listen(0, '127.0.0.1', resolve));
  const issuer = `http://127.0.0.1:${(issuerServer.address() as { port: number }).port}`;
  let auth: Awaited<ReturnType<typeof OidcAuthentication.create>>;
  const app = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, origin);
      if (await auth.handle(req, res, url)) return;
      if (url.pathname === '/') { res.end('Application'); return; }
      const session = await auth.session(req);
      res.writeHead(session ? 200 : 401).end();
    } catch (error) { res.writeHead(error && typeof error === 'object' && 'status' in error ? Number(error.status) : 500).end(); }
  });
  await new Promise<void>(resolve => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as { port: number }).port}`;
  auth = await OidcAuthentication.create({ issuer, clientId: 'test-client', redirectUri: `${origin}/auth/callback`, development: true,
    resolveActor: (receivedIssuer, subject) => receivedIssuer === issuer && subject === 'known-subject' ? { org_id: 'SalesMSP', actor_id: 'person-sales-owner', kind: 'human' } : undefined });
  t.after(async () => { auth.close(); await Promise.all([new Promise<void>(resolve => app.close(() => resolve())), new Promise<void>(resolve => issuerServer.close(() => resolve()))]); });
  for (const scenario of ['valid', 'signature', 'audience', 'issuer', 'expiry']) {
    tokenCase = scenario;
    const browser = new OidcTestBrowser([origin, issuer]);
    const response = await browser.login(origin, 'unused-in-protocol-fixture');
    assert.equal(response.status, scenario === 'valid' ? 200 : 401, `ID-token ${scenario} validation`);
    assert.equal((await browser.request(`${origin}/session`)).status, scenario === 'valid' ? 200 : 401);
  }
  tokenCase = 'valid';
  const recovering = new OidcTestBrowser([origin, issuer]);
  assert.equal((await recovering.login(origin, 'unused-in-protocol-fixture')).status, 200);
  userInfoFailure = 429;
  assert.equal((await recovering.request(`${origin}/session`)).status, 503);
  assert.equal((await recovering.request(`${origin}/session`)).status, 200, 'Transient UserInfo failure must preserve the same session');
});
