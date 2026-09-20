import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test = base.extend({ workspace: async ({}, use) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-browser-reminders-')); const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'reminders-browser');
  const app = await createConfiguredApp(config, { dataDir, port: 0, reviewReminders: { pollMs: 0, overdueAfterMs: 86400000 } });
  const author = config.bootstrap_actor; const policy = config.genesis.policies[0]; const now = Date.now();
  try {
    const draft = await app.service.draft(author, { document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id, usage_scope: policy.usage_scope,
      title: 'Deadline <img src=x onerror=alert(1)>', body_markdown: '# Reminder fixture' });
    const preview = await app.service.preview(author, { draft_id: draft.draft_id });
    await app.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'reminder-publish' });
    const digest = draft.revision.revision_digest;
    await app.service.scheduleReview(author, digest, { operation_id: 'reminder-schedule', expected_version: 0, assignees: [{ org_id: 'BetaMSP', actor_id: 'maintainer' }], due_at: new Date(now).toISOString(), repeat_after_days: null });
    await use({ app, author, digest, now, origin: await app.listen(0) });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
} });
const beta = JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' });
const alpha = JSON.stringify({ org_id: 'AlphaMSP', actor_id: 'maintainer' });

test('deadline notices refresh automatically, open the exact revision and disappear after completion', async ({ page, workspace }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  // Advance only the browser's 30-second reminder refresh interval for this test.
  await page.addInitScript(() => { const original = window.setTimeout; window.setTimeout = (fn, ms, ...args) => original(fn, ms === 30000 ? 150 : ms, ...args); });
  await page.goto(workspace.origin); await page.locator('#persona-select').selectOption(beta);
  await expect(page.locator('#review-reminder-count')).toHaveText('0');
  await workspace.app.service.reviewReminders.runOnce(workspace.now);
  await expect(page.locator('#review-reminder-count')).toHaveText('1');
  await expect(page.locator('#review-reminder-list')).toContainText('검토 기한 도래');
  await expect(page.locator('#review-reminder-list img')).toHaveCount(0);
  await page.locator('#review-reminder-list button').first().click();
  await expect(page.locator('#review-reminder-count')).toHaveText('0');
  await expect(page.locator('#document-title')).toHaveText('Deadline <img src=x onerror=alert(1)>');
  await page.getByLabel('검토 완료 메모', { exact: true }).fill('Fictional reviewer completed the task');
  await page.getByRole('button', { name: '검토 완료 기록', exact: true }).click();
  await expect(page.locator('#review-reminder-list')).toContainText('새 기한 알림이 없습니다.');
  expect(workspace.app.service.values('decision')).toHaveLength(0); expect(errors).toEqual([]);
});

test('late reminder responses cannot restore another recipient notices after account switching', async ({ page, workspace }) => {
  await workspace.app.service.reviewReminders.runOnce(workspace.now + 86400000);
  await page.goto(workspace.origin); await page.locator('#persona-select').selectOption(beta);
  await expect(page.locator('#review-reminder-list')).toContainText('검토 기한 초과');
  let release; const gate = new Promise(resolve => { release = resolve; }); let reached; const intercepted = new Promise(resolve => { reached = resolve; }); let once = true;
  await page.route('**/review-reminders', async route => { if (!once) { await route.continue(); return; } once = false; const response = await route.fetch(); reached(); await gate; await route.fulfill({ response }); });
  await page.locator('#refresh-review-notifications').click(); await intercepted;
  await page.locator('#persona-select').selectOption(alpha);
  await expect(page.locator('#review-reminder-list')).toContainText('새 기한 알림이 없습니다.'); release();
  await expect(page.locator('#review-reminder-list')).not.toContainText('기한 초과');
});
