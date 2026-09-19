import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digestPayload } from '../../packages/domain/index.ts';
import { KnowledgerClient, KnowledgerClientError, KnowledgerPendingError } from '../../packages/client/knowledge-client.ts';
import { createDemoApp } from '../../examples/order-workflow/application.ts';
import { guardedGeneration } from '../../packages/client/guarded-generation.ts';

const actor = { org_id: 'OrgOneMSP', actor_id: 'owner-1', kind: 'human' as const };

function revision() {
  const payload = {
    contract_type: 'DocumentRevision' as const, contract_version: 1 as const, revision_id: 'rev-client-test-001',
    document_id: 'doc-client-test-001', context_id: 'context-main', scope_id: 'scope-main', usage_scope: 'reference/v1',
    channel_id: 'client-channel', visibility: 'shared_channel' as const, title: 'Client test document', body_markdown: '# Body', parents: [], dependencies: [],
    metadata: { author_id: actor.actor_id, author_org_id: actor.org_id, created_at: '2026-01-01T00:00:00Z', source_kind: 'human_authored' as const, shared_assertions: [] },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function manifest(revisionValue: ReturnType<typeof revision>) {
  return {
    contract_type: 'RunContextManifest', contract_version: 1, manifest_id: 'manifest-client-test-001', run_id: 'run-client-test-001',
    context_id: revisionValue.payload.context_id, scope_id: revisionValue.payload.scope_id, usage_scope: revisionValue.payload.usage_scope,
    policy_id: 'policy-client-test-001', policy_version: 1, membership_epoch: 1,
    checkpoint: { mode: 'strict', checkpoint_id: 'checkpoint-client-test-001', channel_id: revisionValue.payload.channel_id, block_number: 2, transaction_index: 0, transaction_id: 'a'.repeat(64), block_hash: 'b'.repeat(64), eligibility_epoch: 1 },
    provided_revisions: [{ revision_digest: revisionValue.revision_digest, purpose: 'scoped_knowledge', reference_kind: 'normative', target_context_id: revisionValue.payload.context_id, target_scope_id: revisionValue.payload.scope_id, usage_scope: revisionValue.payload.usage_scope, agreement_id: 'agreement-client-test-001' }],
    approval_decisions: [{ decision_id: 'decision-client-test-001', revision_digest: revisionValue.revision_digest, proposal_id: 'proposal-client-test-001' }],
    private_sources: [], retrieval_profile_id: 'retrieval-client-test-001', authorization_snapshot_id: 'authz-client-test-001', model_egress_policy_version: 1,
  };
}

test('client pins an origin, injects caller headers, rejects redirects, and prefixes only workspace paths', async () => {
  const calls: any[] = [];
  const client = new KnowledgerClient({ baseUrl: 'https://knowledge.example/', workspaceId: 'workspace-main', headers: async () => ({ Cookie: 'caller-owned', 'X-KNOWLEDGER-CSRF': 'csrf-owned' }), fetch: async (input, init) => { calls.push({ input: String(input), init }); return new Response('{}'); } });
  await client.request('/health', { method: 'GET' });
  assert.equal(calls[0].input, 'https://knowledge.example/v1/workspaces/workspace-main/health');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Cookie, 'caller-owned');
  assert.throws(() => new KnowledgerClient({ baseUrl: 'http://example.com', workspaceId: 'workspace-main' }), /origin|HTTPS|loopback/i);
  assert.throws(() => new KnowledgerClient({ baseUrl: 'https://user:pass@knowledge.example', workspaceId: 'workspace-main' }), /origin|credential/i);
  await assert.rejects(() => client.request('https://other.example/escape'), KnowledgerClientError);
  await assert.rejects(() => client.request('/v1/workspaces/other/resolve'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'INVALID_PATH');
  await assert.rejects(() => client.request('/resolve/%2e%2e/escape'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'INVALID_PATH');
});

test('client bounds responses, parses strict JSON, and exposes 202 as a non-committed error', async () => {
  const pending = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async () => new Response(JSON.stringify({ status: 'pending' }), { status: 202 }) });
  await assert.rejects(() => pending.request('/resolve', { method: 'POST', body: {} }), (error: unknown) => error instanceof KnowledgerPendingError && error.status === 202);
  const duplicate = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async () => new Response('{"a":1,"a":2}') });
  await assert.rejects(() => duplicate.request('/resolve'), KnowledgerClientError);
  const huge = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(() => huge.request('/resolve'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'RESPONSE_TOO_LARGE');
  const stalled = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', timeoutMs: 10, fetch: async () => new Response(new ReadableStream({ start() { /* deliberately never produce a body */ } })) });
  await assert.rejects(() => stalled.request('/resolve'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'TIMEOUT');
  let headersCalled = false;
  const hangingHeaders = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', timeoutMs: 10, headers: async () => { headersCalled = true; return await new Promise<Record<string, string>>(() => undefined); }, fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(() => hangingHeaders.request('/resolve'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'TIMEOUT');
  assert.equal(headersCalled, true);
  const preaborted = new AbortController(); preaborted.abort(); let networkCalls = 0;
  const abortedClient = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', headers: () => { throw new Error('must not prepare headers'); }, fetch: async () => { networkCalls++; return new Response('{}'); } });
  await assert.rejects(() => abortedClient.request('/resolve', { signal: preaborted.signal }), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'ABORTED');
  assert.equal(networkCalls, 0);
});

test('validated resolve fetches and verifies the full revision, manifest slot and digest', async () => {
  const current = revision();
  const currentManifest = manifest(current);
  const calls: string[] = [];
  const client = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async (input) => {
    const url = String(input); calls.push(url);
    if (url.endsWith('/resolve')) return new Response(JSON.stringify({ status: 'provided', mode: 'fabric', documents: [{ revision_digest: current.revision_digest, title: current.payload.title, body_markdown: current.payload.body_markdown, agreement_id: 'agreement-client-test-001' }], manifest: currentManifest, checkpoint: currentManifest.checkpoint }));
    if (url.endsWith(`/revisions/${current.revision_digest}`)) return new Response(JSON.stringify(current));
    throw new Error('unexpected URL');
  } });
  const result = await client.resolve({ document_ids: [current.payload.document_id], context_id: current.payload.context_id, scope_id: current.payload.scope_id, usage_scope: current.payload.usage_scope });
  assert.equal(result.status, 'provided');
  assert.deepEqual(result.revision, current);
  assert.equal(calls.length, 2);
});

