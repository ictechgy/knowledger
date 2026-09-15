import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalize, validateConfig } from '../domain/index.ts';
import { parseStrictJson } from '../fabric/canonical.ts';
import type { ApplicationDefinition, ProjectConfiguration, NamedValue, FabricIdentityConfiguration, AuthenticationConfiguration } from './types.ts';

const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const USAGE = /^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/;
const MAX_BYTES = 1024 * 1024;
const pair = (value: {org_id:string;actor_id:string}) => JSON.stringify([value.org_id, value.actor_id]);
export class ConfigurationError extends Error {
  readonly code = 'INVALID_CONFIGURATION';
}
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ConfigurationError(message);
}
function record(value: unknown, keys: string[], optional: string[] = []): Record<string, any> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Configuration requires JSON objects');
  const result = value as Record<string, any>;
  requireValue(keys.every(key => Object.hasOwn(result, key)) && Object.keys(result).every(key => keys.includes(key) || optional.includes(key)), 'Configuration contains missing or unknown fields');
  return result;
}
function array(value: unknown, maximum = 512): any[] {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= maximum, 'Configuration requires a bounded nonempty list');
  return value;
}
function text(value: unknown, maximum = 200): string {
  requireValue(typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value), 'Configuration requires valid text');
  return value;
}
function id(value: unknown): string { requireValue(typeof value === 'string' && ID.test(value), 'Configuration requires valid identifiers'); return value; }
function unique(values: string[], message: string): void { requireValue(new Set(values).size === values.length, message); }
function named(value: unknown, pattern = ID): NamedValue[] {
  const items = array(value).map(value => { const item = record(value, ['id', 'label']); requireValue(typeof item.id === 'string' && pattern.test(item.id), 'Workspace metadata contains an invalid identifier'); return { id:item.id, label:text(item.label) }; });
  unique(items.map(item => item.id), 'Workspace metadata has duplicate identifiers'); return items;
}
function endpoint(value: unknown, originOnly = false): string {
  let url: URL;
  try { url = new URL(text(value, 2048)); } catch { throw new ConfigurationError('Configuration contains an invalid URL'); }
  requireValue(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Only credential-free HTTP(S) endpoints are supported');
  if (originOnly) requireValue(url.pathname === '/', 'The public origin cannot contain a path');
  return originOnly ? url.origin : url.href.replace(/\/$/, '');
}
function loopback(value: string): boolean { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { for (const nested of Object.values(value)) deepFreeze(nested); Object.freeze(value); } return value; }

/** Pure validation; initial identity/policy authority is separate from connection and display settings. */
export function validateProjectConfiguration(input: unknown): ProjectConfiguration {
  let value: Record<string, any>;
  try {
    const source = canonicalize(input);
    requireValue(Buffer.byteLength(source) <= MAX_BYTES, 'Configuration exceeds 1 MiB');
    value = record(JSON.parse(source), ['version','workspace','organizations','identities','genesis','bootstrap_actor','ledger','authentication'], ['server','fabric']);
  } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ConfigurationError('Configuration must be bounded JSON'); }
  requireValue(value.version === 1, 'Unsupported configuration version');
  let genesis;
  try { genesis = validateConfig(value.genesis); } catch { throw new ConfigurationError('Initial ledger policy or identity configuration is invalid'); }
  const ledger = record(value.ledger, ['mode','channel_id']);
  requireValue(['local-simulation','fabric'].includes(ledger.mode), 'Unknown ledger mode');
  requireValue(ledger.channel_id === genesis.channel_id, 'Ledger channel must match the initial policy configuration');
  const rawWorkspace = record(value.workspace, ['id','label','contexts','usage_scopes','roles']);
  const workspace = { id:id(rawWorkspace.id), label:text(rawWorkspace.label), contexts:named(rawWorkspace.contexts), usage_scopes:named(rawWorkspace.usage_scopes, USAGE), roles:named(rawWorkspace.roles) };
  const organizations = array(value.organizations, 128).map(value => { const item = record(value, ['org_id','label']); return { org_id:id(item.org_id), label:text(item.label) }; });
  unique(organizations.map(item => item.org_id), 'Organizations must have distinct identifiers');
  const identities = array(value.identities, 1024).map(value => {
    const item = record(value, ['org_id','actor_id','kind','label']);
    requireValue(item.kind === 'human' || item.kind === 'agent', 'Identity kind must be human or agent');
    return { org_id:id(item.org_id), actor_id:id(item.actor_id), kind:item.kind as 'human'|'agent', label:text(item.label) };
  });
  unique(identities.map(pair), 'Identity organization/actor pairs must be unique');
  requireValue(identities.length === genesis.identities.length && identities.every(item => genesis.identities.some(candidate => pair(candidate) === pair(item) && candidate.kind === item.kind)), 'Display identities must match the initial authority registry');
  const usedOrganizations = new Set(genesis.identities.map(item => item.org_id));
  requireValue(organizations.length === usedOrganizations.size && organizations.every(item => usedOrganizations.has(item.org_id)), 'Organization registry must match the configured identities');
  const bootstrap = record(value.bootstrap_actor, ['org_id','actor_id','kind']);
  requireValue(bootstrap.kind === 'human' && genesis.identities.some(item => item.kind === 'human' && item.org_id === bootstrap.org_id && item.actor_id === bootstrap.actor_id), 'Bootstrap actor must be a registered human');
  requireValue(genesis.policies.every(policy => workspace.contexts.some(item => item.id === policy.context_id)
    && workspace.usage_scopes.some(item => item.id === policy.usage_scope) && policy.required_domain_roles.every(role => workspace.roles.some(item => item.id === role))), 'Policy context, usage and roles must be declared in workspace metadata');
  requireValue(genesis.identities.every(actor => actor.publish_contexts.every(context => context === '*' || workspace.contexts.some(item => item.id === context))), 'Publish contexts must be declared in workspace metadata');
  let server: ProjectConfiguration['server'];
  if (value.server !== undefined) {
    const input = record(value.server, ['public_origin']);
    const public_origin = endpoint(input.public_origin, true);
    requireValue(public_origin.startsWith('https:') || loopback(public_origin), 'Public HTTP origins are restricted to loopback');
    server = { public_origin };
  }
  let authentication: AuthenticationConfiguration;
  if (value.authentication?.mode === 'local-development') {
    record(value.authentication, ['mode']);
    requireValue(ledger.mode === 'local-simulation', 'Fabric requires OIDC authentication');
    requireValue(!server || loopback(server.public_origin), 'Development account switching is restricted to loopback');
    authentication = { mode:'local-development' };
  } else {
    const auth = record(value.authentication, ['mode','issuer','client_id','bindings'], ['allow_insecure_loopback','authorization_version_claim']);
    requireValue(auth.mode === 'oidc', 'Unknown authentication mode');
    const issuer = endpoint(auth.issuer);
    requireValue(auth.allow_insecure_loopback === undefined || typeof auth.allow_insecure_loopback === 'boolean', 'Invalid loopback authentication option');
    if (issuer.startsWith('http:')) requireValue(auth.allow_insecure_loopback === true && loopback(issuer), 'OIDC requires HTTPS except explicit loopback development');
    if (auth.allow_insecure_loopback) requireValue(loopback(issuer) && (!server || loopback(server.public_origin)), 'Insecure OIDC is limited to loopback endpoints');
    const bindings = array(auth.bindings).map(value => {
      const item = record(value, ['subject','org_id','actor_id']);
      const result = { subject:text(item.subject,255), org_id:id(item.org_id), actor_id:id(item.actor_id) };
      requireValue(genesis.identities.some(actor => pair(actor) === pair(result) && actor.kind === 'human'), 'OIDC subjects may bind only to registered human identities');
      return result;
    });
    unique(bindings.map(item => item.subject), 'An OIDC subject cannot select multiple actors');
    unique(bindings.map(pair), 'An actor cannot have ambiguous OIDC subject bindings');
    authentication = { mode:'oidc', issuer, client_id:text(auth.client_id,128), bindings,
      ...(auth.allow_insecure_loopback === undefined ? {} : {allow_insecure_loopback:auth.allow_insecure_loopback}),
      ...(auth.authorization_version_claim === undefined ? {} : {authorization_version_claim:id(auth.authorization_version_claim)}) };
  }
  let fabric: ProjectConfiguration['fabric'];
  if (ledger.mode === 'fabric') {
    const input = record(value.fabric, ['chaincode_name','chaincode_version','identities']);
    const routes: FabricIdentityConfiguration[] = array(input.identities, 126).map(value => {
      const item = record(value, ['org_id','actor_id','certificate_path','tls_ca_path','peer_endpoint','peer_host_alias','key_id','signer_socket_path']);
      const org_id = id(item.org_id); const actor_id = id(item.actor_id);
      requireValue(genesis.identities.some(actor => actor.org_id === org_id && actor.actor_id === actor_id), 'Fabric identity must be registered');
      const peer_endpoint = text(item.peer_endpoint, 300);
      let peer: URL;
      try { peer = new URL(`grpcs://${peer_endpoint}`); } catch { throw new ConfigurationError('Invalid Fabric peer endpoint'); }
      requireValue(peer.hostname && peer.port && Number(peer.port) >= 1 && Number(peer.port) <= 65535 && !peer.username && !peer.password && !peer.pathname && !peer.search && !peer.hash, 'Fabric endpoint must be a host and port');
      const key_id = text(item.key_id, 128); requireValue(/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(key_id), 'Invalid signer key reference');
      return { org_id, actor_id, certificate_path:text(item.certificate_path,4096), tls_ca_path:text(item.tls_ca_path,4096), signer_socket_path:text(item.signer_socket_path,4096), peer_endpoint, peer_host_alias:text(item.peer_host_alias,255), key_id };
    });
    unique(routes.map(pair), 'Fabric routes must be unique for each actor');
    requireValue(organizations.every(org => routes.some(route => route.org_id === org.org_id)), 'Every organization needs a Fabric route');
    if (authentication.mode === 'oidc') requireValue(authentication.bindings.every(binding => routes.some(route => pair(route) === pair(binding))), 'Every OIDC-bound actor needs a Fabric route');
    fabric = { chaincode_name:id(input.chaincode_name), chaincode_version:text(input.chaincode_version,64), identities:routes };
  } else requireValue(value.fabric === undefined, 'Local simulation must not contain unused Fabric credentials');
  return deepFreeze({ version:1, workspace, organizations, identities, genesis,
    bootstrap_actor:{org_id:bootstrap.org_id,actor_id:bootstrap.actor_id,kind:'human'},
    ledger:{mode:ledger.mode,channel_id:genesis.channel_id}, authentication, ...(server ? {server} : {}), ...(fabric ? {fabric} : {}) });
}

