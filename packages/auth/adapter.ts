import type { Actor } from '../storage/local-ledger.ts';
import type { ApplicationAuthentication } from './types.ts';
import { OidcAuthentication } from './oidc.ts';

/**
 * Operator-bound (issuer, subject) → actor resolver. The actor comes from
 * server-side configuration, never from a browser or JWT claim: an unknown
 * subject or a mismatched issuer yields no actor and the login is refused.
 */
export function subjectActorResolver(issuer: string, subjects: ReadonlyMap<string, Actor>): (candidateIssuer: string, subject: string) => Actor | undefined {
  const expected = new URL(issuer).href;
  // 후보 issuer가 URL로 파싱되지 않으면 예외가 아니라 거부(undefined)다 — 리졸버는 항상 total 이어야 한다.
  return (candidateIssuer, subject) => URL.canParse(candidateIssuer) && new URL(candidateIssuer).href === expected ? subjects.get(subject) : undefined;
}

export interface OidcAdapterOptions {
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
  if (!options?.subjects || options.subjects.size === 0) throw new Error('OIDC adapter requires at least one subject binding');
  return OidcAuthentication.create({
    issuer: options.issuer, clientId: options.clientId, redirectUri: options.redirectUri, development: options.development,
    authorizationVersionClaim: options.authorizationVersionClaim, sessionMaxAgeMs: options.sessionMaxAgeMs, now: options.now,
    resolveActor: subjectActorResolver(options.issuer, options.subjects),
  });
}
