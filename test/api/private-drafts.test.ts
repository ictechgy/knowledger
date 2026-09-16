import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';

let sequence = 0;

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-private-drafts-test-'));
  const app = await createApp({ dataDir: directory });
  const url = await app.listen(0);
  let closed = false;
  const initial = await fetch(`${url}/api/session`);
  let cookie = initial.headers.get('set-cookie')!.split(';')[0];
  let session = await initial.json() as any;
  const post = async (path: string, input: any, expected = 200) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify(input),
    });
    const value = await response.json() as any;
    assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    if (path === '/api/session' && response.ok) session = value;
    return value;
  };
  const get = async (path: string, expected = 200) => {
    const response = await fetch(`${url}${path}`, { headers: { Cookie: cookie } });
    const value = await response.json() as any;
    assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    return value;
  };
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { app, directory, url, post, get, close, cookie: () => cookie, session: () => session };
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    title: `초안 ${++sequence}`,
    body_markdown: `본문 ${sequence}`,
    context_id: 'context-coordination',
    scope_id: 'scope-order-2026-001',
    usage_scope: 'review-invitation/v1',
    source_kind: 'human_authored',
    ...overrides,
  };
}

test('reopening imported drafts accepts the same Markdown filename boundaries as intake', async t => {
  const api = await fixture(t);
  const imported = await api.post('/v1/workspaces/demo/draft-imports/markdown', {
    import_id: 'reopen-long-filename', filename: `${'x'.repeat(246)}.MARKDOWN`,
    content_base64: Buffer.from('\uFEFF# 원문\r\n본문\r\n').toString('base64'),
    title: '긴 파일명', context_id: 'context-coordination', scope_id: 'scope-order-2026-001', usage_scope: 'review-invitation/v1',
  });
  assert.deepEqual(await api.get(`/v1/workspaces/demo/drafts/${imported.draft_id}`), imported);
});

test('pagination does not silently skip a malformed draft with missing sort metadata', async t => {
  const api = await fixture(t);
  for (let i = 0; i < 3; i++) await api.post('/v1/workspaces/demo/drafts', draft());
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(api.directory, 'private-local.sqlite'));
  const actor = api.session().actor;
  db.prepare('INSERT INTO private_records VALUES (?, ?, ?, ?, ?)').run('draft', 'draft-corrupt-metadata', actor.org_id, actor.actor_id, '{');
  db.close();
  const first = await api.get('/v1/workspaces/demo/drafts?limit=2');
  assert.equal(first.total, 4);
  assert.equal(first.drafts.length, 2);
  const failed = await api.get(`/v1/workspaces/demo/drafts?limit=2&cursor=${first.next_cursor}`, 503);
  assert.equal(failed.code, 'PRIVATE_DRAFT_CORRUPT');
});

test('private draft list and detail are actor-isolated and omit bodies from the list', async t => {
  const api = await fixture(t);
  const anonymous = await fetch(`${api.url}/v1/workspaces/demo/drafts`);
  assert.equal(anonymous.status, 401);
  const first = await api.post('/v1/workspaces/demo/drafts', draft({ title: '비공개 제목', body_markdown: '비공개 본문' }));
  const list = await api.get('/v1/workspaces/demo/drafts');
  assert.equal(list.total, 1);
  assert.equal(list.drafts[0].draft_id, first.draft_id);
  assert.equal(list.drafts[0].title, '비공개 제목');
  assert.equal(list.drafts[0].source_kind, 'human_authored');
  assert.equal(Object.hasOwn(list.drafts[0], 'body_markdown'), false);
  assert.equal(JSON.stringify(list).includes('비공개 본문'), false);
  assert.deepEqual(await api.get(`/v1/workspaces/demo/drafts/${first.draft_id}`), { draft_id: first.draft_id, revision: first.revision });
  await api.post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
  await api.get(`/v1/workspaces/demo/drafts/${first.draft_id}`, 404);
  const other = await api.get('/v1/workspaces/demo/drafts');
  assert.equal(other.total, 0);
});

test('draft list uses bounded keyset pagination and rejects guessed or malformed cursors', async t => {
  const api = await fixture(t);
  for (let i = 0; i < 3; i++) await api.post('/v1/workspaces/demo/drafts', draft({ title: `목록 ${i}` }));
  const page = await api.get('/v1/workspaces/demo/drafts?limit=2');
  assert.equal(page.drafts.length, 2);
  assert.ok(page.next_cursor);
  const next = await api.get(`/v1/workspaces/demo/drafts?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`);
  assert.equal(next.drafts.length, 1);
  assert.equal(next.next_cursor, null);
  await api.post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
  await api.get(`/v1/workspaces/demo/drafts?cursor=${encodeURIComponent(page.next_cursor)}`, 404);
  await api.get('/v1/workspaces/demo/drafts?limit=0', 400);
  await api.get('/v1/workspaces/demo/drafts?limit=51', 400);
  await api.get('/v1/workspaces/demo/drafts?limit=2&limit=3', 400);
  await api.get('/v1/workspaces/demo/drafts?cursor=does-not-belong', 404);
  await api.get('/v1/workspaces/demo/drafts?unknown=x', 400);
});

