import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createApp } from '../../apps/api/server.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { applicationDefinition } from '../../packages/config/project.ts';
import { createOpenAIEmbeddingProvider } from '../../packages/embeddings/openai.ts';
import { LocalVectorIndex } from '../../packages/storage/vector-index.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any, opts: any = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'knowledger-embedding-')); const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'embedding-test');
  const requests: any[] = []; const policyCalls: any[] = []; let keyReads = 0;
  const provider = createOpenAIEmbeddingProvider({ profileId: 'openai-test-v1', dimensions: 2, countTokens: text => text.length,
    getApiKey: async signal => { keyReads++; return opts.getApiKey ? opts.getApiKey(signal) : 'fixture-key'; },
    fetch: async (_url, input) => { const body = JSON.parse(String(input!.body)); requests.push(body);
      if (opts.fetch) return opts.fetch(body, input);
      return new Response(JSON.stringify({ object: 'list', model: body.model, data: [{ object: 'embedding', index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } });
    } });
  const embedding = { provider, ...opts.limits, allows: opts.noPolicy ? undefined : async (request: any) => {
    policyCalls.push({ ...request, signal: undefined }); return opts.allows ? opts.allows(request) : true;
  } };
  const common = { dataDir: dir, embedding, vectorIndex: opts.index, modelEgress: opts.modelEgress, reviewReminders: false as const };
  const app = opts.authentication ? await createApp({ ...common, definition: applicationDefinition(config), authentication: opts.authentication })
    : await createConfiguredApp(config, { ...common, port: 0 });
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  const author = config.bootstrap_actor; const other = { org_id: 'BetaMSP', actor_id: 'maintainer', kind: 'human' as const }; let seq = 0;
  const draft = async (title: string) => app.service.draft(author, { document_id: `doc-embedding-${++seq}`, context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1', title, body_markdown: `# BODY_${title}` });
  const publish = async (title: string) => { const value = await draft(title); const preview = await app.service.preview(author, { draft_id: value.draft_id });
    await app.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: `embedding-publish-${seq}` }); return value.revision; };
  const revision = await publish('PUBLIC_FIXTURE'); await draft('PRIVATE_UNPUBLISHED_CANARY');
  const search = (actor = author, signal?: AbortSignal) => app.service.vectorSearch(actor, { query: 'QUERY_PRIVATE_CANARY', context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1' }, signal);
  return { app, author, other, revision, requests, policyCalls, search, publish, get keyReads() { return keyReads; } };
}
const errorCode = (code: string) => (error: any) => error.code === code;

test('guarded embeddings bind current actor, canonical revision slot and profile without leaking text to policy', async t => {
  const f = await fixture(t); const before = f.app.service.ledger.checkpoint();
  const response = await f.search(); assert.equal(response.results[0].revision_digest, f.revision.revision_digest);
  assert.equal(response.embedding_profile.model, 'text-embedding-3-small'); assert.equal(response.embedding_profile.dimensions, 2);
  assert.equal('endpoint' in response.embedding_profile, false);
  assert.match(response.embedding_profile_digest, /^sha256:/); assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(value => Object.keys(value).sort().join(',') === 'dimensions,encoding_format,input,model'));
  assert.equal(JSON.stringify(f.requests).includes('PRIVATE_UNPUBLISHED_CANARY'), false);
  assert.equal(JSON.stringify(f.policyCalls).includes('QUERY_PRIVATE_CANARY'), false); assert.equal(JSON.stringify(f.policyCalls).includes('BODY_PUBLIC'), false);
  const revisionCall = f.policyCalls.find(value => value.kind === 'revision');
  assert.deepEqual(revisionCall.actor, f.author); assert.equal(revisionCall.revision.revision_digest, f.revision.revision_digest);
  assert.equal(revisionCall.revision.slot.channel_id, 'embedding-test-channel'); assert.equal(revisionCall.input_bytes, Buffer.byteLength('PUBLIC_FIXTURE\n# BODY_PUBLIC_FIXTURE'));
  assert.deepEqual(f.app.service.ledger.checkpoint(), before); assert.equal(f.app.service.values('decision').length, 0);
});

test('absent/false/nonboolean policy denies before credentials or provider calls and generation egress does not override it', async t => {
  for (const settings of [{ noPolicy: true, modelEgress: { allows: () => true } }, { allows: () => false }, { allows: () => 'yes' }]) {
    const f = await fixture(t, settings); await assert.rejects(f.search(), errorCode('EMBEDDING_EGRESS_DENIED'));
    assert.equal(f.requests.length, 0); assert.equal(f.keyReads, 0);
  }
});

test('revision disclosure denial fails closed even when the caller may search the shared ledger', async t => {
  const f = await fixture(t, { allows: (request: any) => request.kind === 'query' });
  await assert.rejects(f.search(), errorCode('EMBEDDING_EGRESS_DENIED'));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].input, 'QUERY_PRIVATE_CANARY');
});

