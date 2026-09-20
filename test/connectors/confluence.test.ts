import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createDevelopmentClient } from '../../packages/connectors/development-client.ts';
import { readConfluenceSource, syncConfluenceSource } from '../../packages/connectors/confluence.ts';
import { confluenceAdfToMarkdown } from '../../packages/connectors/confluence-adf.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';

const CLOUD = '11111111-1111-1111-1111-111111111111';
const doc = (text = 'Shared source') => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
function source(overrides: any = {}) {
  let version = 1; let adf: any = doc(); const calls: { url: string; input: any }[] = [];
  const options = { source_id: 'confluence-pilot', cloud_id: CLOUD, pages: [{ page_id: '123', policy_id: 'policy-shared-guideline', policy_version: 1 }],
    allows: async () => true, getAccessToken: async () => 'FIXTURE_TOKEN', fetch: async (url: string, input: any) => {
      calls.push({ url, input }); return new Response(JSON.stringify({ id: '123', status: 'current', title: 'Confluence fixture', ownerId: 'PRIVATE_VENDOR_OWNER', version: { number: version },
        body: { atlas_doc_format: { value: JSON.stringify(adf), representation: 'atlas_doc_format' } } }), { headers: { 'Content-Type': 'application/json' } });
    }, ...overrides };
  return { options, calls, setVersion(value: number) { version = value; }, setAdf(value: any) { adf = value; } };
}
async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-confluence-')); let dataDir = join(root, 'runtime'); const config = createProjectTemplate();
  let app = await createConfiguredApp(config, { dataDir, port: 0 }); let origin = await app.listen(0);
  let client = await createDevelopmentClient({ baseUrl: origin, workspaceId: config.workspace.id, orgId: config.bootstrap_actor.org_id, actorId: config.bootstrap_actor.actor_id });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  return { get app() { return app; }, get client() { return client; }, get origin() { return origin; }, config,
    async restore() { await app.close(); const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir, snapshotDir }); dataDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir, snapshotDir }); app = await createConfiguredApp(config, { dataDir, port: 0 }); origin = await app.listen(0); client = await createDevelopmentClient({ baseUrl: origin, workspaceId: config.workspace.id, orgId: config.bootstrap_actor.org_id, actorId: config.bootstrap_actor.actor_id }); } };
}

test('Confluence allowlist uses a fixed OAuth endpoint and rechecks the same page before returning a snapshot', async () => {
  const f = source(); const snapshot = await readConfluenceSource(f.options);
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) { assert.equal(call.url, `https://api.atlassian.com/ex/confluence/${CLOUD}/wiki/api/v2/pages/123?body-format=atlas_doc_format`); assert.equal(call.input.method, 'GET'); assert.equal(call.input.redirect, 'error'); }
  assert.equal(snapshot.files[0].origin.page_version, 1); assert.equal(snapshot.files[0].mapping.path, 'confluence/123.md');
  assert.equal(Buffer.from(snapshot.files[0].content_base64, 'base64').toString(), 'Shared source\n');
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_VENDOR_OWNER'), false); assert.equal(JSON.stringify(snapshot).includes('FIXTURE_TOKEN'), false);
});

