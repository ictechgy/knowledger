import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test = base.extend({ workspace: async ({}, use) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-browser-dependencies-'));
  const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'dependency-browser');
  const template = config.genesis.policies[0];
  config.genesis.policies = ['source', 'target'].map(name => ({ ...structuredClone(template), policy_id: `policy-${name}`, document_id: `doc-${name}`, scope_id: `scope-${name}`, acceptance_slot: `slot-${name}` }));
  const app = await createConfiguredApp(config, { dataDir, port: 0 });
  const origin = await app.listen(0); const actor = config.bootstrap_actor; let sequence = 0;
  const publish = async (name, title, dependencies = [], documentId = `doc-${name}`) => {
    const draft = await app.service.draft(actor, { document_id: documentId, context_id: 'context-shared', scope_id: `scope-${name}`, usage_scope: 'reference/v1', title, body_markdown: `# ${title}`, dependencies });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `browser-dep-publish-${++sequence}` });
    return draft.revision;
  };
  const source = await publish('source', 'Source <img src=x onerror=alert(1)>');
  try { await use({ app, origin, actor, source, publish }); }
  finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
} });

async function openComposer(page, workspace) {
  await page.goto(workspace.origin); await expect(page.locator('#persona-select')).toBeEnabled();
  await page.getByRole('button', { name: '새 지식 문서 작성', exact: true }).click();
  await page.locator('#draft-policy').selectOption('policy-target|1');
  await page.locator('#draft-title').fill('Target document'); await page.locator('#draft-body').fill('# Dependent target');
  await expect(page.locator('#save-draft')).toBeEnabled();
}
async function search(page, query) {
  await page.locator('#dependency-query').fill(query); await page.locator('#search-dependencies').click();
  await expect(page.locator('#dependency-search-status')).toContainText('개 개정');
}
async function save(page, path = '/drafts') {
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith(path));
  await page.locator('#save-draft').click(); const result = await response; expect(result.status()).toBe(200);
  await expect(page.getByRole('button', { name: '공유 게시 미리보기 생성', exact: true })).toBeVisible();
  return result.json();
}

test('authors a pinned dependency through search, preview and publication without HTML injection', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await openComposer(page, workspace); await search(page, 'Source');
  await page.locator('#dependency-results').getByRole('button', { name: '이 개정 참조', exact: true }).click();
  await expect(page.locator('#draft-dependency-list')).toContainText('Source <img');
  await expect(page.locator('#draft-dependency-list img')).toHaveCount(0);
  await workspace.publish('source', 'Newer source revision');
  const draft = await save(page);
  expect(draft.revision.payload.dependencies[0].revision_digest).toBe(workspace.source.revision_digest);
  expect(draft.revision.payload.dependencies[0].document_id).toBe('doc-source');
  expect(draft.revision.payload.dependencies[0].enforcement).toBe('requires_active');
  await page.getByRole('button', { name: '공유 게시 미리보기 생성', exact: true }).click();
  await expect(page.locator('#preview-section .dependency-list')).toContainText('활성 합의가 필요함');
  await expect(page.locator('#preview-section img')).toHaveCount(0);
  await page.locator('#confirm-shared').check();
  await page.getByRole('button', { name: '공용 원장에 게시', exact: true }).click();
  await page.locator('.document-card').filter({ hasText: 'Target document' }).click();
  await expect(page.locator('#document-title')).toHaveText('Target document');
  await expect(page.locator('#document-detail-content .dependency-list')).toContainText('활성 합의가 필요함');
  const published = workspace.app.service.values('revision').find(revision => revision.payload.document_id === 'doc-target');
  expect(published.revision_digest).toBe(draft.revision.revision_digest);
  for (const width of [390, 600, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test('changing only dependency conditions invalidates preview and creates a new immutable private draft', async ({ page, workspace }) => {
  await openComposer(page, workspace); await search(page, 'Source');
  await page.locator('#dependency-results').getByRole('button', { name: '이 개정 참조', exact: true }).click();
  const original = await save(page);
  await page.getByRole('button', { name: '공유 게시 미리보기 생성', exact: true }).click();
  await expect(page.locator('#confirm-shared')).toBeVisible();
  await page.locator('#draft-dependency-list').getByLabel('사용 조건').selectOption('informational');
  await expect(page.locator('#preview-section')).toBeHidden();
  const edited = await save(page, `/drafts/${original.draft_id}/edits`);
  expect(edited.draft_id).not.toBe(original.draft_id);
  expect(edited.revision.revision_digest).not.toBe(original.revision.revision_digest);
  expect(edited.revision.payload.dependencies[0].enforcement).toBe('informational');
  expect((await workspace.app.service.getDraft(workspace.actor, original.draft_id)).revision.payload.dependencies[0].enforcement).toBe('requires_active');
  await page.locator('#draft-dependency-list').getByRole('button', { name: '참조 제거', exact: true }).click();
  const cleared = await save(page, `/drafts/${edited.draft_id}/edits`);
  expect(cleared.revision.payload.dependencies).toEqual([]);
  await page.reload(); await expect(page.locator('#private-draft-list')).toContainText('Target document');
  await page.locator('#private-draft-list button').filter({ hasText: 'Target document' }).first().click();
  await expect(page.locator('#dependency-status')).toContainText('참조 0/32개');
});

test('revising an existing document waits for canonical inherited dependencies and can retry a failed lookup', async ({ page, workspace }) => {
  const target = await workspace.publish('target', 'Existing target', [{ revision_digest: workspace.source.revision_digest, relationship: 'reference', enforcement: 'requires_active' }]);
  await page.goto(workspace.origin); await expect(page.locator('#document-title')).toHaveText('Existing target');
  let once = true;
  await page.route(url => decodeURIComponent(url.pathname) === `/v1/workspaces/dependency-browser/revisions/${target.revision_digest}`, async route => {
    if (once) { once = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'FRESHNESS_UNAVAILABLE', message: 'Synthetic lookup outage' }) }); }
    else await route.continue();
  });
  await page.getByRole('button', { name: '이 문서의 새 개정본 작성', exact: true }).click();
  await expect(page.locator('#dependency-status')).toContainText('불러오지 못했습니다');
  await expect(page.locator('#save-draft')).toBeDisabled();
  await page.locator('#retry-dependencies').click();
  await expect(page.locator('#draft-dependency-list li')).toHaveCount(1);
  await page.locator('#draft-body').fill('# Revised body');
  const draft = await save(page);
  expect(draft.revision.payload.parents).toEqual([target.revision_digest]);
  expect(draft.revision.payload.dependencies).toEqual(target.payload.dependencies);
});

