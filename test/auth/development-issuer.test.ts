import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import type { DevelopmentIssuer, StartDevelopmentIssuerOptions } from '../../examples/order-workflow/issuer.ts';

const CLIENT_ID = 'kcl-development-client';
const REDIRECT_URI = 'http://127.0.0.1:4399/auth/callback';
const authPackageRequire = createRequire(new URL('../../packages/auth/package.json', import.meta.url));
let openidClientPath: string | undefined;
let oidcTestSkip: string | undefined;
try {
  authPackageRequire.resolve('oidc-provider');
  authPackageRequire.resolve('jose');
  openidClientPath = authPackageRequire.resolve('openid-client');
} catch (error) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
    const message = String(error instanceof Error ? error.message : error);
    if (['openid-client', 'oidc-provider', 'jose'].some(name => message.startsWith(`Cannot find module '${name}'`))) {
      oidcTestSkip = 'Optional OIDC dependencies are not installed';
    } else {
      throw error;
    }
  } else {
    throw error;
  }
}

async function startDevelopmentIssuer(options: StartDevelopmentIssuerOptions) {
  const issuer = await import('../../examples/order-workflow/issuer.ts');
  return issuer.startDevelopmentIssuer(options);
}

async function oidcClient() {
  if (!openidClientPath) throw new Error('openid-client dependency is unavailable');
  return import(pathToFileURL(openidClientPath).href);
}