/** Explicit project JSON only; connection references are resolved without reading their target files. */
export function loadProjectConfiguration(path: string): ProjectConfiguration {
  let fd: number | undefined;
  try {
    const absolute = resolve(path); const stat = lstatSync(absolute);
    requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'Configuration must be a regular file of at most 1 MiB');
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd); requireValue(opened.dev === stat.dev && opened.ino === stat.ino && opened.size <= MAX_BYTES, 'Configuration changed while opening');
    const bytes = readFileSync(fd); requireValue(bytes.length <= MAX_BYTES, 'Configuration exceeds 1 MiB');
    const config = structuredClone(validateProjectConfiguration(parseStrictJson(bytes)));
    for (const identity of config.fabric?.identities ?? []) {
      identity.certificate_path = resolve(dirname(absolute), identity.certificate_path);
      identity.tls_ca_path = resolve(dirname(absolute), identity.tls_ca_path);
      identity.signer_socket_path = resolve(dirname(absolute), identity.signer_socket_path);
    }
    return deepFreeze(config);
  } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ConfigurationError('Cannot read a valid project configuration'); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function applicationDefinition(configuration: ProjectConfiguration): ApplicationDefinition {
  return { workspace:configuration.workspace, organizations:configuration.organizations, genesis:configuration.genesis,
    bootstrap_actor:configuration.bootstrap_actor, demo:false,
    personas:configuration.genesis.identities.map(actor => ({...actor,label:configuration.identities.find(item => pair(item) === pair(actor))!.label})) };
}
export function configurationAuthorityDigest(configuration: ProjectConfiguration): string {
  return `sha256:${createHash('sha256').update(canonicalize({ workspace_id:configuration.workspace.id, genesis:configuration.genesis,
    bootstrap_actor:configuration.bootstrap_actor, ledger:configuration.ledger, authentication:configuration.authentication })).digest('hex')}`;
}
