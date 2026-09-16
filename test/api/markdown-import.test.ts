import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';

const route = '/v1/workspaces/demo/draft-imports/markdown';
let sequence = 0;

function base64(value: Uint8Array | string): string {
  return Buffer.from(value).toString('base64');
}

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-markdown-import-test-'));
  const app = await createApp({ dataDir: directory });
  const url = await app.listen(0);
  let closed = false;
  let cookie = '';
  let session: any;
  const refreshSession = async () => {
    const response = await fetch(`${url}/api/session`, { headers: cookie ? { Cookie: cookie } : {} });
    session = await response.json();
    cookie ||= response.headers.get('set-cookie')!.split(';')[0];
  };
  await refreshSession();
  const post = async (path: string, input: any, expected = 200) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify(input),
    });
    const value = await response.json() as any;
    assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    if (path === '/api/session' && response.ok) session = value;
    return value;
  };
  t.after(async () => { if (!closed) await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  return { app, directory, url, post, close, cookie: () => cookie, session: () => session, switchActor: (actor_id: string) => post('/api/session', { org_id: actor_id === 'person-settlement-owner' ? 'SettlementMSP' : 'FulfillmentMSP', actor_id }) };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    import_id: `markdown-import-${++sequence}`,
    filename: 'delivery.md',
    content_base64: base64('\uFEFF# 배송\r\n\r\n본문\r\n'),
    title: '가져온 배송 문서',
    context_id: 'context-coordination',
    scope_id: 'scope-order-2026-001',
    usage_scope: 'review-invitation/v1',
    ...overrides,
  };
}

test('Markdown import preserves UTF-8 bytes and stays private until publication', async t => {
  const api = await fixture(t);
  const input = request();
  const beforeImport = api.app.service.ledger.checkpoint();
  const imported = await api.post(route, input);
  assert.deepEqual(api.app.service.ledger.checkpoint(), beforeImport);
  const expectedBytes = Buffer.from(input.content_base64, 'base64');
  assert.equal(imported.import.kind, 'local_markdown');
  assert.equal(imported.import.filename, input.filename);
  assert.equal(imported.import.byte_length, expectedBytes.byteLength);
  assert.equal(imported.import.sha256, createHash('sha256').update(expectedBytes).digest('hex'));
  assert.equal(imported.revision.payload.body_markdown, '\uFEFF# 배송\r\n\r\n본문\r\n');
  assert.equal(imported.revision.payload.metadata.source_kind, 'approved_import');
  assert.equal(Object.hasOwn(imported.revision.payload, 'filename'), false);
  assert.equal(JSON.stringify(imported.revision).includes(input.import_id), false);
  assert.equal(JSON.stringify(api.app.service.ledger.events(0, 1000)).includes(input.import_id), false);
  assert.equal((await api.post('/v1/workspaces/demo/search', { query: '본문' })).results.length, 0);

  const beforePreview = api.app.service.ledger.checkpoint();
  const preview = await api.post('/v1/workspaces/demo/publication-previews', { draft_id: imported.draft_id });
  assert.deepEqual(api.app.service.ledger.checkpoint(), beforePreview);
  const unconfirmed = await api.post('/v1/workspaces/demo/revisions', { preview_id: preview.preview_id, command_id: `command-unconfirmed-${sequence}` }, 400);
  assert.equal(unconfirmed.code, 'PUBLICATION_CONFIRMATION_REQUIRED');
  await api.post('/v1/workspaces/demo/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: `command-import-${sequence}` });
  const events = JSON.stringify(api.app.service.ledger.events(0, 1000));
  assert.equal(events.includes(input.import_id), false);
  assert.equal(events.includes(input.filename), false);
  assert.equal(events.includes(imported.import.sha256), false);
  assert.equal((await api.post('/v1/workspaces/demo/search', { query: '본문' })).results.length, 1);
});

test('Markdown import is idempotent across restart and conflicts on changed input', async t => {
  const api = await fixture(t);
  const input = request({ import_id: 'stable-import-001' });
  const first = await api.post(route, input);
  const retry = await api.post(route, input);
  assert.deepEqual(retry, first);
  const concurrent = await Promise.all([api.post(route, input), api.post(route, input)]);
  assert.deepEqual(concurrent[0], first);
  assert.deepEqual(concurrent[1], first);
  await api.post(route, { ...input, title: '바뀐 제목' }, 409);
  const eventsBefore = api.app.service.ledger.events(0, 1000).length;
  await api.close();
  const reopened = await createApp({ dataDir: api.directory });
  try {
    const url = await reopened.listen(0);
    const initial = await fetch(`${url}/api/session`);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const session = await initial.json() as any;
    const response = await fetch(`${url}${route}`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), first);
    assert.equal(reopened.service.ledger.events(0, 1000).length, eventsBefore);
  } finally {
    await reopened.close();
  }
});

