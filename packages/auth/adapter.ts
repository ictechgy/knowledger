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
  return (candidateIssuer, subject) => new URL(candidateIssuer).href === expected ? subjects.get(subject) : undefined;
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
export function createOidcAdapter(options: OidcAdapterOptions): Promise<ApplicationAuthentication> {
  return OidcAuthentication.create({
    issuer: options.issuer, clientId: options.clientId, redirectUri: options.redirectUri, development: options.development,
    authorizationVersionClaim: options.authorizationVersionClaim, sessionMaxAgeMs: options.sessionMaxAgeMs, now: options.now,
    resolveActor: subjectActorResolver(options.issuer, options.subjects),
  });
}
