import { createApp } from './server.ts';
import { configuredOutboxFile } from './configured-fabric-runtime.ts';
import { applicationDefinition, configurationAuthorityDigest, validateProjectConfiguration } from '../../packages/config/project.ts';
import type { ProjectConfiguration } from '../../packages/config/types.ts';
import type { ApplicationAuthentication } from '../../packages/auth/types.ts';
import type { ApplicationLedger } from '../../packages/storage/ledger-port.ts';
import { ensureConfigurationScope } from '../../packages/storage/configuration-scope.ts';
import type { ConfiguredRuntimeBinding } from '../../packages/storage/configuration-scope.ts';

/** Select and bind one installation before opening any configured identity or connection. */
export async function createConfiguredApp(input: ProjectConfiguration, options: {dataDir:string;port:number;organization?:string}) {
  const configuration = validateProjectConfiguration(input);
  const definition = applicationDefinition(configuration);
  const fabric = configuration.ledger.mode === 'fabric';
  if (fabric && (!options.organization || !configuration.organizations.some(org=>org.org_id===options.organization))) throw new Error('Fabric requires --organization with a configured organization ID');
  if (!fabric && options.organization) throw new Error('Local simulation shares one development process; organization selection requires Fabric');
  const references = configuration.fabric?.identities.filter(actor=>actor.org_id===options.organization) ?? [];
  const binding: ConfiguredRuntimeBinding = {
    version:1, workspace_id:configuration.workspace.id, channel_id:configuration.ledger.channel_id, mode:configuration.ledger.mode,
    authority_digest:configurationAuthorityDigest(configuration),
    ...(fabric ? {organization:options.organization} : {}),
    databases:fabric ? ['private-local.sqlite','fabric-projection.sqlite',...references.map(actor=>configuredOutboxFile(actor.org_id,actor.actor_id))].sort() : ['private-local.sqlite','shared-ledger.sqlite'],
  };
  ensureConfigurationScope(options.dataDir,binding);
  let authentication:ApplicationAuthentication|undefined;
  let ledger:ApplicationLedger|undefined;
  let personas = definition.personas;
  try {
    const auth = configuration.authentication;
    if (auth.mode === 'oidc') {
      const origin = configuration.server?.public_origin ?? `http://127.0.0.1:${options.port}`;
      if (options.port === 0 && !configuration.server) throw new Error('OIDC requires a fixed callback port or public origin');
      const subjects = new Map(auth.bindings.filter(binding=>!fabric||binding.org_id===options.organization).map(binding=>{
        const actor=definition.personas.find(actor=>actor.org_id===binding.org_id&&actor.actor_id===binding.actor_id)!;
        return [binding.subject,{org_id:actor.org_id,actor_id:actor.actor_id,kind:actor.kind}] as const;
      }));
      if (subjects.size===0) throw new Error('Selected organization has no login binding');
      const { OidcAuthentication } = await import('../../packages/auth/oidc.ts');
      authentication = await OidcAuthentication.create({issuer:auth.issuer,clientId:auth.client_id,redirectUri:`${origin}/auth/callback`,development:auth.allow_insecure_loopback===true,
        authorizationVersionClaim:auth.authorization_version_claim,
        resolveActor:(issuer,subject)=>new URL(issuer).href===new URL(auth.issuer).href?subjects.get(subject):undefined});
    }
    if (fabric) {
      const { createConfiguredFabricRuntime } = await import('./configured-fabric-runtime.ts');
      const runtime = await createConfiguredFabricRuntime(configuration,{dataDir:options.dataDir,organization:options.organization!,authorizeActor:actor=>authentication!.assertCurrentActor(actor)});
      ledger=runtime.ledger;personas=runtime.personas;
    }
  } catch(error) { await ledger?.close();await authentication?.close();throw error; }
  // createApp takes ownership and closes resources on initialization failure.
  return createApp({dataDir:options.dataDir,definition,ledger,personas,authentication,binding,publicOrigin:configuration.server?.public_origin});
}