test('validated resolve rejects development modes by default and catches revision tampering', async () => {
  const current = revision(); const currentManifest = manifest(current);
  let revisionResponse = current;
  const client = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async (input) => {
    const url = String(input);
    if (url.endsWith('/resolve')) return new Response(JSON.stringify({ status: 'provided', mode: 'local-simulation', documents: [{ revision_digest: current.revision_digest, title: current.payload.title, body_markdown: current.payload.body_markdown, agreement_id: 'agreement-client-test-001' }], manifest: currentManifest, checkpoint: currentManifest.checkpoint }));
    return new Response(JSON.stringify(revisionResponse));
  } });
  await assert.rejects(() => client.resolve({ document_ids: [current.payload.document_id], context_id: current.payload.context_id, scope_id: current.payload.scope_id, usage_scope: current.payload.usage_scope }), /development|mode/i);
  const allowed = await client.resolve({ document_ids: [current.payload.document_id], context_id: current.payload.context_id, scope_id: current.payload.scope_id, usage_scope: current.payload.usage_scope }, { allowDevelopment: true });
  assert.equal(allowed.status, 'provided');
  revisionResponse = { ...current, revision_digest: `sha256:${'c'.repeat(64)}` };
  await assert.rejects(() => client.resolve({ document_ids: [current.payload.document_id], context_id: current.payload.context_id, scope_id: current.payload.scope_id, usage_scope: current.payload.usage_scope }, { allowDevelopment: true }), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'INVALID_CLIENT_DATA');
});

