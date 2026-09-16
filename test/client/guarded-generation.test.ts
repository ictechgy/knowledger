import test from 'node:test';
import assert from 'node:assert/strict';
import { guardedGeneration } from '../../packages/client/guarded-generation.ts';

function resolved() {
  const revision = { revision_digest: 'sha256:' + 'a'.repeat(64), payload: { document_id: 'doc-001', context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' } };
  return {
    status: 'provided' as const, mode: 'fabric' as const,
    documents: [{ revision_digest: 'sha256:' + 'a'.repeat(64), title: 'Knowledge', body_markdown: 'approved text', agreement_id: 'agreement-001' }],
    manifest: {
      contract_type: 'RunContextManifest', contract_version: 1, manifest_id:'manifest-001',retrieval_profile_id:'retrieval-001',authorization_snapshot_id:'authz-001',approval_decisions:[{decision_id:'decision-001',revision_digest:'sha256:'+'a'.repeat(64),proposal_id:'proposal-001'}], run_id: 'run-001', context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1',
      policy_id: 'policy-001', policy_version: 1, membership_epoch: 1, private_sources: [], model_egress_policy_version: 1,
      checkpoint: { mode: 'strict', channel_id: 'channel-001',checkpoint_id:'checkpoint-001',block_number:1,transaction_index:0,transaction_id:'a'.repeat(64),block_hash:'b'.repeat(64),eligibility_epoch:1 },
      provided_revisions: [{ revision_digest: 'sha256:' + 'a'.repeat(64), reference_kind: 'normative', agreement_id: 'agreement-001',purpose:'scoped_knowledge',target_context_id:'context-main',target_scope_id:'scope-main',usage_scope:'reference/v1' }],
    }, revision,
  };
}

test('guarded generation requires authorization before model callback and returns no output when denied', async () => {
  let generated = false;
  const result = await guardedGeneration({
    client: { resolve: async () => resolved(), revalidate: async () => ({ status: 'valid', refreshed_manifest: resolved().manifest }) } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', authorize: async ({ phase }) => phase === 'release',
    generate: async () => { generated = true; return 'model output'; },
  });
  assert.equal(result.status, 'withheld');
  assert.equal('output' in result, false);
  assert.equal(generated, false);
});

test('guarded generation revalidates before generation and release, and drops output after revocation', async () => {
  const phases: string[] = [];
  let revalidations = 0;
  const result = await guardedGeneration({
    client: { resolve: async () => resolved(), revalidate: async () => { revalidations++; return revalidations === 1 ? { status: 'valid', refreshed_manifest: {...resolved().manifest,checkpoint:{...resolved().manifest.checkpoint,block_number:2}} } : { status: 'withheld', reason: 'KNOWLEDGE_CHANGED' }; } } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', authorize: async ({ phase }) => { phases.push(phase); return true; },
    generate: async () => 'must not escape',
  });
  assert.equal(result.status, 'withheld');
  assert.equal('output' in result, false);
  assert.deepEqual(phases, ['generate', 'release']);
  assert.equal(revalidations, 2);
});

test('guarded generation fails closed on missing authorization and aborted generation', async () => {
  await assert.rejects(() => guardedGeneration({
    client: { resolve: async () => resolved(), revalidate: async () => ({ status: 'valid' }) } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', generate: async () => 'output',
  } as any), /authorize/i);
  const controller = new AbortController();
  const resultPromise = guardedGeneration({
    client: { resolve: async () => resolved(), revalidate: async () => ({ status: 'valid' }) } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', authorize: async () => true, signal: controller.signal,
    generate: async () => await new Promise<string>(resolve => setTimeout(() => resolve('late output'), 100)),
  });
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.status, 'withheld');
  assert.equal('output' in result, false);
});

test('guarded generation applies an overall deadline and does not call a pre-aborted client', async () => {
  const timed = await guardedGeneration({
    client: { resolve: async () => await new Promise<any>(() => undefined), revalidate: async () => ({ status: 'valid' }) } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', timeoutMs: 10, authorize: async () => true, generate: async () => 'late',
  });
  assert.deepEqual(timed, { status: 'withheld', reason: 'TIMEOUT' });
  const controller = new AbortController(); controller.abort(); let resolveCalls = 0;
  const aborted = await guardedGeneration({
    client: { resolve: async () => { resolveCalls++; return resolved(); }, revalidate: async () => ({ status: 'valid', refreshed_manifest: resolved().manifest }) } as any,
    selection: { document_ids: ['doc-001'], context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1' },
    adapterId: 'adapter-test', authorize: async () => true, generate: async () => 'output', signal: controller.signal,
  });
  assert.deepEqual(aborted, { status: 'withheld', reason: 'GENERATION_CANCELLED' });
  assert.equal(resolveCalls, 0);
});
