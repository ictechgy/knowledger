import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';

async function fixture(t: any) {
  const dataDir = mkdtempSync(join(tmpdir(), 'kcl-review-regression-'));
  const configuration = createProjectTemplate();
  const app = await createConfiguredApp(configuration, { dataDir, port: 0 });
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  const actor = configuration.bootstrap_actor;
  let command = 0;
  const publish = async (documentId: string, parent?: string) => {
    const policy = configuration.genesis.policies[0];
    const draft = await app.service.draft(actor, { document_id: documentId, context_id: policy.context_id,
      scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: `Revision ${++command}`,
      body_markdown: `# BODY_CANARY_${command}`, ...(parent ? { base_revision_digest: parent } : {}) });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `review-publish-${command}` });
    return draft.revision;
  };
  return { app, actor, configuration, publish };
}

test('overview and search are bounded summaries; exact bodies and snapshot history remain available', async t => {
  const { app, actor, configuration, publish } = await fixture(t);
  const revisions = [];
  for (let n = 0; n < 25; n++) revisions.push(await publish('doc-history', revisions.at(-1)?.revision_digest));
  for (let n = 0; n < 21; n++) await publish(`doc-other-${n}`);
  const first = await app.service.overview(actor, { limit: 5 });
  assert.equal(first.documents.length, 5);
  assert.equal(first.documents_total, 22);
  assert.ok(first.next_cursor);
  assert.ok(first.documents.every((doc: any) => !('body_markdown' in doc.payload) && !('history' in doc)));
  assert.equal(JSON.stringify(first).includes('BODY_CANARY'), false);
  const seen = new Set(first.documents.map((doc: any) => doc.revision_digest));
  let cursor = first.next_cursor;
  await publish('doc-after-page');
  while (cursor) {
    const page = await app.service.overview(actor, { limit: 5, cursor });
    assert.deepEqual(page.checkpoint, first.checkpoint);
    for (const doc of page.documents) { assert.ok(!seen.has(doc.revision_digest)); seen.add(doc.revision_digest); }
    cursor = page.next_cursor;
  }
  assert.equal(seen.size, 22, 'new publications cannot shift an existing page snapshot');
  const other = configuration.identities[1];
  await assert.rejects(app.service.overview(other, { cursor: first.next_cursor }), (error: any) => error.code === 'INVALID_CURSOR');
  await assert.rejects(app.service.overview(actor, { cursor: first.next_cursor + 'x' }), (error: any) => error.code === 'INVALID_CURSOR');
  await assert.rejects(app.service.overview(actor, { limit: 51 }), (error: any) => error.code === 'INVALID_QUERY');
  const latest = revisions.at(-1)!;
  const view = await app.service.revisionView(actor, latest.revision_digest);
  assert.equal(view.payload.body_markdown, latest.payload.body_markdown);
  assert.equal('history' in view, false);
  const history = await app.service.revisionHistory(actor, latest.revision_digest, { limit: 10 });
  assert.equal(history.revisions.length, 10); assert.equal(history.total, 25);
  assert.equal(history.revisions[0].revision_digest, latest.revision_digest);
  assert.deepEqual(await app.service.getRevision(actor, revisions[0].revision_digest), revisions[0]);
  await assert.rejects(app.service.revisionHistory(actor, latest.revision_digest, { cursor: first.next_cursor }), (error: any) => error.code === 'INVALID_CURSOR');
  const search = await app.service.search(actor, { query: 'BODY_CANARY', limit: 7 });
  assert.equal(search.results.length, 7); assert.equal(search.total, 47); assert.ok(search.next_cursor);
  assert.ok(search.results.every((doc: any) => !('body_markdown' in doc.payload) && !('history' in doc)));
  await assert.rejects(app.service.search(actor, { query: 'another', cursor: search.next_cursor }), (error: any) => error.code === 'INVALID_CURSOR');
});