test('Markdown import is isolated by actor and rejects auth, fields, names, encoding, and size violations', async t => {
  const api = await fixture(t);
  const input = request({ import_id: 'actor-isolated-001' });
  const anonymous = await fetch(`${api.url}${route}`, { method: 'POST', headers: { Origin: api.url, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(anonymous.status, 401);
  const noCsrf = await fetch(`${api.url}${route}`, { method: 'POST', headers: { Cookie: api.cookie(), Origin: api.url, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(noCsrf.status, 403);
  const first = await api.post(route, input);
  await api.switchActor('person-settlement-owner');
  const second = await api.post(route, input);
  assert.notEqual(second.draft_id, first.draft_id);
  await api.post('/v1/workspaces/demo/publication-previews', { draft_id: first.draft_id }, 404);

  await api.post(route, { ...request(), actor: 'forged', import_id: 'extra-field-001' }, 400);
  await api.post(route, { ...request(), filename: '../delivery.md' }, 400);
  await api.post(route, { ...request(), filename: 'delivery\n.md' }, 400);
  await api.post(route, { ...request(), filename: 'delivery\t.md' }, 400);
  await api.post(route, { ...request(), filename: 'delivery.txt' }, 400);
  await api.post(route, { ...request(), content_base64: base64(new Uint8Array([0xc3, 0x28])) }, 400);
  await api.post(route, { ...request(), content_base64: base64(new Uint8Array([0])) }, 400);
  await api.post(route, { ...request(), content_base64: `${base64('valid')}=` }, 400);
  await api.post(route, { ...request(), content_base64: base64(new Uint8Array(256 * 1024 + 1).fill(0x61)) }, 400);
  await api.post(route, { ...request(), base_revision_digest: '' }, 400);

  await api.switchActor('agent-knowledge-drafter');
  const agentImport = await api.post(route, request({ import_id: 'agent-intake-001' }));
  assert.equal(agentImport.revision.payload.metadata.source_kind, 'approved_import');
});

test('Markdown import accepts the size boundary and treats frontmatter and links as inert content', async t => {
  const api = await fixture(t);
  const header = '\uFEFF---\r\ncontext_id: context-settlement\r\nactor_id: person-settlement-owner\r\nsource_kind: human_authored\r\napproval: approved\r\n---\r\n# 가져오기\r\n[원문](file:///unread-local-source.md)\r\n![그림](https://example.invalid/unfetched.png)\r\n';
  const bytes = Buffer.concat([Buffer.from(header), Buffer.alloc(262144 - Buffer.byteLength(header), 0x61)]);
  const input = request({ filename: '가'.repeat(84) + '.md', content_base64: bytes.toString('base64') });
  const before = api.app.service.ledger.checkpoint();
  const imported = await api.post(route, input);
  assert.equal(imported.import.byte_length, 262144);
  assert.deepEqual(Buffer.from(imported.revision.payload.body_markdown), bytes);
  assert.equal(imported.revision.payload.context_id, input.context_id);
  assert.equal(imported.revision.payload.metadata.author_id, api.session().actor.actor_id);
  assert.equal(imported.revision.payload.metadata.source_kind, 'approved_import');
  assert.deepEqual(imported.revision.payload.dependencies, []);
  assert.deepEqual(api.app.service.ledger.checkpoint(), before);
  await api.post(route, request({ filename: '가'.repeat(85) + '.md' }), 400);
});

test('Markdown import retains base revision slot and dependencies without importing provenance', async t => {
  const api = await fixture(t);
  const overview = await (await fetch(`${api.url}/v1/workspaces/demo/overview`, { headers: { Cookie: api.cookie() } })).json() as any;
  const base = overview.documents.find((item: any) => item.payload.document_id === 'doc-review-invitation-001');
  const imported = await api.post(route, request({ import_id: 'base-import-001', base_revision_digest: base.revision_digest, document_id: 'doc-forged-ignored', context_id: 'context-sales', scope_id: 'scope-sales', usage_scope: 'domain-definition/v1' }));
  assert.equal(imported.revision.payload.document_id, base.payload.document_id);
  assert.equal(imported.revision.payload.context_id, base.payload.context_id);
  assert.equal(imported.revision.payload.scope_id, base.payload.scope_id);
  assert.equal(imported.revision.payload.usage_scope, base.payload.usage_scope);
  assert.deepEqual(imported.revision.payload.dependencies, base.payload.dependencies);
  assert.deepEqual(imported.revision.payload.parents, [base.revision_digest]);
  assert.equal(JSON.stringify(imported.revision).includes('base-import-001'), false);
});
