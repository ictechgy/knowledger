import { OidcAuthentication } from '../../packages/auth/oidc.ts';
import { createRemoteSigner, DEVELOPMENT_SIGNING_KEY_IDS } from '../../packages/fabric/remote-signer.ts';
import { createFabricTestRuntime } from './fabric-test-runtime.ts';
import { PERSONAS, actorIdentity } from './demo-config.ts';

/** The actor allowlist is application configuration, not a browser or JWT claim. */
export async function createDevelopmentAuthRuntime(options: { dataDir: string; origin: string; issuer: string; socketPath: string }) {
  const subjects = new Map(['dev-sales-owner', 'dev-fulfillment-owner', 'dev-settlement-owner'].map((subject, index) => [subject, actorIdentity(PERSONAS[index])]));
  const authentication = await OidcAuthentication.create({ issuer: options.issuer, clientId: 'kcl-development-client', redirectUri: `${options.origin}/auth/callback`, development: true,
    authorizationVersionClaim: 'account_version',
    resolveActor: (issuer, subject) => new URL(issuer).href === new URL(options.issuer).href ? subjects.get(subject) : undefined,
  });
  try {
    const runtime = await createFabricTestRuntime(options.dataDir, {
      signerProvider: (actor, certificate) => {
        const keyId = DEVELOPMENT_SIGNING_KEY_IDS.find(id => id === actor.actor_id);
        if (!keyId) throw new Error('No development signing key is bound to this actor');
        return createRemoteSigner({ socketPath: options.socketPath, keyId, certificate });
      },
      authorizeActor: actor => authentication.assertCurrentActor(actor),
    });
    return { ...runtime, authentication };
  } catch (error) { authentication.close(); throw error; }
}
