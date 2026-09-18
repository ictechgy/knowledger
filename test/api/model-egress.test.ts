import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { demoFixtures, actorIdentity, PERSONAS, demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { guardedGeneration } from '../../packages/client/guarded-generation.ts';

const fixtures = demoFixtures();
const sales = fixtures.revisions[0];
const actor = actorIdentity(PERSONAS[0]);
const selection = { document_ids: [sales.payload.document_id], context_id: sales.payload.context_id, scope_id: sales.payload.scope_id, usage_scope: sales.payload.usage_scope };

async function fixture(t: any, modelEgress?: any) {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  const service = new KnowledgerService(ledger, vault, demoDefinition(), undefined, modelEgress ? { modelEgress } : {});
  await service.initialize();
  await seedDemo(service);
  t.after(() => { ledger.close(); vault.close(); });
  return { service, ledger, vault };
}

test('resolve embeds the configured egress policy version in the manifest', async t => {
  const f = await fixture(t, { policy_version: 7 });
  const result = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'provided');
  assert.equal(result.manifest.model_egress_policy_version, 7);
});

test('resolve withholds when the model egress policy denies the adapter', async t => {
  const f = await fixture(t, { allows: ({ adapter_id }: any) => adapter_id === 'adapter-allowed' });
  const denied = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-blocked' });
  assert.equal(denied.status, 'withheld');
  assert.equal(denied.reason, 'EGRESS_POLICY_DENIED');
  assert.equal(denied.documents.length, 0);
  const allowed = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-allowed' });
  assert.equal(allowed.status, 'provided');
});

test('revalidate rechecks the current egress policy immediately before release', async t => {
  let permitted = true;
  const f = await fixture(t, { allows: () => permitted });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  const stillValid = await f.service.revalidate(actor, runId, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(stillValid.status, 'valid');
  permitted = false;
  const revoked = await f.service.revalidate(actor, runId, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(revoked.status, 'withheld');
  assert.equal(revoked.reason, 'EGRESS_POLICY_DENIED');
});

test('a throwing egress callback fails closed rather than releasing output', async t => {
  const f = await fixture(t, { allows: () => { throw new Error('policy store down'); } });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_DENIED');
});

test('revalidate stays valid without an adapter id and rejects malformed adapter ids', async t => {
  const f = await fixture(t);
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  assert.equal(resolved.manifest.model_egress_policy_version, 1);
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context' });
  assert.equal(result.status, 'valid');
  await assert.rejects(f.service.resolve(actor, { ...selection, model_adapter_id: 'no' }), (error: any) => error.code === 'INVALID_INPUT');
  await assert.rejects(f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'bad id!' }), (error: any) => error.code === 'INVALID_INPUT');
});

test('guardedGeneration forwards the adapter id to server-side resolve and revalidate', async () => {
  const calls: any[] = [];
  const manifest = {
    contract_type: 'RunContextManifest', contract_version: 1, manifest_id: 'manifest-001', run_id: 'run-001',
    context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1',
    policy_id: 'policy-001', policy_version: 1, membership_epoch: 1,
    checkpoint: { mode: 'strict', checkpoint_id: 'checkpoint-001', channel_id: 'channel-001', block_number: 1, transaction_index: 0, transaction_id: 'a'.repeat(64), block_hash: 'b'.repeat(64), eligibility_epoch: 1 },
    provided_revisions: [{ revision_digest: 'sha256:' + 'a'.repeat(64), purpose: 'scoped_knowledge', reference_kind: 'normative', target_context_id: 'context-main', target_scope_id: 'scope-main', usage_scope: 'reference/v1', agreement_id: 'agreement-001' }],
    approval_decisions: [{ decision_id: 'decision-001', revision_digest: 'sha256:' + 'a'.repeat(64), proposal_id: 'proposal-001' }],
    private_sources: [], retrieval_profile_id: 'retrieval-001', authorization_snapshot_id: 'authz-001', model_egress_policy_version: 1,
  };
  const resolved = { status: 'provided', mode: 'fabric', revision: { revision_digest: 'sha256:' + 'a'.repeat(64), payload: { document_id: 'doc-001', context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' } },
    documents: [{ revision_digest: 'sha256:' + 'a'.repeat(64), title: 'Knowledge', body_markdown: 'approved text', agreement_id: 'agreement-001' }], manifest };
  let block = 1;
  const client = {
    resolve: async (_selection: any, options: any) => { calls.push(['resolve', options]); return resolved; },
    revalidate: async (_runId: string, options: any) => { calls.push(['revalidate', options]); return { status: 'valid', refreshed_manifest: { ...manifest, checkpoint: { ...manifest.checkpoint, block_number: ++block } } }; },
  };
  const result = await guardedGeneration({
    client: client as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-production', authorize: async () => true, generate: async () => 'model output',
  });
  assert.equal(result.status, 'provided');
  assert.deepEqual(calls.map(([name]) => name), ['resolve', 'revalidate', 'revalidate']);
  for (const [, options] of calls) assert.equal(options.modelAdapterId, 'adapter-production');
});