test('cached revision vectors require fresh per-actor policy and revoked policy prevents reuse', async t => {
  let permitted = true;
  const f = await fixture(t, { allows: (request: any) => request.kind === 'query' || permitted && request.actor.org_id === 'AlphaMSP' });
  await f.search(); await f.search(); assert.equal(f.requests.length, 3, 'two queries and one cached document');
  assert.ok(f.policyCalls.some(value => value.phase === 'cache'));
  await assert.rejects(f.search(f.other), errorCode('EMBEDDING_EGRESS_DENIED')); assert.equal(f.requests.length, 4);
  permitted = false; await assert.rejects(f.search(), errorCode('EMBEDDING_EGRESS_DENIED')); assert.equal(f.requests.length, 5);
});

test('timeout followed by a late policy approval cannot start the provider', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, { limits: { timeoutMs: 30 }, allows: async () => { await gate; return true; } });
  await assert.rejects(f.search(), errorCode('EMBEDDING_TIMEOUT')); release(); await delay(10);
  assert.equal(f.requests.length, 0); assert.equal(f.keyReads, 0);
});

test('current account authorization is rechecked after delayed credential retrieval', async t => {
  let revoked = false; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const authentication: any = { mode: 'oidc', origin: 'https://fixture.invalid', issuer: 'https://issuer.invalid', handle: async () => false,
    session: async () => undefined, run: async (_s: any, run: any) => run(), close() {},
    assertCurrentActor: async () => { if (revoked) throw Object.assign(new Error('PRIVATE_AUTH_DIAGNOSTIC'), { status: 403 }); } };
  const f = await fixture(t, { authentication, getApiKey: async () => { entered(); await gate; return 'fixture-key'; } });
  const result = f.search(); const denied = assert.rejects(result, errorCode('EMBEDDING_AUTHORIZATION_DENIED'));
  await started; revoked = true; release(); await denied; assert.equal(f.requests.length, 0);
});

test('provider completion after serving freeze is discarded and cannot populate the cache', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let delayed = true;
  const f = await fixture(t, { fetch: async (body: any) => { if (delayed) { entered(); await gate; } return new Response(JSON.stringify({ object: 'list', model: body.model,
    data: [{ object: 'embedding', index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 } }), { headers: { 'Content-Type': 'application/json' } }); } });
  const pending = f.search(); const rejected = assert.rejects(pending, errorCode('EMBEDDING_UNAVAILABLE')); await started;
  const read = f.app.service.ledger.read.bind(f.app.service.ledger);
  f.app.service.ledger.read = (key: string, at: any) => { const value = read(key, at); return key === keyFor.config() ? { ...value, serving_enabled: false } : value; };
  release(); await rejected; f.app.service.ledger.read = read; delayed = false;
  await f.search(); assert.equal(f.requests.length, 3);
});

