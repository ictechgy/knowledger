import { test as base, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../../packages/config/template.ts';
import { createReviewHttpTransport } from '../../../packages/review/http-delivery.ts';

const test = base.extend({ relay: async ({}, use) => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-browser-relay-')); const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'relay-browser');
  const author = config.bootstrap_actor; const key = randomBytes(32);
  const receiver = await createConfiguredApp(config, { dataDir: join(root, 'receiver'), port: 0, reviewDelivery: { source_id: 'beta-app', source_org_id: 'BetaMSP',
    peers: [{ key_id: 'fixture-key', secret: key, source_id: 'alpha-app', org_id: 'AlphaMSP' }], worker: { pollMs: 0 } } });
  const receivedOrigin = await receiver.listen(0);
  const sender = await createConfiguredApp(config, { dataDir: join(root, 'sender'), port: 0, reviewDelivery: { source_id: 'alpha-app', source_org_id: 'AlphaMSP', worker: { pollMs: 0 },
    destinations: [{ id: 'beta-inbox', label: 'Beta 검토함', version: 1, recipient: { org_id: 'BetaMSP', actor_id: 'maintainer' },
      transport: createReviewHttpTransport({ endpoint: `${receivedOrigin}/v1/workspaces/relay-browser/review-deliveries/receive`, key_id: 'fixture-key', secret: key, allowInsecureLoopback: true }) }] } });
  try {
    const policy = config.genesis.policies[0]; const draft = await sender.service.draft(author, { document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id,
      usage_scope: policy.usage_scope, title: 'Relay fixture', body_markdown: '# Public revision' });
    const preview = await sender.service.preview(author, { draft_id: draft.draft_id });
    await sender.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'relay-publish' });
    await receiver.service.ledger.execute(author, { type: 'publish_revision', command_id: 'relay-fixture', input: { revision: draft.revision, publication: { revision_digest: draft.revision.revision_digest, config_version: 1, membership_epoch: 1 } } });
    await sender.service.commentOnReview(author, draft.revision.revision_digest, { operation_id: 'relay-comment', body: 'RECEIVER_ONLY <img src=x onerror=alert(1)>' });
    await use({ sender, receiver, sentOrigin: await sender.listen(0), receivedOrigin });
  } finally { await sender.close(); await receiver.close(); rmSync(root, { recursive: true, force: true }); }
} });

async function send(page, relay) {
  await page.goto(relay.sentOrigin);
  await page.getByText('이 댓글 전달', { exact: true }).click();
  const submit = page.getByRole('button', { name: '선택한 수신자에게 전달', exact: true }); await expect(submit).toBeDisabled();
  await page.getByLabel('이 댓글의 원문을 선택한 수신자에게 전달합니다', { exact: true }).check();
  await submit.click(); await expect(page.locator('#review-delivery-outbox')).toContainText('전달 대기');
  await relay.sender.service.reviewDelivery.worker.runOnce();
  await page.locator('#refresh-review-deliveries').click();
  await expect(page.locator('#review-delivery-outbox')).toContainText('수신 저장 확인');
}

test('explicit author confirmation sends a comment to the configured recipient with separate receipt status', async ({ page, relay }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await send(page, relay);
  await page.goto(relay.receivedOrigin); await expect(page.locator('#persona-select')).toBeEnabled();
  await expect(page.locator('#review-delivery-inbox')).toContainText('전달받은 댓글이 없습니다.');
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  await page.locator('#review-delivery-inbox').getByText('전달된 댓글 원문 보기', { exact: true }).click();
  await expect(page.locator('#review-delivery-inbox')).toContainText('RECEIVER_ONLY <img');
  await expect(page.locator('#review-delivery-inbox img')).toHaveCount(0);
  await expect(page.locator('#review-event-list')).toContainText('아직 검토 기록이 없습니다.');
  for (const width of [390, 1440]) { await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); }
  expect(relay.receiver.service.values('decision')).toHaveLength(0); expect(errors).toEqual([]);
});

test('late incoming delivery responses cannot repopulate another account inbox', async ({ page, relay }) => {
  await send(page, relay); await page.goto(relay.receivedOrigin);
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'BetaMSP', actor_id: 'maintainer' }));
  await expect(page.locator('#review-delivery-inbox')).toContainText('RECEIVER_ONLY');
  let release; const gate = new Promise(resolve => { release = resolve; }); let reached; const intercepted = new Promise(resolve => { reached = resolve; }); let once = true;
  await page.route('**/review-deliveries/received', async route => {
    if (!once) { await route.continue(); return; }
    once = false; const response = await route.fetch(); reached(); await gate; await route.fulfill({ response });
  });
  await page.locator('#refresh-review-deliveries').click(); await intercepted;
  await page.locator('#persona-select').selectOption(JSON.stringify({ org_id: 'AlphaMSP', actor_id: 'maintainer' }));
  await expect(page.locator('#review-delivery-inbox')).toContainText('전달받은 댓글이 없습니다.'); release();
  await expect(page.locator('#review-delivery-inbox')).not.toContainText('RECEIVER_ONLY');
});
