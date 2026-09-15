import type { ProjectConfiguration } from './types.ts';

/** Starter values are editable configuration, never a runtime organization registry. */
export function createProjectTemplate(organizationIds = ['OrgOneMSP', 'OrgTwoMSP'], workspaceId = 'knowledge'): ProjectConfiguration {
  if (organizationIds.length < 1 || organizationIds.length > 32 || new Set(organizationIds).size !== organizationIds.length
    || !organizationIds.every(id => /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/.test(id)) || !/^[A-Za-z][A-Za-z0-9._:-]{2,48}$/.test(workspaceId)) throw new Error('Use one to 32 distinct organization IDs and a valid workspace ID');
  const identities = organizationIds.map((org_id, index) => ({ org_id, actor_id: 'maintainer', kind: 'human' as const, label: `Organization ${index + 1} maintainer` }));
  const channel_id = `${workspaceId}-channel`;
  const roles = organizationIds.map((_, index) => ({ id: `reviewer-${index + 1}`, label: `Organization ${index + 1} reviewer` }));
  return {
    version: 1,
    workspace: { id: workspaceId, label: 'Knowledge workspace', contexts: [{ id: 'context-shared', label: 'Shared knowledge' }], usage_scopes: [{ id: 'reference/v1', label: 'Reference knowledge' }], roles },
    organizations: organizationIds.map((org_id, index) => ({ org_id, label: `Organization ${index + 1}` })),
    identities,
    genesis: { channel_id, config_version: 1, membership_epoch: 1, role_binding_version: 1, serving_enabled: true,
      identities: identities.map(({ label, ...actor }) => ({ ...actor, publish_contexts: ['context-shared'], can_propose: true })),
      policies: [{ contract_type: 'AgreementPolicy', contract_version: 1, policy_id: 'policy-shared-guideline', policy_version: 1,
        channel_id, document_id: 'doc-shared-guideline', context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1',
        membership_epoch: 1, role_binding_version: 1, acceptance_slot: 'shared-guideline',
        required_domain_roles: roles.map(role => role.id), allowed_decisions: ['approve', 'object', 'abstain', 'retract'], role_decision_rule: 'named_representatives',
        role_representatives: identities.map((actor, index) => ({ domain_role: roles[index].id, actor_org_id: actor.org_id, actor_id: actor.actor_id })) }],
    },
    bootstrap_actor: { org_id: identities[0].org_id, actor_id: identities[0].actor_id, kind: 'human' },
    ledger: { mode: 'local-simulation', channel_id },
    authentication: { mode: 'local-development' },
  };
}
