import assert from 'node:assert/strict';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { actorIdentity, PERSONAS } from '../examples/order-workflow/config.ts';
import { demoDefinition } from '../examples/order-workflow/config.ts';
import { seedDemo } from '../examples/order-workflow/application.ts';

const ledger = new LocalLedger(':memory:', 'kcl-demo');
const vault = new PrivateStore(':memory:');
const service = new KnowledgerService(ledger, vault, demoDefinition());
const fulfillment = actorIdentity(PERSONAS[1]);
const settlement = actorIdentity(PERSONAS[2]);
const scope = { document_ids: ['doc-review-invitation-001'], context_id: 'context-coordination', scope_id: 'scope-order-2026-001', usage_scope: 'review-invitation/v1' };
try {
  await service.initialize();
  await seedDemo(service);
  const before = await service.resolve(fulfillment, scope);
  assert.equal(before.status, 'withheld');
  for (const [index, actor] of [fulfillment, settlement].entries()) {
    await service.decide(actor, 'proposal-review-invitation-001', { command_id: `cmd-demo-approval-${index}`, decision: 'approve', rationale: 'Fictional domain owner reviewed the complete document.' });
  }
  await service.activate(fulfillment, 'proposal-review-invitation-001', { command_id: 'cmd-demo-activate', expected_active_agreement_id: null });
  const provided = await service.resolve(fulfillment, scope);
  assert.equal(provided.status, 'provided');
  await service.changeAgreement(settlement, 'agreement-settlement-001', 'withdraw', { command_id: 'cmd-demo-withdraw', reason: 'The settlement definition needs review.' });
  const after = await service.revalidate(fulfillment, provided.manifest!.run_id, { action: 'use-context' });
  assert.equal(after.status, 'withheld');
  const events = ledger.events(0, 1000);
  const bodyStored = events.some(event => event.writes.some(([key, value]) => key.startsWith('kcl:v1:revision:') && value.payload.body_markdown === provided.documents[0].body_markdown));
  assert.equal(bodyStored, true);
  console.log(JSON.stringify({ mode: 'local-simulation', before_approval: before.status, after_two_approvals: provided.status, after_dependency_withdrawal: after.status, body_in_shared_journal: bodyStored, transactions: events.length }, null, 2));
} finally { ledger.close(); vault.close(); }
