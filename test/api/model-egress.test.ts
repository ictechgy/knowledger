import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService, ModelEgressTimeoutError } from '../../apps/api/service.ts';
import type { ModelEgressPolicy } from '../../apps/api/service.ts';
import { demoFixtures, actorIdentity, PERSONAS, demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { guardedGeneration } from '../../packages/client/guarded-generation.ts';

const fixtures = demoFixtures();
const sales = fixtures.revisions[0];
const actor = actorIdentity(PERSONAS[0]);
const selection = { document_ids: [sales.payload.document_id], context_id: sales.payload.context_id, scope_id: sales.payload.scope_id, usage_scope: sales.payload.usage_scope };

async function fixture(t: any, modelEgress?: ModelEgressPolicy) {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  // 의도적으로 던지는 allows 테스트의 stderr 노이즈를 막는다 — 기본 console.error 경로는 별도 테스트가 덮는다.
  const policy = modelEgress ? { onError: () => {}, ...modelEgress } : undefined;
  const service = new KnowledgerService(ledger, vault, demoDefinition(), undefined, policy ? { modelEgress: policy } : {});
  await service.initialize();
  await seedDemo(service);
  t.after(() => { ledger.close(); vault.close(); });
  return { service, ledger, vault };
}

/** 저장된 run 기록을 공개 API 없이 직접 변조한다 — 영향 행 수를 단언해 스키마 드리프트 시 조용히 무력화되지 않게 한다. */
function tamperStoredRun(vault: PrivateStore, runId: string, mutate: (run: any) => void) {
  const run = vault.get('run', runId, actor);
  mutate(run);
  const info = (vault as any).db.prepare("UPDATE private_records SET value_json = ? WHERE kind = 'run' AND record_id = ? AND org_id = ? AND actor_id = ?")
    .run(JSON.stringify(run), runId, actor.org_id, actor.actor_id);
  assert.equal(info.changes, 1);
}

test('resolve embeds the configured egress policy version in the manifest', async t => {
  const f = await fixture(t, { policy_version: 7, allows: () => true });
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

test('a throwing egress callback fails closed as a policy unavailability, not a denial', async t => {
  const f = await fixture(t, { allows: () => { throw new Error('policy store down'); } });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_UNAVAILABLE');
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

test('revalidate rejects a different or missing adapter for an adapter-bound run', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-a' });
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  const other = await f.service.revalidate(actor, runId, { action: 'use-context', model_adapter_id: 'adapter-b' });
  assert.equal(other.status, 'withheld');
  assert.equal(other.reason, 'EGRESS_ADAPTER_MISMATCH');
  const missing = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(missing.status, 'withheld');
  assert.equal(missing.reason, 'EGRESS_ADAPTER_MISMATCH');
});

test('revalidate rejects binding an adapter to a run issued without one', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  const bound = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-late' });
  assert.equal(bound.status, 'withheld');
  assert.equal(bound.reason, 'EGRESS_ADAPTER_MISMATCH');
});

test('an adapter request is denied when no egress policy hook is configured', async t => {
  const f = await fixture(t);
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_DENIED');
});

test('revalidate reports a throwing egress callback as policy unavailability', async t => {
  let fail = false;
  const f = await fixture(t, { allows: () => { if (fail) throw new Error('policy store down'); return true; } });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  fail = true;
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'EGRESS_POLICY_UNAVAILABLE');
});

test('a truthy non-boolean egress verdict is still denied', async t => {
  const f = await fixture(t, { allows: () => 'yes' });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_DENIED');
});

test('a tampered stored manifest binding field is detected at revalidation', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  tamperStoredRun(f.vault, runId, run => { run.manifest.model_egress_policy_version += 1; });
  const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
});

test('invalid egress policy versions are rejected at construction', async t => {
  for (const version of [0, -1, 1.5, Number.NaN]) {
    const ledger = new LocalLedger(':memory:', 'kcl-demo');
    const vault = new PrivateStore(':memory:');
    assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { modelEgress: { policy_version: version } }), TypeError);
    ledger.close(); vault.close();
  }
});

test('invalid egress hook shapes and timeouts are rejected at construction', async t => {
  for (const modelEgress of [{ timeout_ms: 0 }, { timeout_ms: -1 }, { timeout_ms: 1.5 }, { timeout_ms: Number.NaN }, { timeout_ms: 2_147_483_648 }, { allows: 'yes' }, { onError: 'log' }]) {
    const ledger = new LocalLedger(':memory:', 'kcl-demo');
    const vault = new PrivateStore(':memory:');
    assert.throws(() => new KnowledgerService(ledger, vault, demoDefinition(), undefined, { modelEgress: modelEgress as any }), TypeError);
    ledger.close(); vault.close();
  }
});

test('a throwing egress hook reports the error to the diagnostic callback', async t => {
  const errors: unknown[] = [];
  const cause = new Error('policy store down');
  const f = await fixture(t, { allows: () => { throw cause; }, onError: (error: unknown) => errors.push(error) });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.reason, 'EGRESS_POLICY_UNAVAILABLE');
  assert.deepEqual(errors, [cause]);
});