test('dependency search paginates and late responses cannot repopulate another actor composer', async ({ page, workspace }) => {
  for (let i = 0; i < 21; i++) await workspace.publish('source', `PAGE-DEPENDENCY-${i}`, [], `doc-page-${i}`);
  await openComposer(page, workspace); await search(page, 'PAGE-DEPENDENCY');
  await expect(page.locator('#dependency-results li')).toHaveCount(20);
  await page.locator('#more-dependencies').click();
  await expect(page.locator('#dependency-results li')).toHaveCount(21);
  await expect(page.locator('#more-dependencies')).toBeHidden();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reached; const intercepted = new Promise(resolve => { reached = resolve; });
  await page.route('**/v1/workspaces/dependency-browser/search', async route => {
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  await page.locator('#dependency-query').fill('Source'); await page.locator('#search-dependencies').click(); await intercepted;
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  await expect(page.locator('#footer-actor')).toContainText('BetaMSP'); release();
  await page.getByRole('button', { name: '새 지식 문서 작성', exact: true }).click();
  await expect(page.locator('#dependency-results li')).toHaveCount(0);
  await expect(page.locator('#draft-dependency-list li')).toHaveCount(0);
});

test('Markdown import preserves edited dependencies and the selected parent across overview refreshes', async ({ page, workspace }) => {
  const target = await workspace.publish('target', 'Existing target', [{ revision_digest: workspace.source.revision_digest, relationship: 'reference', enforcement: 'requires_active' }]);
  await page.goto(workspace.origin); await expect(page.locator('#document-title')).toHaveText('Existing target');
  await page.getByRole('button', { name: '이 문서의 새 개정본 작성', exact: true }).click();
  await expect(page.locator('#draft-dependency-list li')).toHaveCount(1);
  await page.locator('#draft-dependency-list').getByLabel('사용 조건').selectOption('informational');
  await workspace.publish('target', 'Concurrent newer target', []);
  await page.locator('#refresh-overview').click();
  await page.locator('#markdown-file').setInputFiles({ name: 'target.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported after newer publication') });
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/draft-imports/markdown'));
  await page.locator('#import-markdown').click();
  const imported = await (await response).json();
  expect(imported.revision.payload.parents).toEqual([target.revision_digest]);
  expect(imported.revision.payload.dependencies[0].revision_digest).toBe(workspace.source.revision_digest);
  expect(imported.revision.payload.dependencies[0].enforcement).toBe('informational');
  await expect(page.locator('#draft-dependency-list').getByLabel('사용 조건')).toHaveValue('informational');
});
