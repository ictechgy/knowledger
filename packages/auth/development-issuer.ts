import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { exportJWK, generateKeyPair } from 'jose';
import Provider, { type Account, type ErrorOut, type KoaContextWithOIDC } from 'oidc-provider';

const MAX_FORM_BYTES = 16 * 1024;
const CSRF_COOKIE = 'knowledger_development_interaction_csrf';
const DEFAULT_CLIENT_ID = 'knowledger-development-client';
const CSRF_TTL_MS = 5 * 60_000;
const MAX_CSRF_INTERACTIONS = 256;

interface CsrfEntry {
  readonly token: string;
  readonly expires: number;
}

interface DevelopmentAccount {
  readonly subject: string;
  readonly label: string;
  enabled: boolean;
  version: number;
}

export type DevelopmentAccountDefinition = Omit<DevelopmentAccount, 'enabled' | 'version'>;

export interface DevelopmentIssuer {
  readonly issuer: string;
  readonly server: Server;
  close(): Promise<void>;
  setAccountEnabled(subject: string, enabled: boolean): void;
  setAccountVersion(subject: string, version: number): void;
}

export interface StartDevelopmentIssuerOptions {
  accounts: readonly DevelopmentAccountDefinition[];
  port: number;
  redirectUri: string;
  clientId?: string;
  subjects?: readonly string[];
}

function assertLoopbackRedirect(redirectUri: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new TypeError('redirectUri must be a valid URL');
  }

  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== '/auth/callback'
  ) {
    throw new TypeError('redirectUri must be a public HTTP loopback URL');
  }
  return parsed;
}

function assertClientId(clientId: string): void {
  if (!/^[A-Za-z0-9._~-]{1,128}$/.test(clientId)) {
    throw new TypeError('clientId must be a safe OAuth client identifier');
  }
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError('port must be an integer from 0 through 65535');
  }
}

function htmlEscape(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] as string);
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // An invalid cookie is treated as absent.
    }
  }
  return cookies;
}

function constantTimeEqual(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; base-uri 'none'; style-src 'unsafe-inline'");
}

function setCsrfCookie(res: ServerResponse, name: string, token: string): void {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(token)}; Path=/interaction; Max-Age=300; HttpOnly; SameSite=Lax`);
}

function clearCsrfCookie(res: ServerResponse, name: string): void {
  res.setHeader('Set-Cookie', `${name}=; Path=/interaction; Max-Age=0; HttpOnly; SameSite=Lax`);
}

interface HtmlContext {
  status: number;
  type: string;
  body: unknown;
}

function sendHtml(ctx: HtmlContext, status: number, body: string): void {
  ctx.status = status;
  ctx.type = 'html';
  ctx.body = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>개발용 로그인</title></head><body>${body}</body></html>`;
}

function sendInteractionError(ctx: HtmlContext, status: number): void {
  sendHtml(ctx, status, '<h1>개발용 로그인 요청을 처리할 수 없습니다.</h1>');
}

function accountFor(accounts: Map<string, DevelopmentAccount>, subject: string): DevelopmentAccount | undefined {
  return accounts.get(subject);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_FORM_BYTES) {
      throw new Error('form too large');
    }
    chunks.push(buffer);
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/x-www-form-urlencoded') {
    throw new Error('form content type rejected');
  }
  const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  const form = new URLSearchParams(source);
  const names = new Set<string>();
  for (const [name] of form) {
    if (names.has(name)) throw new Error('duplicate form field');
    names.add(name);
  }
  return form;
}

function interactionPath(pathname: string): { uid: string } | undefined {
  const match = /^\/interaction\/([A-Za-z0-9_-]{16,256})$/.exec(pathname);
  return match ? { uid: match[1] } : undefined;
}

function interactionPage(
  uid: string,
  csrf: string,
  accounts: readonly DevelopmentAccount[],
  prompt: 'login' | 'consent',
  account?: DevelopmentAccount,
): string {
  const safeUid = htmlEscape(uid);
  const safeCsrf = htmlEscape(csrf);
  if (prompt === 'consent') {
    const label = htmlEscape(account?.label ?? '선택된 개발 계정');
    return `<h1>개발용 로그인</h1><p>${label} 계정으로 애플리케이션 접근을 승인합니다.</p><form method="post" action="/interaction/${safeUid}"><input type="hidden" name="csrf" value="${safeCsrf}"><input type="hidden" name="prompt" value="consent"><button type="submit">승인</button></form>`;
  }
  const buttons = accounts.map((candidate) => {
    const disabled = candidate.enabled ? '' : ' disabled';
    return `<button type="submit" name="account_id" value="${htmlEscape(candidate.subject)}"${disabled}>${htmlEscape(candidate.label)}${candidate.enabled ? '' : ' (비활성)'}</button>`;
  }).join('');
  return `<h1>개발용 로그인</h1><p>실제 비밀번호가 없는 로컬 테스트 계정을 선택합니다.</p><form method="post" action="/interaction/${safeUid}"><input type="hidden" name="csrf" value="${safeCsrf}"><input type="hidden" name="prompt" value="login">${buttons}</form>`;
}