test('a hanging egress hook times out as policy unavailability', async t => {
  const errors: unknown[] = [];
  const f = await fixture(t, { timeout_ms: 5, allows: () => new Promise(() => {}), onError: (error: unknown) => errors.push(error) });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_UNAVAILABLE');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ModelEgressTimeoutError);
});

test('an asynchronous false egress verdict is denied at resolve and revalidate', async t => {
  let verdict: unknown = false;
  const f = await fixture(t, { allows: async () => verdict });
  const denied = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(denied.status, 'withheld');
  assert.equal(denied.reason, 'EGRESS_POLICY_DENIED');
  verdict = true;
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  verdict = false;
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'EGRESS_POLICY_DENIED');
});

test('a truthy non-boolean egress verdict is denied at revalidation too', async t => {
  let verdict: unknown = true;
  const f = await fixture(t, { allows: () => verdict });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  verdict = 1;
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'EGRESS_POLICY_DENIED');
});

test('the egress hook receives isolated copies that cannot mutate server state', async t => {
  let seen: any;
  const f = await fixture(t, { allows: (input: any) => { seen = input; input.manifest.policy_id = 'tampered'; input.actor.actor_id = 'tampered'; return true; } });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  assert.notEqual(seen.manifest, resolved.manifest);
  assert.notEqual(resolved.manifest.policy_id, 'tampered');
  assert.equal(actor.actor_id, PERSONAS[0].actor_id);
  assert.ok(seen.signal instanceof AbortSignal);
  assert.equal(seen.signal.aborted, false);
});

test('a missing binding field in the stored run record is treated as tampering', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  tamperStoredRun(f.vault, runId, run => { delete run.manifest.policy_id; });
  const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
});

test('a throwing diagnostic callback does not change the fail-closed verdict', async t => {
  const f = await fixture(t, { allows: () => { throw new Error('policy store down'); }, onError: () => { throw new Error('sink broken'); } });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_UNAVAILABLE');
});

test('a hanging egress hook times out at revalidation too', async t => {
  let hang = false;
  const errors: unknown[] = [];
  const f = await fixture(t, { timeout_ms: 5, allows: () => hang ? new Promise(() => {}) : true, onError: (error: unknown) => errors.push(error) });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  hang = true;
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'EGRESS_POLICY_UNAVAILABLE');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ModelEgressTimeoutError);
});

test('a denied resolve does not persist a run record and revalidation mints none', async t => {
  const f = await fixture(t, { allows: ({ adapter_id }: any) => adapter_id === 'adapter-allowed' });
  const runCount = () => (f.vault as any).db.prepare("SELECT COUNT(*) AS c FROM private_records WHERE kind = 'run'").get().c;
  const denied = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-blocked' });
  assert.equal(denied.status, 'withheld');
  assert.equal(runCount(), 0);
  const allowed = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-allowed' });
  assert.equal(allowed.status, 'provided');
  assert.equal(runCount(), 1);
  const result = await f.service.revalidate(actor, allowed.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-allowed' });
  assert.equal(result.status, 'valid');
  assert.equal(runCount(), 1);
});

test('deleting the adapter key from an adapter-bound run is tampering, not unbinding', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  tamperStoredRun(f.vault, runId, run => { delete run.model_adapter_id; });
  const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
});

test('an unbound run stores the adapter sentinel so key absence is detectable', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  const run = f.vault.get('run', resolved.manifest.run_id, actor);
  assert.equal(run.model_adapter_id, null);
});

test('the egress hook is invoked detached so the service instance cannot leak as this', async t => {
  let receiver: unknown = 'unset';
  const f = await fixture(t, { allows: function (this: any) { receiver = this; return true; } as any });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  assert.equal(receiver, undefined);
});

test('the latest refreshed manifest is persisted on the run record', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'valid');
  const run = f.vault.get('run', resolved.manifest.run_id, actor);
  assert.equal(run.manifest.manifest_id, resolved.manifest.manifest_id);
  assert.equal(run.last_refreshed_manifest.manifest_id, result.refreshed_manifest.manifest_id);
  assert.notEqual(run.last_refreshed_manifest.manifest_id, resolved.manifest.manifest_id);
});

test('a tampered stored approval decision binding is detected at revalidation', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, selection);
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  tamperStoredRun(f.vault, runId, run => { run.manifest.approval_decisions = run.manifest.approval_decisions.slice(1); });
  const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
});

test('malformed stored run shapes are withheld as tampering instead of throwing', async t => {
  for (const mutate of [
    (run: any) => { run.manifest.approval_decisions = null; },
    (run: any) => { run.manifest.approval_decisions = [{ unexpected: 1 }]; },
    (run: any) => { run.manifest.provided_revisions = []; },
    (run: any) => { run.manifest = 'not-an-object'; },
    (run: any) => { run.slot = undefined; },
  ]) {
    const f = await fixture(t, { allows: () => true });
    const resolved = await f.service.resolve(actor, selection);
    assert.equal(resolved.status, 'provided');
    const runId = resolved.manifest.run_id;
    tamperStoredRun(f.vault, runId, mutate);
    const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
    assert.equal(result.status, 'withheld');
    assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
  }
});