test('resuming a draft creates an immutable private revision with preserved shared base fields', async t => {
  const api = await fixture(t);
  const original = await api.post('/v1/workspaces/demo/drafts', draft({ title: '원본', body_markdown: '원본 본문' }));
  const edit = { edit_id: 'edit-resume-001', title: '수정본', body_markdown: '수정 본문', source_kind: 'human_authored' };
  const resumed = await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, edit);
  assert.notEqual(resumed.draft_id, original.draft_id);
  assert.notEqual(resumed.revision.revision_digest, original.revision.revision_digest);
  assert.equal(resumed.source_draft_id, original.draft_id);
  assert.equal(resumed.revision.payload.document_id, original.revision.payload.document_id);
  assert.equal(resumed.revision.payload.context_id, original.revision.payload.context_id);
  assert.equal(resumed.revision.payload.scope_id, original.revision.payload.scope_id);
  assert.equal(resumed.revision.payload.usage_scope, original.revision.payload.usage_scope);
  assert.deepEqual(resumed.revision.payload.parents, original.revision.payload.parents);
  assert.deepEqual(resumed.revision.payload.dependencies, original.revision.payload.dependencies);
  assert.equal(resumed.revision.payload.metadata.author_id, api.session().actor.actor_id);
  assert.deepEqual(await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, edit), resumed);
  assert.deepEqual((await Promise.all([
    api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, edit),
    api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, edit),
  ]))[0], resumed);
  const secondSource = await api.post('/v1/workspaces/demo/drafts', draft({ title: '두 번째 원본' }));
  await api.post(`/v1/workspaces/demo/drafts/${secondSource.draft_id}/edits`, edit, 409);
  await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { ...edit, title: '충돌' }, 409);
  assert.deepEqual(await api.get(`/v1/workspaces/demo/drafts/${original.draft_id}`), { draft_id: original.draft_id, revision: original.revision });
});