async function reservePort(requested: number): Promise<number> {
  if (requested !== 0) return requested;
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => resolve());
  });
  const address = reservation.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error('could not reserve a loopback port');
  return port;
}

export async function startDevelopmentIssuer(options: StartDevelopmentIssuerOptions): Promise<DevelopmentIssuer> {
  assertPort(options.port);
  assertLoopbackRedirect(options.redirectUri);
  const clientId = options.clientId ?? DEFAULT_CLIENT_ID;
  assertClientId(clientId);
  if (!Array.isArray(options.accounts) || options.accounts.length < 1 || options.accounts.length > 128
    || options.accounts.some(account => !account || typeof account.subject !== 'string' || !/^[A-Za-z0-9._:-]{3,128}$/.test(account.subject)
      || typeof account.label !== 'string' || !account.label.trim() || account.label.length > 200)
    || new Set(options.accounts.map(account => account.subject)).size !== options.accounts.length) throw new TypeError('Explicit distinct development accounts are required');
  if (options.subjects !== undefined && (!Array.isArray(options.subjects) || options.subjects.length === 0 || new Set(options.subjects).size !== options.subjects.length
    || options.subjects.some(subject => !options.accounts.some(account => account.subject === subject)))) throw new TypeError('Unknown or duplicate development account selection');
  const selectedAccounts = options.accounts.filter(account => options.subjects === undefined || options.subjects.includes(account.subject));
  const port = await reservePort(options.port);
  const issuer = `http://127.0.0.1:${port}`;
  const cookieNamespace = createHash('sha256').update(issuer).digest('hex').slice(0, 16);
  const csrfCookieName = `${CSRF_COOKIE}_${cookieNamespace}`;

  const accounts = new Map<string, DevelopmentAccount>(selectedAccounts.map((definition) => [definition.subject, {
    ...definition,
    enabled: true,
    version: 1,
  }]));
  const csrfByInteraction = new Map<string, CsrfEntry>();
  function cleanupCsrf(now = Date.now()): void {
    for (const [uid, entry] of csrfByInteraction) {
      if (entry.expires <= now) csrfByInteraction.delete(uid);
    }
    while (csrfByInteraction.size >= MAX_CSRF_INTERACTIONS) {
      const oldest = csrfByInteraction.keys().next().value;
      if (typeof oldest !== 'string') break;
      csrfByInteraction.delete(oldest);
    }
  }
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const privateJwk = await exportJWK(privateKey);
  privateJwk.alg = 'RS256';
  privateJwk.use = 'sig';
  privateJwk.kid = randomBytes(16).toString('base64url');
  const cookieKey = randomBytes(32).toString('base64url');
  const provider = new Provider(issuer, {
    jwks: { keys: [privateJwk] },
    cookies: { keys: [cookieKey], names: { session: `knowledger_idp_session_${cookieNamespace}`, interaction: `knowledger_idp_interaction_${cookieNamespace}`, resume: `knowledger_idp_resume_${cookieNamespace}` } },
    clients: [{
      client_id: clientId,
      redirect_uris: [options.redirectUri],
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    }],
    claims: {
      openid: ['sub'],
      profile: ['name', 'account_version'],
    },
    interactions: {
      url: (_ctx, interaction) => `/interaction/${interaction.uid}`,
    },
    findAccount: (_ctx, subject): Account | undefined => {
      const account = accountFor(accounts, subject);
      if (!account || !account.enabled) return undefined;
      return {
        accountId: account.subject,
        claims: async () => ({
          sub: account.subject,
          name: account.label,
          account_version: account.version,
        }),
      };
    },
    pkce: { required: () => true },
    ttl: {
      AccessToken: 900,
      AuthorizationCode: 300,
      Grant: 300,
      IdToken: 900,
      Interaction: 300,
      Session: 900,
    },
    features: {
      devInteractions: { enabled: false },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) => {
          sendHtml(ctx, 200, `<h1>개발 계정 변경</h1><p>선택한 계정으로 계속하려면 이전 로그인 상태를 종료하세요.</p>${form}<button type="submit" form="op.logoutForm" value="yes" name="logout">이전 계정에서 로그아웃</button>`);
        },
      },
    },
    renderError: (ctx, out: ErrorOut) => {
      if (ctx.accepts('json', 'html') === 'json') {
        ctx.type = 'json';
        ctx.body = { error: out.error };
      } else {
        sendInteractionError(ctx, 400);
      }
    },
  });

  provider.use(async (ctx, next) => {
    const path = interactionPath(ctx.path);
    if (!path) {
      await next();
      return;
    }
    if (ctx.method === 'GET') {
      try {
        cleanupCsrf();
        const interaction = await provider.interactionDetails(ctx.req, ctx.res);
        const account = interaction.session?.accountId ? accountFor(accounts, interaction.session.accountId) : undefined;
        if (account && !account.enabled) {
          sendInteractionError(ctx, 403);
          return;
        }
        const prompt = interaction.prompt.name === 'consent' ? 'consent' : interaction.prompt.name === 'login' ? 'login' : undefined;
        if (!prompt) {
          sendInteractionError(ctx, 400);
          return;
        }
        const csrf = randomBytes(32).toString('base64url');
        csrfByInteraction.set(path.uid, { token: csrf, expires: Date.now() + CSRF_TTL_MS });
        cleanupCsrf();
        setCsrfCookie(ctx.res, csrfCookieName, csrf);
        sendHtml(ctx, 200, interactionPage(path.uid, csrf, [...accounts.values()], prompt, account));
      } catch {
        sendInteractionError(ctx, 400);
      }
      return;
    }
    if (ctx.method !== 'POST') {
      ctx.status = 405;
      ctx.set('Allow', 'GET, POST');
      return;
    }
    const origin = ctx.get('Origin');
    if (origin !== issuer) {
      sendInteractionError(ctx, 403);
      return;
    }
    const csrfCookie = parseCookies(ctx.get('Cookie'));
    let form: URLSearchParams;
    try {
      form = await readForm(ctx.req);
    } catch {
      sendInteractionError(ctx, 400);
      return;
    }
    cleanupCsrf();
    const csrfEntry = csrfByInteraction.get(path.uid);
    const submittedCsrf = form.get('csrf') ?? undefined;
    csrfByInteraction.delete(path.uid);
    clearCsrfCookie(ctx.res, csrfCookieName);
    if (!csrfEntry || !constantTimeEqual(csrfEntry.token, submittedCsrf) || !constantTimeEqual(csrfEntry.token, csrfCookie.get(csrfCookieName))) {
      sendInteractionError(ctx, 403);
      return;
    }
    try {
      const interaction = await provider.interactionDetails(ctx.req, ctx.res);
      const prompt = form.get('prompt');
      if (prompt === 'login' && interaction.prompt.name === 'login') {
        const account = accountFor(accounts, form.get('account_id') ?? '');
        if (!account || !account.enabled) {
          sendInteractionError(ctx, 403);
          return;
        }
        await provider.interactionFinished(ctx.req, ctx.res, {
          login: { accountId: account.subject },
        }, { mergeWithLastSubmission: false });
        return;
      }
      if (prompt === 'consent' && interaction.prompt.name === 'consent') {
        const account = accountFor(accounts, interaction.session?.accountId ?? '');
        if (!account || !account.enabled) {
          sendInteractionError(ctx, 403);
          return;
        }
        const grant = interaction.grantId
          ? await provider.Grant.find(interaction.grantId)
          : new provider.Grant({ accountId: account.subject, clientId: String(interaction.params.client_id) });
        if (!grant) {
          sendInteractionError(ctx, 400);
          return;
        }
        const details = interaction.prompt.details as {
          missingOIDCScope?: string[];
          missingOIDCClaims?: string[];
        };
        if (details.missingOIDCScope) grant.addOIDCScope(details.missingOIDCScope.join(' '));
        if (details.missingOIDCClaims) grant.addOIDCClaims(details.missingOIDCClaims);
        const grantId = await grant.save();
        await provider.interactionFinished(ctx.req, ctx.res, { consent: { grantId } });
        return;
      }
      sendInteractionError(ctx, 400);
    } catch {
      sendInteractionError(ctx, 400);
    }
  });

  const callback = provider.callback();
  const server = createServer((req, res) => {
    setSecurityHeaders(res);
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.statusCode = 400;
      res.end('Bad Request');
      return;
    }
    callback(req, res);
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    issuer,
    server,
    async close() {
      provider.removeAllListeners();
      csrfByInteraction.clear();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
    setAccountEnabled(subject, enabled) {
      const account = accountFor(accounts, subject);
      if (!account) throw new Error('unknown development subject');
      account.enabled = enabled;
    },
    setAccountVersion(subject, version) {
      const account = accountFor(accounts, subject);
      if (!account) throw new Error('unknown development subject');
      if (!Number.isSafeInteger(version) || version < 1) throw new RangeError('account version must be a positive integer');
      account.version = version;
    },
  };
}