test('rewriting a bound adapter to the null sentinel is detected by the integrity seal', async t => {
  const f = await fixture(t, { allows: () => true });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  const runId = resolved.manifest.run_id;
  tamperStoredRun(f.vault, runId, run => { run.model_adapter_id = null; });
  const result = await f.service.revalidate(actor, runId, { action: 'use-context' });
  assert.equal(result.status, 'withheld');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
});

test('a forged or missing integrity seal is detected at revalidation', async t => {
  for (const mutate of [
    (run: any) => { run.integrity = 'x'.repeat(64); },
    (run: any) => { delete run.integrity; },
    (run: any) => { run.slot.document_id = 'doc-forged'; },
  ]) {
    const f = await fixture(t, { allows: () => true });
    const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
    assert.equal(resolved.status, 'provided');
    const runId = resolved.manifest.run_id;
    tamperStoredRun(f.vault, runId, mutate);
    const result = await f.service.revalidate(actor, runId, { action: 'use-context', model_adapter_id: 'adapter-chat' });
    assert.equal(result.status, 'withheld');
    assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
  }
});

test('a signal-honoring hook still reports the timeout as a timeout to diagnostics', async t => {
  const errors: unknown[] = [];
  const f = await fixture(t, { timeout_ms: 5, allows: ({ signal }: any) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted by gate')), { once: true }); }), onError: (error: unknown) => errors.push(error) });
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'withheld');
  assert.equal(resolved.reason, 'EGRESS_POLICY_UNAVAILABLE');
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ModelEgressTimeoutError);
});

test('require_adapter deployments reject adapter-less resolves but accept declared ones', async t => {
  const f = await fixture(t, { require_adapter: true, allows: () => true });
  const missing = await f.service.resolve(actor, selection);
  assert.equal(missing.status, 'withheld');
  assert.equal(missing.reason, 'EGRESS_ADAPTER_REQUIRED');
  const resolved = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(resolved.status, 'provided');
  const result = await f.service.revalidate(actor, resolved.manifest.run_id, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(result.status, 'valid');
});

test('forged multibyte integrity value is treated as tampering instead of throwing', async t => {
  const f = await fixture(t, { allows: () => true });
  const first = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(first.status, 'provided');
  const runId = first.manifest.run_id;
  tamperStoredRun(f.vault, runId, (run: any) => { run.integrity = 'é'.repeat(64); });
  const verdict = await f.service.revalidate(actor, runId, { action: 'use-context', model_adapter_id: 'adapter-chat' });
  assert.equal(verdict.status, 'withheld');
  assert.equal(verdict.reason, 'KNOWLEDGE_CHANGED');
  assert.deepEqual(verdict.checkpoint, first.manifest.checkpoint);
});

test('null adapter input is rejected as invalid input', async t => {
  const f = await fixture(t, { allows: () => true });
  await assert.rejects(f.service.resolve(actor, { ...selection, model_adapter_id: null }), (error: any) => error.code === 'INVALID_INPUT');
  const first = await f.service.resolve(actor, selection);
  await assert.rejects(f.service.revalidate(actor, first.manifest.run_id, { action: 'use-context', model_adapter_id: null }), (error: any) => error.code === 'INVALID_INPUT');
});

test('default diagnostics report policy failures to console.error', async t => {
  // onError를 명시적으로 비워 서비스 기본 진단 경로를 검증한다.
  const f = await fixture(t, { allows: () => { throw new Error('policy crashed'); }, onError: undefined });
  const original = console.error;
  const reported: unknown[] = [];
  console.error = (...args: unknown[]) => { reported.push(args); };
  try {
    const verdict = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
    assert.equal(verdict.status, 'withheld');
    assert.equal(verdict.reason, 'EGRESS_POLICY_UNAVAILABLE');
    assert.equal(reported.length, 1);
  } finally {
    console.error = original;
  }
});

test('require_adapter without allows denies every resolve fail-closed', async t => {
  // 선언 강제 + 정책 훅 부재 조합은 모든 resolve를 잠그는 의도된 폐쇄 구성이다.
  const f = await fixture(t, { require_adapter: true });
  const withoutAdapter = await f.service.resolve(actor, selection);
  assert.equal(withoutAdapter.status, 'withheld');
  assert.equal(withoutAdapter.reason, 'EGRESS_ADAPTER_REQUIRED');
  const withAdapter = await f.service.resolve(actor, { ...selection, model_adapter_id: 'adapter-chat' });
  assert.equal(withAdapter.status, 'withheld');
  assert.equal(withAdapter.reason, 'EGRESS_POLICY_DENIED');
});