function addCookies(jar: Map<string, string>, response: Response): void {
  for (const value of response.headers.getSetCookie()) {
    const first = value.split(';', 1)[0];
    const separator = first.indexOf('=');
    if (separator > 0) jar.set(first.slice(0, separator), first.slice(separator + 1));
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function finishLogin(
  issuer: DevelopmentIssuer,
  authorizationUrl: URL,
  subject: string,
  expectForbidden = false,
): Promise<URL | undefined> {
  const jar = new Map<string, string>();
  let response = await fetch(authorizationUrl, { redirect: 'manual' });
  addCookies(jar, response);
  let location = new URL(response.headers.get('location') ?? '', issuer.issuer);

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (location.href.startsWith(REDIRECT_URI)) return location;
    response = await fetch(location, { headers: { cookie: cookieHeader(jar) }, redirect: 'manual' });
    addCookies(jar, response);
    if (expectForbidden) {
      assert.equal(response.status, 403);
      return undefined;
    }
    const nextLocation = response.headers.get('location');
    if (nextLocation) {
      location = new URL(nextLocation, issuer.issuer);
      continue;
    }

    const html = await response.text();
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf);
    const prompt = html.includes('name="account_id"') ? 'login' : 'consent';
    const body = prompt === 'login'
      ? new URLSearchParams({ csrf, prompt, account_id: subject })
      : new URLSearchParams({ csrf, prompt });
    response = await fetch(location, {
      method: 'POST',
      headers: {
        cookie: cookieHeader(jar),
        origin: issuer.issuer,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
      redirect: 'manual',
    });
    addCookies(jar, response);
    if (expectForbidden) {
      assert.equal(response.status, 403);
      return undefined;
    }
    location = new URL(response.headers.get('location') ?? '', issuer.issuer);
  }
  throw new Error('development issuer flow did not finish');
}

async function setup() {
  const issuer = await startDevelopmentIssuer({ port: 0, redirectUri: REDIRECT_URI });
  const client = await oidcClient();
  const configuration = await client.discovery(
    new URL(issuer.issuer),
    CLIENT_ID,
    undefined,
    client.None(),
    { execute: [client.allowInsecureRequests] },
  );
  const verifier = client.randomPKCECodeVerifier();
  const challenge = await client.calculatePKCECodeChallenge(verifier);
  const authorizationUrl = client.buildAuthorizationUrl(configuration, {
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: client.randomState(),
  });
  return { issuer, client, configuration, verifier, authorizationUrl };
}

test('development issuer completes PKCE code flow and exposes account claims', { skip: oidcTestSkip }, async (t) => {
  const state = await setup();
  t.after(() => state.issuer.close());
  const callback = await finishLogin(state.issuer, state.authorizationUrl, 'dev-sales-owner');
  assert.ok(callback);
  const tokens = await state.client.authorizationCodeGrant(state.configuration, callback, {
    pkceCodeVerifier: state.verifier,
    expectedState: callback.searchParams.get('state') ?? '',
  });
  assert.equal(typeof tokens.access_token, 'string');
  const claims = await state.client.fetchUserInfo(state.configuration, tokens.access_token, 'dev-sales-owner');
  assert.deepEqual({
    sub: claims.sub,
    name: claims.name,
    account_version: claims.account_version,
  }, {
    sub: 'dev-sales-owner',
    name: '영업 담당자',
    account_version: 1,
  });
  assert.equal(claims.org_id, undefined);
  assert.equal(claims.actor_id, undefined);
});

test('interaction POST requires a one-time CSRF token and rejects unknown accounts', { skip: oidcTestSkip }, async (t) => {
  const state = await setup();
  t.after(() => state.issuer.close());
  const jar = new Map<string, string>();
  let response = await fetch(state.authorizationUrl, { redirect: 'manual' });
  addCookies(jar, response);
  assert.equal(response.status, 303);
  const locationHeader = response.headers.get('location');
  assert.ok(locationHeader);
  const interaction = new URL(locationHeader, state.issuer.issuer);
  response = await fetch(interaction, { headers: { cookie: cookieHeader(jar) } });
  addCookies(jar, response);
  const csrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);
  response = await fetch(interaction, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(jar),
      origin: state.issuer.issuer,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: `${csrf}-tampered`, prompt: 'login', account_id: 'dev-sales-owner' }),
  });
  assert.equal(response.status, 403);

  response = await fetch(interaction, { headers: { cookie: cookieHeader(jar) } });
  addCookies(jar, response);
  const validCsrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(validCsrf);
  response = await fetch(interaction, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(jar),
      origin: state.issuer.issuer,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: validCsrf, prompt: 'login', account_id: 'unknown-subject' }),
  });
  assert.equal(response.status, 403);

  response = await fetch(interaction, { headers: { cookie: cookieHeader(jar) } });
  addCookies(jar, response);
  const loginCsrf = (await response.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(loginCsrf);
  response = await fetch(interaction, {
    method: 'POST',
    headers: {
      cookie: cookieHeader(jar),
      origin: state.issuer.issuer,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ csrf: loginCsrf, prompt: 'login', account_id: 'dev-sales-owner' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
});

test('disabling an account rejects its userinfo access', { skip: oidcTestSkip }, async (t) => {
  const state = await setup();
  t.after(() => state.issuer.close());
  const callback = await finishLogin(state.issuer, state.authorizationUrl, 'dev-fulfillment-owner');
  assert.ok(callback);
  const tokens = await state.client.authorizationCodeGrant(state.configuration, callback, {
    pkceCodeVerifier: state.verifier,
    expectedState: callback.searchParams.get('state') ?? '',
  });
  state.issuer.setAccountEnabled('dev-fulfillment-owner', false);
  await assert.rejects(() => state.client.fetchUserInfo(state.configuration, tokens.access_token, 'dev-fulfillment-owner'));
});

test('issuer rejects non-loopback redirects before binding a server', { skip: oidcTestSkip }, async () => {
  await assert.rejects(
    () => startDevelopmentIssuer({ port: 0, redirectUri: 'http://localhost:4399/callback' }),
    /loopback/,
  );
  await assert.rejects(
    () => startDevelopmentIssuer({ port: 0, redirectUri: 'https://127.0.0.1:4399/callback' }),
    /loopback/,
  );
  await assert.rejects(
    () => startDevelopmentIssuer({ port: 0, redirectUri: 'http://127.0.0.1:4399/auth/callback?unexpected=1' }),
    /loopback/,
  );
});

test('issuer uses fresh random values for its local cryptographic material', { skip: oidcTestSkip }, async (t) => {
  const first = await startDevelopmentIssuer({ port: 0, redirectUri: REDIRECT_URI });
  const second = await startDevelopmentIssuer({ port: 0, redirectUri: REDIRECT_URI });
  t.after(async () => { await first.close(); await second.close(); });
  const [firstJwks, secondJwks] = await Promise.all([
    fetch(`${first.issuer}/jwks`).then((response) => response.json() as Promise<{ keys: Array<Record<string, unknown>> }>),
    fetch(`${second.issuer}/jwks`).then((response) => response.json() as Promise<{ keys: Array<Record<string, unknown>> }>),
  ]);
  assert.notEqual(firstJwks.keys[0]?.kid, secondJwks.keys[0]?.kid);
  assert.equal(Object.hasOwn(firstJwks.keys[0] ?? {}, 'd'), false);
  assert.equal(Object.hasOwn(secondJwks.keys[0] ?? {}, 'd'), false);
});