test('a denied or over-budget rebuild preserves the original index; authorized rebuild uses only shared revisions', async t => {
  const index = new LocalVectorIndex(); let allowed = false;
  const f = await fixture(t, { index, allows: () => allowed });
  index.upsert({ document_id: 'doc-old', revision_digest: `sha256:${'f'.repeat(64)}`, context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1', embedding: [1, 0] });
  await assert.rejects(f.app.service.rebuildVectorIndex(f.author), errorCode('EMBEDDING_EGRESS_DENIED')); assert.equal(index.size, 1); assert.equal(f.requests.length, 0);
  allowed = true; const result = await f.app.service.rebuildVectorIndex(f.author); assert.equal(result.indexed, 1); assert.equal(index.size, 1);
  assert.equal(index.candidates({ embedding: [1, 0], limit: 10 })[0].revision_digest, f.revision.revision_digest);
  const capped = await fixture(t, { index: new LocalVectorIndex(), limits: { maxCalls: 1 } }); await capped.publish('ANOTHER_PUBLIC');
  await assert.rejects(capped.app.service.rebuildVectorIndex(capped.author), errorCode('EMBEDDING_BUDGET_EXCEEDED'));
  assert.equal(capped.requests.length, 1);
});

test('policy rejection after a later document prevents partial index replacement', async t => {
  const index = new LocalVectorIndex(); let denyFinal = false; let completed = 0;
  const f = await fixture(t, { index, allows: (r: any) => {
    if (r.phase === 'after-result' && r.kind === 'revision') { completed++; if (completed > 2) denyFinal = true; }
    return !denyFinal;
  } }); await f.publish('SECOND_PUBLIC');
  await assert.rejects(f.app.service.rebuildVectorIndex(f.author), errorCode('EMBEDDING_EGRESS_DENIED'));
  assert.equal(index.size, 0); assert.equal(f.requests.length, 2);
});

test('HTTP disconnect cancels the original operation and releases its admission slot', async t => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let first = true;
  const f = await fixture(t, { limits: { maxConcurrent: 1 }, getApiKey: async () => { if (first) { first = false; entered(); await gate; } return 'fixture-key'; } });
  const origin = await f.app.listen(0); const session = await fetch(origin + '/api/session'); const cookie = session.headers.get('set-cookie')!.split(';')[0]; const login = await session.json() as any;
  const controller = new AbortController(); const options = { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': login.csrf_token }, body: JSON.stringify({ query: 'query' }) };
  const pending = fetch(origin + '/v1/workspaces/embedding-test/vector-search', { ...options, signal: controller.signal }); const aborted = assert.rejects(pending);
  await started; controller.abort(); await aborted; await delay(20); release(); await delay(10); assert.equal(f.requests.length, 0);
  const response = await fetch(origin + '/v1/workspaces/embedding-test/vector-search', options); assert.equal(response.status, 200); await response.json();
});

test('shutdown aborts an uncooperative provider and late completion does not return a vector', async t => {
  let release!: (value: Response) => void; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(t, { fetch: async () => { entered(); return new Promise<Response>(resolve => { release = resolve; }); } });
  const pending = f.search(); const aborted = assert.rejects(pending, errorCode('EMBEDDING_ABORTED')); await started;
  await f.app.service.closeEmbeddings(); await aborted;
  release(new Response('{}', { headers: { 'Content-Type': 'application/json' } })); await delay(10);
  await assert.rejects(f.search(), errorCode('EMBEDDING_ABORTED'));
});

test('policy diagnostics are scrubbed and embedding admission remains bounded', async t => {
  const broken = await fixture(t, { allows: () => { throw new Error('PRIVATE_POLICY_CANARY'); } });
  await assert.rejects(broken.search(), (e: any) => e.code === 'EMBEDDING_POLICY_UNAVAILABLE' && !String(e).includes('CANARY') && !JSON.stringify(e).includes('CANARY'));
  assert.equal(broken.requests.length, 0);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const busy = await fixture(t, { limits: { maxConcurrent: 1 }, allows: async () => { entered(); await gate; return true; } });
  const first = busy.search(); await started;
  await assert.rejects(busy.search(), errorCode('EMBEDDING_BUSY')); release(); await first;
});
