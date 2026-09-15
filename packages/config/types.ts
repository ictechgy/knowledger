import type { Actor, ConfigIdentity, DomainConfig, Slot } from '../domain/index.ts';

export interface NamedValue { id: string; label: string }
export interface WorkspacePresentation {
  id: string;
  label: string;
  contexts: NamedValue[];
  usage_scopes: NamedValue[];
  roles: NamedValue[];
}
export interface OrganizationPresentation { org_id: string; label: string }
export interface IdentityPresentation extends Actor { label: string }
export interface Persona extends ConfigIdentity { label: string }
export interface SubjectBinding { subject: string; org_id: string; actor_id: string }
export type AuthenticationConfiguration = { mode: 'local-development' } | {
  mode: 'oidc'; issuer: string; client_id: string; bindings: SubjectBinding[];
  allow_insecure_loopback?: boolean; authorization_version_claim?: string;
};
export interface FabricIdentityConfiguration {
  org_id: string;
  actor_id: string;
  certificate_path: string;
  tls_ca_path: string;
  peer_endpoint: string;
  peer_host_alias: string;
  key_id: string;
  signer_socket_path: string;
}
export interface ProjectConfiguration {
  version: 1;
  workspace: WorkspacePresentation;
  organizations: OrganizationPresentation[];
  identities: IdentityPresentation[];
  genesis: DomainConfig;
  bootstrap_actor: Actor;
  ledger: { mode: 'local-simulation' | 'fabric'; channel_id: string };
  authentication: AuthenticationConfiguration;
  server?: { public_origin: string };
  fabric?: { chaincode_name: string; chaincode_version: string; identities: FabricIdentityConfiguration[] };
}
export interface ApplicationDefinition {
  workspace: WorkspacePresentation;
  organizations: OrganizationPresentation[];
  personas: Persona[];
  genesis: DomainConfig;
  bootstrap_actor: Actor;
  demo: boolean;
  default_actor?: Actor;
}
export const actorIdentity = (identity: Actor): Actor => ({ org_id: identity.org_id, actor_id: identity.actor_id, kind: identity.kind });
export const slotFields = (payload: Slot): Slot => ({ channel_id: payload.channel_id, document_id: payload.document_id, context_id: payload.context_id, scope_id: payload.scope_id, usage_scope: payload.usage_scope });
