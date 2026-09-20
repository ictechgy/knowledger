import { test as base, expect } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';

const test = base.extend({ workspace: async ({}, use) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-browser-slack-')); const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'slack-browser');
  const remote = { lost: false, posts: [] };
  const app = await createConfiguredApp(config, { dataDir, port: 0, reviewReminders: { pollMs: 0 }, slackNotifications: {
    worker: { pollMs: 0 }, targets: [{ recipient: { org_id: 'BetaMSP', actor_id: 'maintainer' }, version: 1,
      address: { team_id: 'TTEST123', user_id: 'UTEST123', dm_id: 'DTEST123' }, appUrl: 'https://knowledger.example/',
      getBotToken: () => 'xoxb-FIXTURE-TOKEN', allows: () => true, fetch: async (url, input) => {
        let result;
        if (url.endsWith('auth.test')) result = { ok: true, team_id: 'TTEST123', bot_id: 'BBOT123' };
        else if (url.endsWith('conversations.open')) result = { ok: true, channel: { id: 'DTEST123', is_im: true, user: 'UTEST123' } };
        else { remote.posts.push(JSON.parse(input.body)); if (remote.lost) throw new Error('Lost fictional response'); result = { ok: true, channel: 'DTEST123', ts: '1726839000.000001' }; }
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
      } }],
  } });
  try {
    const author = config.bootstrap_actor;
    const draft = await app.service.draft(author, { document_id: 'doc-shared-guideline', context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1', title: 'PRIVATE_TITLE', body_markdown: 'PRIVATE_BODY' });
    const preview = await app.service.preview(author, { draft_id: draft.draft_id });
    await app.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'slack-browser-publish' });
    const now = Date.now();
    await app.service.scheduleReview(author, draft.revision.revision_digest, { operation_id: 'slack-browser-schedule', expected_version: 0, assignees: [{ org_id: 'BetaMSP', actor_id: 'maintainer' }], due_at: new Date(now).toISOString(), repeat_after_days: null });
    await app.service.reviewReminders.runOnce(now);
    await use({ app, remote, origin: await app.listen(0) });
  } finally { await app.close(); rmSync(dataDir, { recursive: true, force: true }); }
} });

test('Slack acceptance is shown only to its recipient and does not claim human reading', async ({ page, workspace }) => {
  await workspace.app.service.slackNotifications.worker.runOnce();
  await page.goto(workspace.origin);
  await expect(page.locator('#review-reminder-list')).not.toContainText('Slack 접수 확인');
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  await expect(page.locator('#review-reminder-list')).toContainText('Slack 접수 확인 · 열람 여부는 알 수 없음');
  expect(JSON.stringify(workspace.remote.posts)).not.toContain('PRIVATE_TITLE');
  expect(workspace.app.service.values('decision')).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('an ambiguous Slack result is visible and has no automatic resend action', async ({ page, workspace }) => {
  workspace.remote.lost = true; await workspace.app.service.slackNotifications.worker.runOnce();
  await page.goto(workspace.origin); await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  await expect(page.locator('#review-reminder-list')).toContainText('Slack 발송 여부 확인 필요 · 자동 재발송 중지');
  await workspace.app.service.slackNotifications.worker.runOnce(); expect(workspace.remote.posts).toHaveLength(1);
});

test('manual receipt confirmation records a distinct status and does not mark a reminder read', async ({ page, workspace }) => {
  workspace.remote.lost = true; await workspace.app.service.slackNotifications.worker.runOnce();
  await page.goto(workspace.origin); await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  const panel = page.locator('#slack-notice-panel'); await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: '확인 결과 저장' })).toBeDisabled();
  await panel.getByLabel('Slack에서 확인한 결과를 기록합니다.').check();
  await panel.getByRole('button', { name: '확인 결과 저장' }).click();
  await expect(panel).toContainText('본인 수신 확인 기록 · 공급자 접수 증명 아님');
  await expect(panel).toContainText('본인이 수신 확인'); await expect(page.locator('#review-reminder-count')).toHaveText('1');
  expect(workspace.remote.posts).toHaveLength(1); expect(workspace.app.service.values('decision')).toHaveLength(0);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'AlphaMSP', actor_id: 'maintainer' }));
  await expect(panel).not.toContainText('PRIVATE_TITLE');
});

test('manual resend requires duplicate-risk consent and leaves one audited retry request', async ({ page, workspace }) => {
  workspace.remote.lost = true; await workspace.app.service.slackNotifications.worker.runOnce();
  await page.goto(workspace.origin); await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  const panel = page.locator('#slack-notice-panel'); await panel.getByLabel('Slack 확인 결과').selectOption('retry');
  await panel.getByLabel('Slack에서 확인한 결과를 기록합니다.').check();
  await expect(panel.getByRole('button', { name: '확인 결과 저장' })).toBeDisabled();
  await panel.getByLabel('중복 알림이 생길 수 있음을 알고 재발송합니다.').check();
  await panel.getByRole('button', { name: '확인 결과 저장' }).click();
  await expect(panel).toContainText('Slack 재시도 대기'); await expect(panel).toContainText('본인이 재발송 요청');
  workspace.remote.lost = false;
  await expect.poll(async () => { await workspace.app.service.slackNotifications.worker.runOnce(); return workspace.remote.posts.length; }).toBe(2);
  await panel.getByRole('button', { name: 'Slack 상태 새로고침' }).click();
  await expect(panel).toContainText('Slack 접수 확인'); expect(workspace.remote.posts).toHaveLength(2);
});