test('resume rejects unknown or other-actor drafts and protects writes with CSRF', async t => {
  const api = await fixture(t);
  const original = await api.post('/v1/workspaces/demo/drafts', draft());
  await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { edit_id: 'edit-initial', title: '수정', body_markdown: '수정' }, 200);
  await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { edit_id: 'edit-invalid', title: '', body_markdown: '본문' }, 400);
  await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { edit_id: 'edit-invalid-kind', title: '제목', body_markdown: '본문', source_kind: 'forged' }, 400);
  await api.post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' });
  await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { edit_id: 'edit-other', title: '타인', body_markdown: '타인' }, 404);
  const noCsrf = await fetch(`${api.url}/v1/workspaces/demo/drafts/${original.draft_id}/edits`, { method: 'POST', headers: { Cookie: api.cookie(), Origin: api.url, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
});

test('resuming manual and imported drafts keeps the original slot and does not copy import provenance', async t => {
  const api = await fixture(t);
  const overview = await api.get('/v1/workspaces/demo/overview');
  const base = overview.documents.find((item: any) => item.payload.document_id === 'doc-review-invitation-001');
  const manual = await api.post('/v1/workspaces/demo/drafts', draft({ base_revision_digest: base.revision_digest, title: '공유 기반 원본' }));
  const imported = await api.post('/v1/workspaces/demo/draft-imports/markdown', {
    import_id: `resume-import-${++sequence}`, filename: 'resume.md', content_base64: Buffer.from('가져온 본문').toString('base64'),
    title: '가져온 원본', base_revision_digest: base.revision_digest,
  });
  const manualEdit = await api.post(`/v1/workspaces/demo/drafts/${manual.draft_id}/edits`, { edit_id: 'edit-manual', title: '수정 수동', body_markdown: '수정 수동 본문' });
  const importedEdit = await api.post(`/v1/workspaces/demo/drafts/${imported.draft_id}/edits`, { edit_id: 'edit-imported', title: '수정 가져옴', body_markdown: '수정 가져온 본문' });
  for (const [original, edited] of [[manual, manualEdit], [imported, importedEdit]]) {
    assert.equal(edited.revision.payload.document_id, original.revision.payload.document_id);
    assert.equal(edited.revision.payload.context_id, original.revision.payload.context_id);
    assert.equal(edited.revision.payload.scope_id, original.revision.payload.scope_id);
    assert.equal(edited.revision.payload.usage_scope, original.revision.payload.usage_scope);
    assert.deepEqual(edited.revision.payload.parents, original.revision.payload.parents);
    assert.deepEqual(edited.revision.payload.dependencies, original.revision.payload.dependencies);
    assert.equal(JSON.stringify(edited.revision).includes(imported.import.sha256), false);
  }
  assert.equal((await api.get(`/v1/workspaces/demo/drafts/${importedEdit.draft_id}`)).import, undefined);
});

test('private draft index survives restart and corrupt stored detail fails closed', async t => {
  const api = await fixture(t);
  const original = await api.post('/v1/workspaces/demo/drafts', draft({ title: '재시작 초안' }));
  const directory = api.directory;
  await api.close();
  const reopened = await createApp({ dataDir: directory });
  const url = await reopened.listen(0);
  try {
    const initial = await fetch(`${url}/api/session`);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const list = await fetch(`${url}/v1/workspaces/demo/drafts`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).drafts[0].draft_id, original.draft_id);
  } finally { await reopened.close(); }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'private-local.sqlite'));
  db.prepare('UPDATE private_records SET value_json = ? WHERE kind = ? AND record_id = ?').run('{"revision":', 'draft', original.draft_id);
  db.close();
  const corrupted = await createApp({ dataDir: directory });
  const corruptedUrl = await corrupted.listen(0);
  try {
    const initial = await fetch(`${corruptedUrl}/api/session`);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const list = await fetch(`${corruptedUrl}/v1/workspaces/demo/drafts`, { headers: { Cookie: cookie } });
    assert.equal(list.status, 503);
    assert.equal((await list.json()).code, 'PRIVATE_DRAFT_CORRUPT');
    const response = await fetch(`${corruptedUrl}/v1/workspaces/demo/drafts/${original.draft_id}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'PRIVATE_DRAFT_CORRUPT');
  } finally { await corrupted.close(); }
});

test('expression pagination keeps equal timestamp order stable when a new draft is inserted', async t => {
  const api = await fixture(t);
  const originals = [];
  for (let i = 0; i < 3; i++) originals.push(await api.post('/v1/workspaces/demo/drafts', draft({ title: `동시각 ${i}` })));
  const directory = api.directory;
  await api.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(directory, 'private-local.sqlite'));
  const rows = db.prepare("SELECT record_id, value_json FROM private_records WHERE kind = 'draft' ORDER BY record_id").all() as any[];
  for (const row of rows) {
    const value = JSON.parse(row.value_json);
    value.revision.payload.metadata.created_at = '2026-01-01T00:00:00.000Z';
    db.prepare('UPDATE private_records SET value_json = ? WHERE kind = ? AND record_id = ?').run(JSON.stringify(value), 'draft', row.record_id);
  }
  db.exec('DROP INDEX IF EXISTS private_draft_actor_order');
  db.close();
  const reopened = await createApp({ dataDir: directory });
  const url = await reopened.listen(0);
  try {
    const initial = await fetch(`${url}/api/session`);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const session = await initial.json() as any;
    const headers = { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token };
    const first = await (await fetch(`${url}/v1/workspaces/demo/drafts?limit=2`, { headers: { Cookie: cookie } })).json() as any;
    assert.deepEqual(first.drafts.map((item: any) => item.draft_id), originals.map(item => item.draft_id).sort().reverse().slice(0, 2));
    await fetch(`${url}/v1/workspaces/demo/drafts`, { method: 'POST', headers, body: JSON.stringify(draft({ title: '페이지 사이 신규' })) });
    const second = await (await fetch(`${url}/v1/workspaces/demo/drafts?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`, { headers: { Cookie: cookie } })).json() as any;
    assert.equal(second.drafts.some((item: any) => item.title === '페이지 사이 신규'), false);
    assert.deepEqual(second.drafts.map((item: any) => item.draft_id), [originals.map(item => item.draft_id).sort()[0]]);
  } finally { await reopened.close(); }
});

test('resumed edit idempotency survives a service restart', async t => {
  const api = await fixture(t);
  const original = await api.post('/v1/workspaces/demo/drafts', draft({ title: '재시작 원본' }));
  const edit = { edit_id: 'edit-restart-001', title: '재시작 수정', body_markdown: '재시작 본문' };
  const first = await api.post(`/v1/workspaces/demo/drafts/${original.draft_id}/edits`, edit);
  const directory = api.directory;
  await api.close();
  const reopened = await createApp({ dataDir: directory });
  const url = await reopened.listen(0);
  try {
    const initial = await fetch(`${url}/api/session`);
    const cookie = initial.headers.get('set-cookie')!.split(';')[0];
    const session = await initial.json() as any;
    const response = await fetch(`${url}/v1/workspaces/demo/drafts/${original.draft_id}/edits`, {
      method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': session.csrf_token }, body: JSON.stringify(edit),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), first);
  } finally { await reopened.close(); }
});
