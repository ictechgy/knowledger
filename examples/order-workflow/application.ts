import { createApp } from '../../apps/api/server.ts';
import type { AppOptions } from '../../apps/api/server.ts';
import type { KnowledgerService } from '../../apps/api/service.ts';
import { demoDefinition, demoFixtures, actorIdentity, PERSONAS, slotFields } from './config.ts';

/** Fictional approvals are confined to this explicitly selected demonstration. */
export async function seedDemo(service: KnowledgerService): Promise<void> {
  if (service.ledger.mode !== 'local-simulation') return;
  const fixtures = demoFixtures();
  for (let index = 0; index < fixtures.revisions.length; index++) {
    const revision = fixtures.revisions[index]; const policy = fixtures.policies[index];
    const actor = actorIdentity(PERSONAS[index === 3 ? 1 : index]);
    const suffix = index === 3 ? 'review-invitation' : ['sales','fulfillment','settlement'][index];
    const submit = async (type: string, input: any) => {
      const result = await service.ledger.execute(actor, {command_id:`seed-${type}-${suffix}`,type,input});
      if (result.status === 'pending') throw new Error('Demo seed remained pending');
    };
    await submit('publish_revision', {revision,publication:{revision_digest:revision.revision_digest,config_version:1,membership_epoch:1}});
    const proposal_id = `proposal-${suffix}-001`;
    await submit('propose', {proposal_id,revision_digest:revision.revision_digest,policy_id:policy.policy_id,policy_version:1});
    if (index === 3) continue;
    const representative = policy.role_representatives.find(rep=>rep.actor_org_id===actor.org_id && rep.actor_id===actor.actor_id)!;
    await submit('decide', {decision:{contract_type:'ApprovalDecision',contract_version:1,decision_id:`decision-${suffix}-001`,revision_digest:revision.revision_digest,
      ...slotFields(revision.payload),policy_id:policy.policy_id,policy_version:1,membership_epoch:1,role_binding_version:1,
      actor_org_id:actor.org_id,actor_id:actor.actor_id,subject_id:revision.payload.document_id,actor_domain_role:representative.domain_role,
      decision:'approve',rationale:'가상 예제: 해당 도메인의 정의를 확인합니다.',decided_at:'2026-09-15T00:00:00Z',proposal_id}});
    await submit('activate', {proposal_id,agreement_id:`agreement-${suffix}-001`,expected_active_agreement_id:null});
  }
}

export async function createDemoApp(options: Omit<AppOptions, 'definition'> & {seed?:boolean;definition?:AppOptions['definition']}) {
  const { seed = true, definition = demoDefinition(), ...rest } = options;
  const app = await createApp({...rest,definition});
  try { if (seed) await seedDemo(app.service); return app; }
  catch (error) { await app.close(); throw error; }
}
