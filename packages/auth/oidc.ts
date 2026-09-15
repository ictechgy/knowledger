import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as oidc from 'openid-client';
import type { Actor } from '../storage/local-ledger.ts';
import { AuthenticationError } from './types.ts';
import type { ApplicationAuthentication, AuthenticatedSession } from './types.ts';

export interface OidcAuthenticationOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  development?: boolean;
  clientAuthentication?: oidc.ClientAuth;
  /** Operator-controlled mapping; never derive the actor from browser input. */
  resolveActor(issuer: string, subject: string): Actor | undefined | Promise<Actor | undefined>;
  sessionMaxAgeMs?: number;
  authorizationVersionClaim?: string;
  now?: () => number;
}

interface LoginFlow { state: string; nonce: string; verifier: string; expires: number }
interface SessionRecord extends AuthenticatedSession { subject: string; accessToken: string; issuer: string; authorizationVersion?: string | number }
const token = () => randomBytes(32).toString('hex');
const sameActor = (a: Actor, b: Actor) => a.org_id === b.org_id && a.actor_id === b.actor_id && a.kind === b.kind;
const sameToken = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const loopback = (url: URL) => ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);

function cookie(req: IncomingMessage, name: string): string | undefined {
  const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  const value = values[0].slice(name.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/** Authorization Code + PKCE, signed ID tokens, browser-bound state and nonce. */
export class OidcAuthentication implements ApplicationAuthentication {
  readonly mode: 'oidc-development' | 'oidc';
  readonly origin: string;
  private readonly options: OidcAuthenticationOptions;
  private readonly config: oidc.Configuration;
  private readonly issuer: string;
  private readonly redirectUri: string;
  private readonly secure: boolean;
  private readonly cookieNamespace: string;
  private readonly flows = new Map<string, LoginFlow>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly context = new AsyncLocalStorage<string>();
  private readonly now: () => number;
  private closed = false;

  private constructor(config: oidc.Configuration, options: OidcAuthenticationOptions) {
    this.config = config; this.options = options;
    this.issuer = config.serverMetadata().issuer;
    this.redirectUri = new URL(options.redirectUri).href;
    this.origin = new URL(options.redirectUri).origin;
    this.secure = this.origin.startsWith('https:');
    this.cookieNamespace = createHash('sha256').update(this.origin).digest('hex').slice(0, 16);
    this.mode = options.development ? 'oidc-development' : 'oidc';
    this.now = options.now ?? Date.now;
  }

  static async create(options: OidcAuthenticationOptions): Promise<OidcAuthentication> {
    const issuer = new URL(options.issuer); const redirect = new URL(options.redirectUri);
    if (issuer.username || issuer.password || issuer.search || issuer.hash || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/auth/callback') throw new Error('Fixed issuer and callback URLs are required');
    const httpDevelopment = options.development === true && loopback(issuer) && loopback(redirect);
    if ((!httpDevelopment && (issuer.protocol !== 'https:' || redirect.protocol !== 'https:')) || !['http:', 'https:'].includes(issuer.protocol) || !['http:', 'https:'].includes(redirect.protocol)) throw new Error('OIDC requires HTTPS except for explicit loopback development');
    if (!options.clientId || options.clientId.length > 128 || (options.sessionMaxAgeMs !== undefined && (!Number.isSafeInteger(options.sessionMaxAgeMs) || options.sessionMaxAgeMs <= 0))) throw new Error('Invalid OIDC client configuration');
    const config = await oidc.discovery(issuer, options.clientId, { token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'RS256', [oidc.clockTolerance]: 0 }, options.clientAuthentication, {
      timeout: 5, execute: [oidc.enableNonRepudiationChecks, ...(httpDevelopment ? [oidc.allowInsecureRequests] : [])],
      [oidc.customFetch]: (url, init) => fetch(url, { ...init, body: init.body instanceof Uint8Array ? new Uint8Array(init.body).buffer : init.body, redirect: 'error' }),
    });
    const metadata = config.serverMetadata();
    for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.userinfo_endpoint, metadata.jwks_uri]) {
      if (!endpoint) throw new Error('OIDC issuer must supply authorization, token, userinfo and JWKS endpoints');
      const parsed = new URL(endpoint);
      if (parsed.username || parsed.password || parsed.hash || (httpDevelopment ? parsed.origin !== issuer.origin : parsed.protocol !== 'https:')) throw new Error('OIDC endpoint is outside the configured trust boundary');
    }
    return new OidcAuthentication(config, options);
  }

  private cookieValue(name: string, value: string, maxAge: number, path = '/'): string {
    return `${name}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`;
  }
  private sessionCookie() { return `${this.secure ? '__Host-' : ''}kcl_oidc_session_${this.cookieNamespace}`; }
  private flowCookie() { return `${this.secure ? '__Host-' : ''}kcl_oidc_flow_${this.cookieNamespace}`; }
  private cleanup() {
    for (const [id, value] of this.flows) if (value.expires <= this.now()) this.flows.delete(id);
    for (const [id, value] of this.sessions) if (value.expires <= this.now()) this.sessions.delete(id);
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (!['/auth/login', '/auth/callback', '/auth/logout'].includes(url.pathname)) return false;
    if (this.closed || url.origin !== this.origin) throw new AuthenticationError('AUTH_ORIGIN_REJECTED', 403);
    this.cleanup();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'GET' && url.pathname === '/auth/login') {
      if (this.flows.size >= 128) throw new AuthenticationError('LOGIN_LIMIT', 429, true);
      const flow: LoginFlow = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier(), expires: this.now() + 300_000 };
      const id = token(); this.flows.set(id, flow);
      const target = oidc.buildAuthorizationUrl(this.config, { response_type: 'code', redirect_uri: this.redirectUri, scope: 'openid profile', state: flow.state, nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier), code_challenge_method: 'S256', prompt: 'login' });
      res.setHeader('Set-Cookie', this.cookieValue(this.flowCookie(), id, 300));
      res.writeHead(302, { Location: target.href }); res.end(); return true;
    }
    if (req.method === 'GET' && url.pathname === '/auth/callback') {
      const id = cookie(req, this.flowCookie()); const flow = id ? this.flows.get(id) : undefined;
      if (id) this.flows.delete(id); // one attempt, even when code exchange fails
      res.setHeader('Set-Cookie', this.cookieValue(this.flowCookie(), '', 0));
      if (!flow || flow.expires <= this.now()) throw new AuthenticationError('LOGIN_FLOW_EXPIRED');
      try {
        const tokens = await oidc.authorizationCodeGrant(this.config, url, { expectedState: flow.state, expectedNonce: flow.nonce, pkceCodeVerifier: flow.verifier, idTokenExpected: true });
        const claims = tokens.claims();
        if (!claims || claims.iss !== this.issuer || typeof claims.sub !== 'string' || typeof claims.exp !== 'number') throw new AuthenticationError('ID_TOKEN_REJECTED');
        const actor = await this.options.resolveActor(this.issuer, claims.sub);
        if (!actor || actor.kind !== 'human') throw new AuthenticationError('SUBJECT_UNBOUND', 403);
        const expires = Math.min(this.now() + (this.options.sessionMaxAgeMs ?? 900_000), claims.exp * 1000, this.now() + (tokens.expires_in ?? 900) * 1000);
        if (expires <= this.now()) throw new AuthenticationError('SESSION_EXPIRED');
        const record: SessionRecord = { id: token(), csrf: token(), actor: { ...actor }, expires, subject: claims.sub, issuer: this.issuer, accessToken: tokens.access_token };
        await this.verify(record, true);
        if (this.sessions.size >= 256) throw new AuthenticationError('SESSION_LIMIT', 429, true);
        const previous = cookie(req, this.sessionCookie()); if (previous) this.sessions.delete(previous);
        this.sessions.set(record.id, record);
        res.setHeader('Set-Cookie', [this.cookieValue(this.flowCookie(), '', 0), this.cookieValue(this.sessionCookie(), record.id, Math.floor((expires - this.now()) / 1000))]);
        res.writeHead(302, { Location: '/' }); res.end(); return true;
      } catch (error) {
        if (error instanceof AuthenticationError) throw error;
        throw new AuthenticationError('OIDC_CALLBACK_REJECTED');
      }
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      if (req.headers.origin !== this.origin) throw new AuthenticationError('AUTH_ORIGIN_REJECTED', 403);
      const id = cookie(req, this.sessionCookie()); const session = id ? this.sessions.get(id) : undefined;
      if (session && (typeof req.headers['x-kcl-csrf'] !== 'string' || !sameToken(req.headers['x-kcl-csrf'], session.csrf))) throw new AuthenticationError('CSRF_REJECTED', 403);
      if (id) this.sessions.delete(id);
      req.resume();
      res.setHeader('Set-Cookie', this.cookieValue(this.sessionCookie(), '', 0)); res.writeHead(204); res.end(); return true;
    }
    throw new AuthenticationError('AUTH_METHOD_REJECTED', 405);
  }

  private async verify(record: SessionRecord, initial = false): Promise<void> {
    if (this.closed || record.expires <= this.now()) throw new AuthenticationError('SESSION_EXPIRED');
    const actor = await this.options.resolveActor(record.issuer, record.subject);
    if (!actor || !sameActor(actor, record.actor)) throw new AuthenticationError('AUTHORIZATION_REVOKED', 403);
    let info: oidc.UserInfoResponse;
    try { info = await oidc.fetchUserInfo(this.config, record.accessToken, record.subject); }
    catch (error) {
      if ((error instanceof oidc.WWWAuthenticateChallengeError || error instanceof oidc.ResponseBodyError) && [401, 403].includes(error.status)) throw new AuthenticationError('AUTHORIZATION_REVOKED');
      throw new AuthenticationError('AUTH_UNAVAILABLE', 503, true);
    }
    if (record.expires <= this.now()) throw new AuthenticationError('SESSION_EXPIRED');
    const current = await this.options.resolveActor(record.issuer, record.subject);
    if (!current || !sameActor(current, record.actor)) throw new AuthenticationError('AUTHORIZATION_REVOKED', 403);
    if (this.options.authorizationVersionClaim) {
      const version = info[this.options.authorizationVersionClaim];
      if ((typeof version !== 'string' && typeof version !== 'number') || (typeof version === 'number' && !Number.isSafeInteger(version))) throw new AuthenticationError('AUTHORIZATION_REVOKED');
      if (initial) record.authorizationVersion = version;
      else if (version !== record.authorizationVersion) throw new AuthenticationError('AUTHORIZATION_REVOKED');
    }
  }

  async session(req: IncomingMessage): Promise<AuthenticatedSession | undefined> {
    this.cleanup(); const id = cookie(req, this.sessionCookie()); const record = id ? this.sessions.get(id) : undefined;
    if (!record) return undefined;
    try { await this.verify(record); }
    catch (error) { if (!(error instanceof AuthenticationError) || error.status !== 503) this.sessions.delete(record.id); throw error; }
    return { id: record.id, csrf: record.csrf, actor: { ...record.actor }, expires: record.expires };
  }

  async run<T>(session: AuthenticatedSession, operation: () => Promise<T>): Promise<T> {
    return this.context.run(session.id, async () => {
      await this.assertCurrentActor(session.actor);
      const result = await operation();
      await this.assertCurrentActor(session.actor);
      return result;
    });
  }

  async assertCurrentActor(actor: Actor): Promise<void> {
    const id = this.context.getStore(); const record = id ? this.sessions.get(id) : undefined;
    if (!record || !sameActor(record.actor, actor)) throw new AuthenticationError('AUTHORIZATION_REQUIRED', 403);
    await this.verify(record);
    // A concurrent logout must also invalidate work that awaited userinfo.
    if (this.sessions.get(record.id) !== record) throw new AuthenticationError('AUTHORIZATION_REVOKED');
  }
  close(): void { this.closed = true; this.flows.clear(); this.sessions.clear(); }
}
