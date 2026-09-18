import { OidcAuthentication } from '../../packages/auth/oidc.ts';
import { createRemoteSigner } from '../../packages/fabric/remote-signer.ts';
import { DEVELOPMENT_SIGNING_KEY_IDS } from './signing-service.ts';
import { createFabricTestRuntime } from './fabric-runtime.ts';
import { PERSONAS, actorIdentity } from './config.ts';
import { DEVELOPMENT_ORGANIZATIONS, getDevelopmentOrganization } from './organizations.ts';
import type { DevelopmentOrganization } from './organizations.ts';
import { ensureRuntimeScope } from '../../packages/storage/runtime-scope.ts';

/** The actor allowlist is application configuration, not a browser or JWT claim. */
export async function createDevelopmentAuthRuntime(options: { dataDir: string; origin: string; issuer: string; socketPath: string; organization?: DevelopmentOrganization }) {
  const organization = options.organization === undefined ? undefined : getDevelopmentOrganization(options.organization);
  ensureRuntimeScope(options.dataDir, organization);
  const allowedOrganizations = organization ? [organization] : DEVELOPMENT_ORGANIZATIONS;
  const subjects = new Map<string, ReturnType<typeof actorIdentity>>(allowedOrganizations.map(selected => {
    const persona = PERSONAS.find(candidate => candidate.actor_id === selected.key_id && candidate.org_id === selected.org_id && candidate.kind === 'human');
    if (!persona) throw new Error('Development organization has no human signing persona');
    return [selected.subject, actorIdentity(persona)] as const;
  }));
  const authentication = await OidcAuthentication.create({ issuer: options.issuer, clientId: 'knowledger-development-client', redirectUri: `${options.origin}/auth/callback`, development: true,
    authorizationVersionClaim: 'account_version',
    resolveActor: (issuer, subject) => new URL(issuer).href === new URL(options.issuer).href ? subjects.get(subject) : undefined,
  });
  try {
    const runtime = await createFabricTestRuntime(options.dataDir, {
      organization,
      signerProvider: (actor, certificate, attestation) => {
        const keyId = DEVELOPMENT_SIGNING_KEY_IDS.find(id => id === actor.actor_id);
        if (!keyId) throw new Error('No development signing key is bound to this actor');
        return createRemoteSigner({ socketPath: options.socketPath, keyId, certificate, attestation: () => attestation?.current });
      },
      authorizeActor: actor => authentication.assertCurrentActor(actor),
    });
    return { ...runtime, authentication };
  } catch (error) { authentication.close(); throw error; }
}
