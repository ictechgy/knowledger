import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any) {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-draft-dependencies-'));
  const config = createProjectTemplate(['WriterMSP', 'ReviewerMSP'], 'dependency-workspace');
  const basePolicy = config.genesis.policies[0];
  config.genesis.policies = ['source', 'target'].map(name => ({ ...structuredClone(basePolicy),
    policy_id: `policy-${name}`, document_id: `doc-${name}`, scope_id: `scope-${name}`, acceptance_slot: `slot-${name}` }));
  let app = await createConfiguredApp(config, { dataDir, port: 0 });
  let url = await app.listen(0); let cookie = ''; let csrf = ''; let sequence = 0;
  const session = async () => {
    const response = await fetch(`${url}/api/session`); cookie = response.headers.get('set-cookie')!.split(';')[0];
    csrf = (await response.json() as any).csrf_token;
  };
  await session();
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const post = async (path: string, body: any, expected = 200) => {
    const response = await fetch(`${url}${path === '/api/session' ? path : '/v1/workspaces/dependency-workspace' + path}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: url, 'X-KNOWLEDGER-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json() as any; assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    if (path === '/api/session' && response.ok) csrf = value.csrf_token;
    return value;
  };
  const get = async (path: string, expected = 200) => {
    const response = await fetch(`${url}/v1/workspaces/dependency-workspace${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, expected); return await response.json() as any;
  };
  const actor = (org_id: string) => post('/api/session', { org_id, actor_id: 'maintainer' });
  const input = (name: string, extra: any = {}) => ({ document_id: `doc-${name}`, context_id: 'context-shared', scope_id: `scope-${name}`,
    usage_scope: 'reference/v1', title: name, body_markdown: `# ${name}`, ...extra });
  const publish = async (draft: any) => {
    const preview = await post('/publication-previews', { draft_id: draft.draft_id });
    await post('/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: `dep-publish-${++sequence}` });
    return draft.revision;
  };
  const propose = async (revision: any, name: string) => {
    return (await post('/agreement-proposals', { revision_digest: revision.revision_digest, policy_id: `policy-${name}`,
      policy_version: 1, command_id: `dep-propose-${++sequence}` })).result.proposal_id;
  };
  const approve = async (proposal: string) => {
    for (const org of ['WriterMSP', 'ReviewerMSP']) {
      await actor(org); await post(`/agreement-proposals/${proposal}/decisions`, { decision: 'approve', rationale: 'Fictional fixture review', command_id: `dep-approve-${++sequence}` });
    }
    await actor('WriterMSP');
  };
  const activate = async (proposal: string, previous: string | null = null, expected = 200) => post(`/agreement-proposals/${proposal}/activate`, {
    expected_active_agreement_id: previous, command_id: `dep-activate-${++sequence}`,
  }, expected);
  const resolve = (name: string) => post('/resolve', { document_ids: [`doc-${name}`], context_id: 'context-shared', scope_id: `scope-${name}`, usage_scope: 'reference/v1' });
  return { get app() { return app; }, get url() { return url; }, post, get, actor, input, publish, propose, approve, activate, resolve,
    async source() { return publish(await post('/drafts', input('source'))); },
    async restart() { await app.close(); app = await createConfiguredApp(config, { dataDir, port: 0 }); url = await app.listen(0); await session(); } };
}
const reference = (revision: any, enforcement = 'requires_active') => ({ revision_digest: revision.revision_digest, relationship: 'reference', enforcement });

test('draft dependencies bind the exact shared revision and full canonical slot without shared writes', async t => {
  const f = await fixture(t); const source = await f.source();
  const before = f.app.service.ledger.checkpoint();
  const draft = await f.post('/drafts', f.input('target', { body_markdown: 'PRIVATE_DEPENDENT_CANARY', dependencies: [reference(source)] }));
  const p = source.payload;
  assert.deepEqual(draft.revision.payload.dependencies, [{ ...reference(source), channel_id: p.channel_id,
    document_id: p.document_id, context_id: p.context_id, scope_id: p.scope_id, usage_scope: p.usage_scope }]);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  assert.equal(JSON.stringify(f.app.service.ledger.events(0, 1000)).includes('PRIVATE_DEPENDENT_CANARY'), false);
  await f.actor('ReviewerMSP'); await f.get(`/drafts/${draft.draft_id}`, 404);
  await f.actor('WriterMSP');
  const preview = await f.post('/publication-previews', { draft_id: draft.draft_id });
  assert.deepEqual(preview.revision.payload.dependencies, draft.revision.payload.dependencies);
});

test('private, unknown and malformed dependency selectors cannot create a draft', async t => {
  const f = await fixture(t); const source = await f.source();
  const privateSource = await f.post('/drafts', f.input('source', { title: 'Private unpublished source' }));
  const count = (await f.get('/drafts')).total; const before = f.app.service.ledger.checkpoint();
  for (const dependencies of [null, 'bad', [null], [reference(source), reference(source)], Array(33).fill(reference(source)),
    [{ ...reference(source), revision_digest: 'latest' }], [{ ...reference(source), relationship: '<invalid>' }],
    [{ ...reference(source), enforcement: 'optional' }], [{ ...reference(source), document_id: 'forged-slot' }],
    [{ ...reference(source), private_source_id: 'private-canary' }]]) {
    await f.post('/drafts', f.input('target', { dependencies }), 400);
  }
  for (const revision_digest of [privateSource.revision.revision_digest, `sha256:${'1'.repeat(64)}`]) {
    const failure = await f.post('/drafts', f.input('target', { dependencies: [{ ...reference(source), revision_digest }] }), 404);
    assert.equal(failure.code, 'NOT_FOUND');
  }
  assert.equal((await f.get('/drafts')).total, count); assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  const anonymous = await fetch(`${f.url}/v1/workspaces/dependency-workspace/drafts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.url }, body: JSON.stringify(f.input('target', { dependencies: [reference(source)] })) });
  assert.equal(anonymous.status, 401);
});

test('editing dependencies creates an immutable draft and preserves idempotency across restart', async t => {
  const f = await fixture(t); const source = await f.source();
  const original = await f.post('/drafts', f.input('target', { dependencies: [reference(source)] }));
  const edit = { edit_id: 'edit-clear-dependencies', title: original.revision.payload.title, body_markdown: original.revision.payload.body_markdown, dependencies: [] };
  const changed = await f.post(`/drafts/${original.draft_id}/edits`, edit);
  assert.notEqual(changed.revision.revision_digest, original.revision.revision_digest);
  assert.deepEqual(changed.revision.payload.dependencies, []);
  assert.deepEqual(changed.revision.payload.parents, original.revision.payload.parents);
  assert.deepEqual((await f.get(`/drafts/${original.draft_id}`)).revision, original.revision);
  await f.post(`/drafts/${original.draft_id}/edits`, { ...edit, dependencies: [reference(source, 'informational')] }, 409);
  const retained = await f.post(`/drafts/${original.draft_id}/edits`, { edit_id: 'edit-keep-dependencies', title: 'Keep references', body_markdown: 'Changed body' });
  assert.deepEqual(retained.revision.payload.dependencies, original.revision.payload.dependencies);
  await f.restart(); assert.deepEqual(await f.post(`/drafts/${original.draft_id}/edits`, edit), changed);
});

test('base revisions and Markdown imports preserve omitted dependencies and accept explicit replacement', async t => {
  const f = await fixture(t); const source = await f.source();
  const base = await f.publish(await f.post('/drafts', f.input('target', { dependencies: [reference(source)] })));
  const kept = await f.post('/drafts', { base_revision_digest: base.revision_digest, title: 'Retained', body_markdown: 'New body' });
  assert.deepEqual(kept.revision.payload.dependencies, base.payload.dependencies);
  const cleared = await f.post('/drafts', { base_revision_digest: base.revision_digest, title: 'Cleared', body_markdown: 'New body', dependencies: [] });
  assert.deepEqual(cleared.revision.payload.dependencies, []); assert.deepEqual(cleared.revision.payload.parents, [base.revision_digest]);
  const input = { import_id: 'import-dependent-markdown', filename: 'dependent.md', content_base64: Buffer.from('# Imported dependent').toString('base64'),
    title: 'Imported', base_revision_digest: base.revision_digest, dependencies: [reference(source, 'informational')] };
  const imported = await f.post('/draft-imports/markdown', input);
  assert.equal(imported.revision.payload.dependencies[0].enforcement, 'informational');
  assert.deepEqual(await f.post('/draft-imports/markdown', input), imported);
  await f.post('/draft-imports/markdown', { ...input, dependencies: [] }, 409);
});

test('required dependencies use fresh eligibility and changed references need fresh approvals', async t => {
  const f = await fixture(t); const source = await f.source();
  const target = await f.publish(await f.post('/drafts', f.input('target', { dependencies: [reference(source)] })));
  const targetProposal = await f.propose(target, 'target'); await f.approve(targetProposal);
  await f.activate(targetProposal, null, 409); // Source is published but not active.
  const sourceProposal = await f.propose(source, 'source'); await f.approve(sourceProposal);
  const sourceAgreement = (await f.activate(sourceProposal)).result.agreement_id;
  const targetAgreement = (await f.activate(targetProposal)).result.agreement_id;
  const packet = await f.resolve('target'); assert.equal(packet.status, 'provided');
  const updated = await f.publish(await f.post('/drafts', { base_revision_digest: target.revision_digest,
    title: target.payload.title, body_markdown: target.payload.body_markdown, dependencies: [reference(source, 'informational')] }));
  const nextProposal = await f.propose(updated, 'target');
  assert.equal((await f.activate(nextProposal, targetAgreement, 409)).code, 'APPROVAL_INCOMPLETE');
  await f.post(`/agreements/${sourceAgreement}/withdraw`, { reason: 'Fixture source withdrawal', command_id: 'dep-withdraw-source' });
  assert.equal((await f.resolve('target')).status, 'withheld');
  assert.equal((await f.post(`/runs/${packet.manifest.run_id}/revalidate`, { action: 'use-context' })).status, 'withheld');
  await f.approve(nextProposal); await f.activate(nextProposal, targetAgreement);
  assert.equal((await f.resolve('target')).status, 'provided', 'informational references do not gate usage');
});

test('dependency selection rejects a canonical value returned under the wrong ledger key', async t => {
  const f = await fixture(t); const source = await f.source();
  const other = await f.publish(await f.post('/drafts', f.input('source', { title: 'Other revision' })));
  const read = f.app.service.ledger.read.bind(f.app.service.ledger);
  f.app.service.ledger.read = (key: string, at: any) => key === keyFor.revision(source.revision_digest) ? other : read(key, at);
  try { assert.equal((await f.post('/drafts', f.input('target', { dependencies: [reference(source)] }), 503)).code, 'PROJECTION_INVALID'); }
  finally { f.app.service.ledger.read = read; }
});
