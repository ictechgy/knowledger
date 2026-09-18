import type { Actor } from '../storage/local-ledger.ts';
import type { ApplicationAuthentication } from './types.ts';
import { OidcAuthentication } from './oidc.ts';

/**
 * Operator-bound (issuer, subject) → actor resolver. The actor comes from
 * server-side configuration, never from a browser or JWT claim: an unknown
 * subject or a mismatched issuer yields no actor and the login is refused.
 */
export function subjectActorResolver(issuer: string, subjects: ReadonlyMap<string, Actor>): (candidateIssuer: string, subject: string) => Actor | undefined {
  if (subjects.size === 0) throw new Error('OIDC adapter requires at least one subject binding');
  const bound = new Map(subjects);
  // OIDC `iss`는 정규화가 아니라 정확 문자열 일치다 — 설정 issuer도 있는 그대로 비교한다.
  return (candidateIssuer, subject) => candidateIssuer === issuer ? bound.get(subject) : undefined;
}

export interface OidcAdapterOptions {
  /** Must equal the provider's discovered `iss` string exactly — including trailing slash — or construction fails. */
  issuer: string;
  clientId: string;
  redirectUri: string;
  /** Explicit loopback development URLs only — never relaxes HTTPS for real deployments. */
  development?: boolean;
  authorizationVersionClaim?: string;
  /** Server-managed subject → actor bindings used for every session check. */
  subjects: ReadonlyMap<string, Actor>;
  sessionMaxAgeMs?: number;
  now?: () => number;
}

/**
 * The standards-based SSO adapter: any OIDC-compliant identity provider —
 * corporate SSO or the bundled development issuer — plugs into the
 * ApplicationAuthentication boundary through this factory. The development
 * issuer is one local implementation of the same boundary, not a special
 * case in application code.
 */
export async function createOidcAdapter(options: OidcAdapterOptions): Promise<ApplicationAuthentication> {
  // 빈 subject 맵은 모든 로그인이 조용히 거부되는 설정 오류다 — 경계 팩토리에서 fail-fast 한다.
  if (!options.subjects || options.subjects.size === 0) throw new Error('OIDC adapter requires at least one subject binding');
  // 설정 issuer는 URL 문법이어야 한다 — 어느 설정이 잘못됐는지 메시지에 남긴다.
  if (!URL.canParse(options.issuer)) throw new Error(`OIDC adapter issuer is not a valid URL: ${options.issuer}`);
  const authentication = await OidcAuthentication.create({
    issuer: options.issuer, clientId: options.clientId, redirectUri: options.redirectUri, development: options.development,
    authorizationVersionClaim: options.authorizationVersionClaim, sessionMaxAgeMs: options.sessionMaxAgeMs, now: options.now,
    resolveActor: subjectActorResolver(options.issuer, options.subjects),
  });
  // 세션은 discovery된 issuer에 바인딩된다 — 설정값과 다르면(후행 슬래시만 달라도)
  // 모든 로그인이 조용히 거부되므로 생성 시점에 두 값을 보여주며 실패한다.
  if (authentication.issuer !== options.issuer) {
    // close 실패가 불일치 진단 메시지를 덮지 않게 cause로만 첨부한다.
    let closeError: unknown;
    try { await authentication.close(); } catch (error) { closeError = error; }
    throw new Error(`OIDC adapter issuer does not match the provider issuer: configured ${options.issuer}, discovered ${authentication.issuer}`, { cause: closeError });
  }
  return authentication;
}
