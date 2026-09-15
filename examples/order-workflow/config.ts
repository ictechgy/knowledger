import { readFileSync } from 'node:fs';
import { digestPayload, validateConfig } from '../../packages/domain/index.ts';
import type { ApplicationDefinition } from '../../packages/config/types.ts';

export const CHANNEL_ID = 'kcl-demo';
export const PERSONAS = [
  { org_id: 'SalesMSP', actor_id: 'person-sales-owner', kind: 'human' as const, label: '영업 책임자', publish_contexts: ['context-sales'], can_propose: true },
  { org_id: 'FulfillmentMSP', actor_id: 'person-fulfillment-owner', kind: 'human' as const, label: '물류 책임자', publish_contexts: ['context-fulfillment', 'context-coordination'], can_propose: true },
  { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner', kind: 'human' as const, label: '정산 책임자', publish_contexts: ['context-settlement', 'context-coordination'], can_propose: true },
  { org_id: 'FulfillmentMSP', actor_id: 'agent-knowledge-drafter', kind: 'agent' as const, label: 'AI 초안 작성자', publish_contexts: ['context-coordination'], can_propose: true },
];
export const actorIdentity = (persona: typeof PERSONAS[number]) => ({ org_id: persona.org_id, actor_id: persona.actor_id, kind: persona.kind });
export const BOOTSTRAP_ACTOR = actorIdentity(PERSONAS[1]);
const source = (name: string) => JSON.parse(readFileSync(new URL(`../${name}.json`, import.meta.url), 'utf8'));
const slotFields = (payload: any) => ({ channel_id: payload.channel_id, document_id: payload.document_id, context_id: payload.context_id, scope_id: payload.scope_id, usage_scope: payload.usage_scope });

function wrap(payload: any) { return { revision_digest: digestPayload(payload), payload }; }

export function demoFixtures() {
  const names = ['sales', 'fulfillment', 'settlement', 'review_invitation'];
  const revisions = names.map((name, index) => {
    const payload = source(`document_revision_${name}`).payload;
    payload.channel_id = CHANNEL_ID;
    const persona = PERSONAS[index === 3 ? 1 : index];
    payload.metadata.author_id = persona.actor_id;
    payload.metadata.author_org_id = persona.org_id;
    payload.metadata.source_kind = index === 3 ? 'llm_drafted' : 'human_authored';
    payload.metadata.created_at = '2026-09-15T00:00:00Z';
    return wrap(payload);
  });
  revisions[3].payload.dependencies = revisions[3].payload.dependencies.map((dep: any, index: number) => ({ ...dep, channel_id: CHANNEL_ID, revision_digest: revisions[index].revision_digest }));
  revisions[3] = wrap(revisions[3].payload);
  const roles = ['sales_owner', 'fulfillment_owner', 'settlement_owner'];
  const policies = revisions.map((revision, index) => {
    const representativeIndices = index === 3 ? [1, 2] : [index];
    return {
      contract_type: 'AgreementPolicy', contract_version: 1,
      policy_id: `policy-${index === 3 ? 'review-invitation' : names[index]}-v1`, policy_version: 1,
      ...slotFields(revision.payload), membership_epoch: 1, role_binding_version: 1,
      acceptance_slot: index === 3 ? 'review_after_delivery' : `${names[index]}_definition`,
      required_domain_roles: representativeIndices.map(i => roles[i]),
      allowed_decisions: ['approve', 'object', 'abstain', 'retract'], role_decision_rule: 'named_representatives',
      role_representatives: representativeIndices.map(i => ({ domain_role: roles[i], actor_org_id: PERSONAS[i].org_id, actor_id: PERSONAS[i].actor_id })),
    };
  });
  const config = {
    channel_id: CHANNEL_ID, membership_epoch: 1, role_binding_version: 1,
    config_version: 1, serving_enabled: true,
    identities: PERSONAS.map(({ label, ...identity }) => identity), policies,
  };
  return { config, revisions, policies };
}

export { slotFields };

export function demoDefinition(): ApplicationDefinition {
  const fixtures = demoFixtures();
  const contextLabels: Record<string,string> = { 'context-sales':'영업 · 계약', 'context-fulfillment':'이행 · 배송', 'context-settlement':'정산 · 수납', 'context-coordination':'교차 도메인 합의' };
  const roleLabels: Record<string,string> = { sales_owner:'영업 책임자', fulfillment_owner:'이행 책임자', settlement_owner:'정산 책임자' };
  return { demo:true, workspace:{ id:'demo', label:'Order workflow demo',
    contexts:Object.entries(contextLabels).map(([id,label])=>({id,label})),
    usage_scopes:[...new Set(fixtures.policies.map(policy=>policy.usage_scope))].map(id=>({id,label:id})),
    roles:Object.entries(roleLabels).map(([id,label])=>({id,label})) },
    organizations:[...new Set(PERSONAS.map(persona=>persona.org_id))].map(org_id=>({org_id,label:org_id})),
    personas:PERSONAS.map(persona=>({...persona})), genesis:validateConfig(fixtures.config), bootstrap_actor:BOOTSTRAP_ACTOR, default_actor:BOOTSTRAP_ACTOR };
}
