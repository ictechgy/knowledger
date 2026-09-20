import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test = base.extend({ workspace: async ({}, use) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-browser-review-'));
  const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'review-browser');
  const policy = config.genesis.policies[0];
  config.genesis.policies = ['source', 'target'].map(name => ({ ...structuredClone(policy), policy_id: `policy-${name}`, document_id: `doc-${name}`, scope_id: `scope-${name}`, acceptance_slot: `slot-${name}` }));
  const app = await createConfiguredApp(config, { dataDir, port: 0 }); const origin = await app.listen(0); const actor = config.bootstrap_actor;
  let sequence = 0;
  const publish = async (name, dependencies = []) => {
    const draft = await app.service.draft(actor, { document_id: `doc-${name}`, context_id: 'context-shared', scope_id: `scope-${name}`, usage_scope: 'reference/v1', title: `${name} <img src=x onerror=alert(1)>`, body_markdown: `# Original ${name} body`, dependencies });
    const preview = await app.service.preview(actor, { draft_id: draft.draft_id });
    await app.service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `browser-review-${++sequence}` });
    return draft.revision;
  };
  const source = await publish('source');
  try { await use({ app, origin, actor, source, publish }); } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
} });
const beta = JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' });

test('starter templates populate an empty draft and preserve existing author text', async ({ page, workspace }) => {
  await page.goto(workspace.origin); await expect(page.locator('#persona-select')).toBeEnabled();
  await page.getByRole('button', { name: '새 지식 문서 작성', exact: true }).click();
  await page.locator('#draft-template').selectOption('decision');
  await page.locator('#apply-draft-template').click();
  expect(await page.locator('#draft-body').inputValue()).toContain('## 다시 검토할 조건');
  await page.locator('#draft-body').fill('# Keep my text');
  await page.locator('#draft-template').selectOption('guide'); await page.locator('#apply-draft-template').click();
  await expect(page.locator('#draft-body')).toHaveValue('# Keep my text');
});

test('comments notify another reviewer, render text safely, and survive reload without approving', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(workspace.origin);
  await page.getByLabel('검토 댓글', { exact: true }).fill('<img src=x onerror=alert(1)> Can we clarify this?');
  await page.getByLabel('알릴 사람 (선택)', { exact: true }).selectOption(beta);
  await page.getByRole('button', { name: '댓글 등록', exact: true }).click();
  await expect(page.locator('#review-event-list')).toContainText('Can we clarify this?');
  await expect(page.locator('#review-event-list img')).toHaveCount(0);
  await page.locator('#persona-select').selectOption(beta);
  await expect(page.locator('#review-notification-count')).toHaveText('1');
  await page.locator('#review-notification-list button').first().click();
  await expect(page.locator('#review-notification-count')).toHaveText('0');
  await page.reload(); await expect(page.locator('#review-event-list')).toContainText('Can we clarify this?');
  expect(workspace.app.service.values('decision')).toHaveLength(0);
  for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  expect(errors).toEqual([]);
});

test('assigned deadline appears in due inbox and completion schedules the next review without an approval', async ({ page, workspace }) => {
  await page.goto(workspace.origin);
  await page.getByText('검토 담당자·기한 설정', { exact: true }).click();
  await page.getByLabel('검토 담당자 (최대 16명)', { exact: true }).selectOption(beta);
  await page.getByLabel('검토 기한 (내 시간대)', { exact: true }).fill('2020-01-01T09:00');
  await page.getByLabel('완료 후 재검토 주기 (일)', { exact: true }).fill('30');
  await page.getByRole('button', { name: '검토 일정 저장', exact: true }).click();
  await expect(page.locator('.review-schedule-summary')).toContainText('완료 후 30일마다');
  await page.locator('#persona-select').selectOption(beta);
  await expect(page.locator('#review-due-list button')).toHaveCount(1);
  await page.getByLabel('검토 완료 메모', { exact: true }).fill('Fictional reviewer checked the source');
  await page.getByRole('button', { name: '검토 완료 기록', exact: true }).click();
  await expect(page.locator('#review-due-list')).toContainText('기한이 된 검토가 없습니다.');
  await expect(page.locator('#review-event-list')).toContainText('Fictional reviewer');
  await expect(page.locator('#review-complete-form')).toHaveCount(0);
  expect(workspace.app.service.values('decision')).toHaveLength(0);
});

test('impact displays the exact dependent revision and opens an immutable edit with original body', async ({ page, workspace }) => {
  const target = await workspace.publish('target', [{ revision_digest: workspace.source.revision_digest, relationship: 'reference', enforcement: 'requires_active' }]);
  await page.goto(workspace.origin);
  await page.locator('.document-card').filter({ hasText: 'source <img' }).click();
  await page.getByRole('button', { name: '이 개정의 영향 문서 확인', exact: true }).click();
  await expect(page.locator('#revision-impact-content')).toContainText('필수 참조 경로 1개');
  await expect(page.locator('#revision-impact-content img')).toHaveCount(0);
  await page.locator('#revision-impact-content').getByRole('button', { name: '수정본 작성', exact: true }).click();
  await expect(page.locator('#draft-body')).toHaveValue('# Original target body');
  await expect(page.locator('#draft-dependency-list li')).toHaveCount(1);
  const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/drafts'));
  await page.locator('#draft-body').fill('# Changed target'); await page.locator('#save-draft').click();
  const result = await (await response).json(); expect(result.revision.payload.parents).toEqual([target.revision_digest]);
});

test('late review responses are discarded when selecting another revision', async ({ page, workspace }) => {
  await workspace.publish('target');
  await workspace.app.service.commentOnReview(workspace.actor, workspace.source.revision_digest, { operation_id: 'delayed-source-comment', body: 'SOURCE_ONLY_COMMENT' });
  await page.goto(workspace.origin); await expect(page.locator('#document-title')).toContainText('source');
  await expect(page.locator('#review-event-list')).toContainText('SOURCE_ONLY_COMMENT');
  let release; const gate = new Promise(resolve => { release = resolve; }); let reached; const intercepted = new Promise(resolve => { reached = resolve; });
  await page.route(url => decodeURIComponent(url.pathname).endsWith(`${workspace.source.revision_digest}/review`), async route => {
    const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '검토 기록 새로고침', exact: true }).click(); await intercepted;
  await page.locator('.document-card').filter({ hasText: 'target <img' }).click();
  await expect(page.locator('#review-event-list')).toContainText('아직 검토 기록이 없습니다.'); release();
  await expect(page.locator('#review-event-list')).not.toContainText('SOURCE_ONLY_COMMENT');
});