test('a slow public command does not hold independent private writes; private CAS still serializes', async t => {
  const { app, actor, configuration } = await fixture(t);
  const policy = configuration.genesis.policies[0];
  const draft = await app.service.draft(actor, { document_id: policy.document_id, context_id: policy.context_id,
    scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: 'Public fixture', body_markdown: '# Shared' });
  const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
  const execute = app.service.ledger.execute.bind(app.service.ledger);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  app.service.ledger.execute = async (...args) => { entered(); await gate; return execute(...args); };
  const publishing = app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'slow-public-command' });
  await started;
  const input = { operation_id: 'private-import-001', expected_version: 0, path: 'guide.md', policy_id: policy.policy_id,
    policy_version: 1, title: 'Private fixture', content_base64: Buffer.from('# Private').toString('base64') };
  const importing = app.service.importSourceMarkdown(actor, 'private-source', input);
  try {
    const result = await Promise.race([importing, delay(150).then(() => null)]);
    assert.ok(result, 'private work must complete before the unrelated public command returns');
    assert.equal(result.status, 'imported');
    const same = await app.service.importSourceMarkdown(actor, 'private-source', input);
    assert.deepEqual(same, result);
    const writes = await Promise.allSettled(['a', 'b'].map(suffix => app.service.importSourceMarkdown(actor, 'private-source', {
      ...input, operation_id: `private-change-${suffix}`, expected_version: 1, content_base64: Buffer.from(`# Changed ${suffix}`).toString('base64'),
    })));
    assert.equal(writes.filter(value => value.status === 'fulfilled').length, 1);
    assert.equal(writes.filter(value => value.status === 'rejected' && value.reason.status === 409).length, 1);
  } finally { release(); await Promise.allSettled([publishing, importing]); }
});

test('anonymous liveness never refreshes the ledger or discloses ledger metadata', async t => {
  const { app } = await fixture(t); const origin = await app.listen(0);
  let calls = 0;
  app.service.ledger.refresh = async () => { calls++; throw new Error('synthetic private peer diagnostic'); };
  const responses = await Promise.all(Array.from({ length: 8 }, () => fetch(origin + '/healthz')));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', healthy: true, state: 'live' });
  }
  assert.equal(calls, 0);
});

test('public command admission is bounded and retry preserves the original commit', async t => {
  const { app, actor, configuration } = await fixture(t); const policy = configuration.genesis.policies[0];
  const draft = await app.service.draft(actor, { document_id: policy.document_id, context_id: policy.context_id,
    scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: 'Queue bound', body_markdown: '# Shared' });
  const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
  const input = { preview_id: preview.preview_id, confirm_shared: true, command_id: 'bounded-public-command' };
  const execute = app.service.ledger.execute.bind(app.service.ledger);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  app.service.ledger.execute = async (...args) => { entered(); await gate; return execute(...args); };
  const first = app.service.publish(actor, input); await started;
  const queued = Array.from({ length: 31 }, () => app.service.publish(actor, input));
  try {
    await assert.rejects(app.service.publish(actor, input), (error: any) => error.code === 'COMMAND_QUEUE_FULL' && error.status === 503 && error.retryable);
  } finally { release(); }
  const committed = await first;
  for (const value of await Promise.all(queued)) assert.deepEqual(value.checkpoint, committed.checkpoint);
  const beforeRetry = app.service.ledger.checkpoint();
  assert.deepEqual((await app.service.publish(actor, input)).checkpoint, committed.checkpoint);
  assert.deepEqual(app.service.ledger.checkpoint(), beforeRetry);
});

test('HTTP browse routes validate page parameters and keep exact revision bodies separate', async t => {
  const { app, publish } = await fixture(t);
  const revision = await publish('doc-http-browse');
  const origin = await app.listen(0); const login = await fetch(origin + '/api/session');
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
  const base = origin + '/v1/workspaces/knowledge';
  for (const query of ['?limit=0', '?limit=51', '?limit=1&limit=2', '?unknown=1']) assert.equal((await fetch(base + '/overview' + query, { headers })).status, 400);
  const summary = await (await fetch(base + '/overview?limit=1', { headers })).json();
  assert.equal(summary.documents[0].view, 'summary');
  assert.equal('body_markdown' in summary.documents[0].payload, false);
  const digest = encodeURIComponent(revision.revision_digest);
  const raw = await (await fetch(base + '/revisions/' + digest, { headers })).json();
  assert.deepEqual(raw, revision);
  const view = await (await fetch(base + '/revisions/' + digest + '/view', { headers })).json();
  assert.equal(view.payload.body_markdown, revision.payload.body_markdown);
  const history = await (await fetch(base + '/revisions/' + digest + '/history?limit=1', { headers })).json();
  assert.equal(history.total, 1); assert.equal(history.revisions[0].revision_digest, revision.revision_digest);
  const document = await (await fetch(base + '/documents/doc-http-browse?limit=1', { headers })).json();
  assert.deepEqual(document.revisions, history.revisions);
});

