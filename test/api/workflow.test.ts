import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';
import { actorIdentity, PERSONAS } from '../../examples/order-workflow/config.ts';

const mappingId = 'doc-review-invitation-001';
const proposalId = 'proposal-review-invitation-001';
const mappingScope = { document_ids: [mappingId], context_id: 'context-coordination', scope_id: 'scope-order-2026-001', usage_scope: 'review-invitation/v1' };
let sequence = 0;
const commandId = () => `command-test-${++sequence}`;

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-api-test-'));
  const app = await createApp({ dataDir: directory });
  const url = await app.listen(0);
  const initial = await fetch(`${url}/api/session`);
  let cookie = initial.headers.get('set-cookie')!.split(';')[0];
  let session = await initial.json() as any;
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const post = async (path: string, input: any, expected = 200) => {
    const response = await fetch(`${url}${path.startsWith('/api/') ? path : '/v1/workspaces/demo' + path}`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-KCL-CSRF': session.csrf_token, Origin: url }, body: JSON.stringify(input) });
    const value = await response.json() as any;
    assert.equal(response.status, expected, `request ${path} returned ${value.code ?? value.status}`);
    if (path === '/api/session' && response.ok) session = value;
    return value;
  };
  const get = async (path: string) => {
    const response = await fetch(`${url}/v1/workspaces/demo${path}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200);
    return await response.json() as any;
  };
  const approve = async () => {
    await post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: '물류 조건 확인', command_id: commandId() });
    await post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
    await post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: '정산 조건 확인', command_id: commandId() });
    return await post(`/agreement-proposals/${proposalId}/activate`, { expected_active_agreement_id: null, command_id: commandId() });
  };
  return { app, directory, url, post, get, approve, cookie: () => cookie, session: () => session };
}

test('three domain definitions coexist while unapproved cross-context knowledge is withheld', async t => {
  const api = await fixture(t);
  const overview = await api.get('/overview');
  assert.equal(overview.mode, 'local-simulation');
  assert.equal(overview.documents.length, 4);
  assert.equal(overview.documents.filter((item: any) => item.eligible).length, 3);
  const result = await api.post('/resolve', mappingScope);
  assert.equal(result.status, 'withheld');
  assert.deepEqual(result.documents, []);
});

test('required approvals activate exact knowledge; dependency withdrawal withholds later use', async t => {
  const api = await fixture(t);
  const incomplete = await api.post(`/agreement-proposals/${proposalId}/activate`, { expected_active_agreement_id: null, command_id: commandId() }, 409);
  assert.equal(incomplete.code, 'APPROVAL_INCOMPLETE');
  await api.approve();
  const packet = await api.post('/resolve', { ...mappingScope, query: 'PRIVATE_QUERY_CANARY_123' });
  assert.equal(packet.status, 'provided');
  assert.match(packet.documents[0].body_markdown, /배송 완료/);
  assert.equal(packet.manifest.approval_decisions.length, 2);
  assert.match(packet.manifest.checkpoint.transaction_id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(api.app.service.ledger.events(0, 1000)).includes('PRIVATE_QUERY_CANARY_123'), false);
  const valid = await api.post(`/runs/${packet.manifest.run_id}/revalidate`, { action: 'use-context' });
  assert.equal(valid.status, 'valid');
  await api.post('/agreements/agreement-settlement-001/withdraw', { reason: '정산 정의 재검토', command_id: commandId() });
  const withheld = await api.post(`/runs/${packet.manifest.run_id}/revalidate`, { action: 'use-context' });
  assert.equal(withheld.status, 'withheld');
  assert.equal((await api.post('/resolve', mappingScope)).status, 'withheld');
});

test('private drafts do not leak to shared search/events and another persona cannot publish them', async t => {
  const api = await fixture(t);
  const overview = await api.get('/overview');
  const mapping = overview.documents.find((item: any) => item.payload.document_id === mappingId);
  const draft = await api.post('/drafts', { base_revision_digest: mapping.revision_digest, title: 'PRIVATE_TITLE_CANARY', body_markdown: 'PRIVATE_BODY_CANARY', source_kind: 'human_authored' });
  const results = await api.post('/search', { query: 'PRIVATE_BODY_CANARY' });
  assert.equal(results.results.length, 0);
  assert.equal(JSON.stringify(api.app.service.ledger.events(0, 1000)).includes('PRIVATE_'), false);
  await api.post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
  await api.post('/publication-previews', { draft_id: draft.draft_id }, 404);
  await api.post('/api/session', { org_id: 'FulfillmentMSP', actor_id: 'person-fulfillment-owner' });
  const preview = await api.post('/publication-previews', { draft_id: draft.draft_id });
  assert.equal(preview.recipients.length, 3);
  await api.post('/revisions', { preview_id: preview.preview_id, confirm_shared: false, command_id: commandId() }, 400);
  assert.equal((await api.post('/search', { query: 'PRIVATE_BODY_CANARY' })).results.length, 0);
  await api.post('/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: commandId() });
  assert.equal((await api.post('/search', { query: 'PRIVATE_BODY_CANARY' })).results.length, 1);
  assert.equal((await api.post('/resolve', mappingScope)).status, 'withheld');
});

test('HTTP retries reuse generated decision IDs and timestamps, changed payload conflicts', async t => {
  const api = await fixture(t);
  const input = { decision: 'approve', rationale: '책임자 확인', command_id: commandId() };
  const first = await api.post(`/agreement-proposals/${proposalId}/decisions`, input);
  await api.post('/resolve', mappingScope);
  const count = api.app.service.ledger.events(0, 1000).length;
  const retry = await api.post(`/agreement-proposals/${proposalId}/decisions`, input);
  assert.deepEqual(retry.result, first.result);
  assert.deepEqual(retry.checkpoint, first.checkpoint);
  assert.equal(api.app.service.ledger.events(0, 1000).length, count);
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { ...input, decision: 'object' }, 409);
});

test('command IDs are scoped by organization rather than globally in the local outbox', async t => {
  const api = await fixture(t);
  const id = commandId();
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: '물류 확인', command_id: id });
  await api.post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: '정산 확인', command_id: id });
});

test('manifest cites the exact latest approvals used for activation', async t => {
  const api = await fixture(t);
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: '초기 검토', command_id: commandId() });
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'object', rationale: '추가 검토', command_id: commandId() });
  await api.approve();
  const packet = await api.post('/resolve', mappingScope);
  assert.equal(packet.status, 'provided');
  assert.equal(packet.manifest.approval_decisions.length, 2);
});

test('agent personas cannot approve and cross-origin / no-CSRF mutations are blocked', async t => {
  const api = await fixture(t);
  await api.post('/api/session', { org_id: 'FulfillmentMSP', actor_id: 'agent-knowledge-drafter' });
  await api.post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: 'AI self approval', command_id: commandId() }, 403);
  const route = `${api.url}/v1/workspaces/demo/drafts`;
  const noCsrf = await fetch(route, { method: 'POST', headers: { Cookie: api.cookie(), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  const malformedCsrf = await fetch(route, { method: 'POST', headers: { Cookie: api.cookie(), 'Content-Type': 'application/json', 'X-KCL-CSRF': 'x'.repeat(64) }, body: '{}' });
  assert.equal(malformedCsrf.status, 403);
  const otherOrigin = await fetch(route, { method: 'POST', headers: { Cookie: api.cookie(), 'Content-Type': 'application/json', 'X-KCL-CSRF': api.session().csrf_token, Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(otherOrigin.status, 403);
  const noSession = await fetch(`${api.url}/v1/workspaces/demo/overview`);
  assert.equal(noSession.status, 401);
});

test('reopening the ledger replays committed views without reseeding duplicate effects', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-restart-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let app = await createApp({ dataDir: directory });
  const before = await app.service.overview(actorIdentity(PERSONAS[1]));
  const count = app.service.ledger.events(0, 1000).length;
  await app.close();
  app = await createApp({ dataDir: directory });
  try {
    const after = await app.service.overview(actorIdentity(PERSONAS[1]));
    assert.deepEqual(after, before);
    assert.equal(app.service.ledger.events(0, 1000).length, count);
  } finally { await app.close(); }
});