test('ADF conversion preserves supported text and rejects unsupported nodes, unsafe links and malformed documents', () => {
  const converted = confluenceAdfToMarkdown({ type: 'doc', version: 1, content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'strong' }] }, { type: 'hardBreak' }, { type: 'text', text: '<script>' }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Item' }] }] }] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: '```\ncode' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [{ type: 'link', attrs: { href: 'https://example.invalid/a(b)' } }] }] },
  ] });
  assert.match(converted, /## Heading/); assert.match(converted, /\*\*Bold\*\*/); assert.match(converted, /- Item/);
  assert.match(converted, /````js/); assert.match(converted, /a%28b%29/); assert.equal(converted.includes('<script>'), false);
  for (const value of [{ type: 'paragraph', content: [] }, { ...doc(), version: 2 }, doc('\ud800'), doc('\u0085'), { ...doc(), content: [{ type: 'extension', attrs: { text: 'Never silently skip' } }] },
    { ...doc(), content: [{ type: 'paragraph', content: [{ type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }] }] }]) assert.throws(() => confluenceAdfToMarkdown(value));
});

test('permission loss, missing pages and unsupported content cause zero private writes', async () => {
  let writes = 0; const client: any = { request: async () => { writes++; throw new Error('No call expected'); } };
  for (const status of [401, 403, 404]) {
    const f = source({ fetch: async () => new Response('PRIVATE_ERROR_TOKEN', { status }) });
    await assert.rejects(syncConfluenceSource(client, f.options), (e: any) => e.code === 'CONFLUENCE_NOT_ACCESSIBLE' && !String(e).includes('PRIVATE'));
  }
  const denied = source({ allows: async () => false }); await assert.rejects(syncConfluenceSource(client, denied.options)); assert.equal(denied.calls.length, 0);
  const invalid = source(); invalid.setAdf({ ...doc(), content: [{ type: 'mediaSingle', content: [] }] });
  await assert.rejects(syncConfluenceSource(client, invalid.options), (e: any) => e.code === 'CONFLUENCE_UNSUPPORTED_CONTENT' && !e.retryable);
  assert.equal(writes, 0);
});

test('page changes during reread reject the entire source snapshot', async () => {
  const f = source(); const fetch = f.options.fetch; let calls = 0;
  f.options.fetch = async (url: string, input: any) => { if (++calls === 2) f.setVersion(2); return fetch(url, input); };
  await assert.rejects(readConfluenceSource(f.options), (e: any) => e.code === 'CONFLUENCE_SOURCE_CHANGED');
});

test('Confluence sync creates private drafts with provenance, skips unchanged input and retains immutable previous drafts', async t => {
  const f = await fixture(t); const sourceFixture = source(); const before = f.app.service.ledger.checkpoint();
  const first = await syncConfluenceSource(f.client, sourceFixture.options); assert.equal(first.counts.imported, 1);
  const entry = first.source.entries[0]; const original = await f.app.service.getDraft(f.config.bootstrap_actor, entry.draft_id);
  assert.equal(original.source.origin.page_version, 1); assert.equal(original.source.origin.cloud_id, CLOUD);
  assert.equal(JSON.stringify(original.revision).includes(CLOUD), false); assert.equal(JSON.stringify(original.revision).includes('adf_sha256'), false);
  const repeat = await syncConfluenceSource(f.client, sourceFixture.options); assert.equal(repeat.counts.skipped, 1); assert.equal(repeat.source.version, first.source.version);
  sourceFixture.setVersion(2);
  const changed = await syncConfluenceSource(f.client, sourceFixture.options); assert.equal(changed.counts.imported, 1); assert.notEqual(changed.source.entries[0].draft_id, entry.draft_id);
  assert.equal((await f.app.service.getDraft(f.config.bootstrap_actor, entry.draft_id)).source.origin.page_version, 1);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before); assert.equal(f.app.service.values('revision').length, 0);
  const foreign = await createDevelopmentClient({ baseUrl: f.origin, workspaceId: f.config.workspace.id, orgId: 'OrgTwoMSP', actorId: 'maintainer' });
  await assert.rejects(foreign.request('/sources/confluence-pilot', {}), (e: any) => e.status === 404);
  await f.restore(); assert.deepEqual(await f.client.request('/sources/confluence-pilot', {}), changed.source);
});

test('HTTP provenance is idempotent, privately retained and cannot silently change cloud or regress upstream version', async t => {
  const f = await fixture(t); const provider = source(); const snapshot = await readConfluenceSource(provider.options); const file = snapshot.files[0];
  const input = { operation_id: 'confluence-import-one', expected_version: 0, ...file.mapping, content_base64: file.content_base64, origin: file.origin };
  const first: any = await f.client.request('/sources/confluence-pilot/confluence', { method: 'POST', body: input });
  assert.deepEqual(await f.client.request('/sources/confluence-pilot/confluence', { method: 'POST', body: input }), first);
  await assert.rejects(f.client.request('/sources/confluence-pilot/confluence', { method: 'POST', body: { ...input, origin: { ...input.origin, page_version: 2 } } }), (e: any) => e.status === 409);
  provider.setVersion(2); await syncConfluenceSource(f.client, provider.options); provider.setVersion(1);
  await assert.rejects(syncConfluenceSource(f.client, provider.options), (e: any) => e.code === 'CONFLUENCE_VERSION_CONFLICT');
  await assert.rejects(f.client.request('/sources/confluence-pilot/confluence', { method: 'POST', body: { ...input, operation_id: 'another-request', expected_version: 2 } }), (e: any) => e.code === 'CONFLUENCE_VERSION_CONFLICT');
  await assert.rejects(f.client.request('/sources/confluence-pilot/confluence', { method: 'POST', body: { ...input, operation_id: 'foreign-cloud', expected_version: 2, origin: { ...input.origin, cloud_id: '22222222-2222-2222-2222-222222222222' } } }), (e: any) => e.code === 'SOURCE_ORIGIN_CONFLICT');
  await assert.rejects(f.client.request('/sources/confluence-pilot/markdown', { method: 'POST', body: input }), (e: any) => e.status === 400);
});

test('response loss reuses the committed private draft, and explicit allowlist removal does not withdraw shared knowledge', async t => {
  const f = await fixture(t); const provider = source(); let lost = false;
  const client = { request: async <T>(path: string, options: any): Promise<T> => {
    const result = await f.client.request<T>(path, options); if (path.endsWith('/confluence') && !lost) { lost = true; throw new Error('Fictional lost response'); } return result;
  } };
  await assert.rejects(syncConfluenceSource(client, provider.options)); const retry = await syncConfluenceSource(f.client, provider.options);
  assert.equal(retry.counts.skipped, 1); assert.equal((await f.app.service.listDrafts(f.config.bootstrap_actor, 20)).total, 1);
  const draft = retry.source.entries[0].draft_id; const preview = await f.app.service.preview(f.config.bootstrap_actor, { draft_id: draft });
  await f.app.service.publish(f.config.bootstrap_actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'explicit-publish' });
  const before = f.app.service.ledger.checkpoint(); provider.options.pages = [];
  const removed = await syncConfluenceSource(f.client, provider.options); assert.equal(removed.counts.removed, 1);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before); assert.equal(f.app.service.values('revision').length, 1);
});

test('timeouts and byte limits prevent late reads and never disclose provider diagnostics', async () => {
  let release!: (token: string) => void; const delayed = source({ timeoutMs: 20, getAccessToken: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(readConfluenceSource(delayed.options), (e: any) => e.code === 'CONFLUENCE_TIMEOUT');
  release('FIXTURE_TOKEN'); await delay(10); assert.equal(delayed.calls.length, 0);
  const huge = source({ fetch: async () => new Response('x'.repeat(1024 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(readConfluenceSource(huge.options), (e: any) => e.code === 'INVALID_CONFLUENCE_RESPONSE');
  const tokenError = source({ getAccessToken: () => { throw new Error('SECRET_PROVIDER_TOKEN'); } });
  await assert.rejects(readConfluenceSource(tokenError.options), (e: any) => !String(e).includes('SECRET') && !JSON.stringify(e).includes('SECRET'));
});

test('unsupported and duplicate page mappings fail before network access', async () => {
  for (const change of [{ cloud_id: 'https://untrusted.invalid' }, { pages: [{ page_id: '../secret', policy_id: 'policy-shared-guideline', policy_version: 1 }] },
    { pages: Array(101).fill({ page_id: '123', policy_id: 'policy-shared-guideline', policy_version: 1 }) },
    { pages: Array(2).fill({ page_id: '123', policy_id: 'policy-shared-guideline', policy_version: 1 }) }]) {
    const f = source(change); await assert.rejects(readConfluenceSource(f.options)); assert.equal(f.calls.length, 0);
  }
});