test('proposal pages retain an exact historical revision after a newer revision is published', async t => {
  const { app, actor, configuration, publish } = await fixture(t);
  const policy = configuration.genesis.policies[0];
  const original = await publish(policy.document_id);
  for (let index = 0; index < 23; index++) await app.service.propose(actor, { revision_digest: original.revision_digest,
    policy_id: policy.policy_id, policy_version: 1, command_id: `paged-proposal-${index}` });
  const latest = await publish(policy.document_id, original.revision_digest);
  const overview = await app.service.overview(actor, { proposal_limit: 5 });
  assert.equal(overview.documents[0].revision_digest, latest.revision_digest);
  assert.equal(overview.proposals.length, 5); assert.equal(overview.proposals_total, 23);
  assert.ok(overview.proposals_next_cursor);
  assert.ok(overview.proposals.every((proposal: any) => proposal.revision_summary.revision_digest === original.revision_digest && !('decision_history' in proposal)));
  const selected = await app.service.revisionView(actor, original.revision_digest, { proposal_limit: 5 });
  assert.equal(selected.payload.body_markdown, original.payload.body_markdown);
  const ids = new Set(selected.proposals.map((proposal: any) => proposal.proposal_id));
  let cursor = selected.proposals_next_cursor;
  while (cursor) {
    const page = await app.service.revisionView(actor, original.revision_digest, { proposal_limit: 5, proposal_cursor: cursor });
    for (const proposal of page.proposals) { assert.ok(!ids.has(proposal.proposal_id)); ids.add(proposal.proposal_id); }
    cursor = page.proposals_next_cursor;
  }
  assert.equal(ids.size, 23);
  await assert.rejects(app.service.revisionView(actor, latest.revision_digest, { proposal_cursor: selected.proposals_next_cursor }), (error: any) => error.code === 'INVALID_CURSOR');
});

test('retryable ledger backpressure remains pending and explicit retry reuses the exact command', async t => {
  const { app, actor, configuration, publish } = await fixture(t);
  const policy = configuration.genesis.policies[0]; const revision = await publish(policy.document_id);
  const execute = app.service.ledger.execute.bind(app.service.ledger);
  app.service.ledger.execute = async () => { throw Object.assign(new Error('busy'), { code: 'LEDGER_BUSY', status: 429, retryable: true }); };
  const input = { revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1, command_id: 'review-busy-proposal' };
  await assert.rejects(app.service.propose(actor, input), (error: any) => error.code === 'LEDGER_BUSY');
  assert.equal((await app.service.getCommand(actor, input.command_id)).status, 'pending');
  app.service.ledger.execute = execute;
  const committed = await app.service.retryCommand(actor, input.command_id, {});
  assert.equal(committed.status, 'committed');
  assert.deepEqual((await app.service.retryCommand(actor, input.command_id, {})).checkpoint, committed.checkpoint);
});

test('agreement detail resolves valid IDs containing colons through domain key encoding', async t => {
  const { app, actor, configuration, publish } = await fixture(t); const policy = configuration.genesis.policies[0];
  const revision = await publish(policy.document_id);
  const proposal = await app.service.propose(actor, { revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1, command_id: 'colon-propose' });
  const proposalId = proposal.result.proposal_id;
  for (const identity of configuration.identities) {
    const signer = { org_id: identity.org_id, actor_id: identity.actor_id, kind: identity.kind };
    await app.service.decide(signer, proposalId, { decision: 'approve', rationale: 'Review', command_id: 'colon-approve-' + identity.org_id });
  }
  await app.service.ledger.execute(actor, { command_id: 'colon-activate', type: 'activate', input: {
    proposal_id: proposalId, agreement_id: 'agreement:colon', expected_active_agreement_id: null,
  } });
  const origin = await app.listen(0); const login = await fetch(origin + '/api/session');
  const headers = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
  for (const id of ['agreement:colon', 'agreement%3Acolon']) {
    const response = await fetch(origin + '/v1/workspaces/knowledge/agreements/' + id, { headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).agreement_id, 'agreement:colon');
  }
});