test('client validates the real demo resolve and revalidate manifest lifecycle with caller cookie and CSRF', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-client-integration-'));
  const app = await createDemoApp({ dataDir: directory, modelEgress: { allows: () => true } });
  const origin = await app.listen(0);
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const sessionResponse = await fetch(`${origin}/api/session`);
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
  const session = await sessionResponse.json() as { csrf_token: string };
  const client = new KnowledgerClient({ baseUrl: origin, workspaceId: 'demo', headers: () => ({ Cookie: cookie, Origin: origin, 'X-KNOWLEDGER-CSRF': session.csrf_token }) });
  const selection = { document_ids: ['doc-sales-order-definition-001'] as [string], context_id: 'context-sales', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1' };
  const resolved = await client.resolve(selection, { allowDevelopment: true });
  assert.equal(resolved.status, 'provided');
  if (resolved.status !== 'provided') return;
  const revalidated = await client.revalidate(resolved.manifest.run_id);
  assert.equal(revalidated.status, 'valid');
  assert.equal(revalidated.refreshed_manifest.run_id, resolved.manifest.run_id);
  const guarded = await guardedGeneration({
    client, selection, allowDevelopment: true, adapterId: 'demo-adapter', authorize: async () => true,
    generate: async ({ documents, manifest: generationManifest }) => {
      assert.equal(documents[0].body_markdown, resolved.documents[0].body_markdown);
      assert.equal(generationManifest.provided_revisions[0].revision_digest, resolved.manifest.provided_revisions[0].revision_digest);
      return 'generated-from-approved-data';
    }, timeoutMs: 5_000,
  });
  assert.equal(guarded.status, 'provided');
  if (guarded.status === 'provided') assert.equal(guarded.output, 'generated-from-approved-data');
});

test('revalidate does not accept a bare valid status without a refreshed manifest', async () => {
  const client = new KnowledgerClient({ baseUrl: 'https://knowledge.example', workspaceId: 'workspace-main', fetch: async () => new Response(JSON.stringify({ status: 'valid' })) });
  await assert.rejects(() => client.revalidate('run-client-test-001'), (error: unknown) => error instanceof KnowledgerClientError && error.code === 'INVALID_CLIENT_DATA');
});

test('expired header preparation cannot start a late request and malformed refreshed proof is rejected',async()=>{
  let release!:(headers:Record<string,string>)=>void;let calls=0;
  const client=new KnowledgerClient({baseUrl:'https://knowledge.example',workspaceId:'workspace-main',timeoutMs:5,headers:()=>new Promise(resolve=>release=resolve),fetch:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(client.request('/sources'),(error:any)=>error.code==='TIMEOUT');release({});await new Promise(resolve=>setTimeout(resolve,0));assert.equal(calls,0);
  const value=manifest(revision());
  for(const mutate of [(m:any)=>{m.checkpoint.transaction_id='invalid';},(m:any)=>{m.private_sources=[{private_uri:'PRIVATE_URI'}];},(m:any)=>{m.approval_decisions=[];},(m:any)=>{m.checkpoint.private_debug='do-not-forward';}]){
    const invalid=structuredClone(value);mutate(invalid);
    const broken=new KnowledgerClient({baseUrl:'https://knowledge.example',workspaceId:'workspace-main',fetch:async()=>new Response(JSON.stringify({status:'valid',refreshed_manifest:invalid,checkpoint:invalid.checkpoint}))});
    await assert.rejects(broken.revalidate('run-client-test-001'),KnowledgerClientError);
  }
});

test('client refuses a context packet that expires while retrieving its immutable revision',async t=>{
  let clock=0;t.mock.method(performance,'now',()=>clock);const current=revision();const proof=manifest(current);
  const client=new KnowledgerClient({baseUrl:'https://knowledge.example',workspaceId:'workspace-main',fetch:async input=>{
    if(String(input).endsWith('/resolve'))return new Response(JSON.stringify({status:'provided',mode:'fabric',documents:[{revision_digest:current.revision_digest,title:current.payload.title,body_markdown:current.payload.body_markdown,agreement_id:'agreement-client-test-001'}],manifest:proof,checkpoint:proof.checkpoint}));
    clock=30_001;return new Response(JSON.stringify(current));
  }});
  await assert.rejects(client.resolve({document_ids:[current.payload.document_id],context_id:current.payload.context_id,scope_id:current.payload.scope_id,usage_scope:current.payload.usage_scope}),(error:any)=>error.code==='FRESHNESS_EXPIRED');
});
