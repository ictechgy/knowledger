import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../packages/config/template.ts';
import { createReviewHttpTransport } from '../packages/review/http-delivery.ts';

/** Disposable local simulations and an in-memory test key; no real peer or external account. */
const root = mkdtempSync(join(tmpdir(), 'knowledger-review-relay-demo-'));
const configuration = createProjectTemplate(['DemoAuthorMSP', 'DemoReviewerMSP'], 'review-relay-demo');
const author = configuration.bootstrap_actor;
const recipient = { org_id: 'DemoReviewerMSP', actor_id: 'maintainer', kind: 'human' as const };
const secret = randomBytes(32);
let receiver: Awaited<ReturnType<typeof createConfiguredApp>> | undefined;
let sender: Awaited<ReturnType<typeof createConfiguredApp>> | undefined;
try {
  receiver = await createConfiguredApp(configuration, { dataDir: join(root, 'receiver'), port: 0,
    reviewDelivery: { source_id: 'reviewer-app', source_org_id: recipient.org_id, peers: [{ key_id: 'demo-relay-key', secret, source_id: 'author-app', org_id: author.org_id }], worker: { pollMs: 0 } } });
  const endpoint = `${await receiver.listen(0)}/v1/workspaces/review-relay-demo/review-deliveries/receive`;
  let attempts = 0; const submitted: string[] = [];
  const transport = createReviewHttpTransport({ endpoint, key_id: 'demo-relay-key', secret, allowInsecureLoopback: true,
    fetch: async (url, init) => {
      attempts++; submitted.push(String(init!.body));
      const response = await fetch(url, init);
      if (attempts === 1) { await response.json(); throw new Error('Fictional receipt loss after receiver storage'); }
      return response;
    } });
  sender = await createConfiguredApp(configuration, { dataDir: join(root, 'sender'), port: 0,
    reviewDelivery: { source_id: 'author-app', source_org_id: author.org_id,
      destinations: [{ id: 'reviewer-inbox', label: 'Fictional reviewer inbox', version: 1, recipient: { org_id: recipient.org_id, actor_id: recipient.actor_id }, transport }],
      worker: { pollMs: 0, retryBaseMs: 10 } } });
  const policy = configuration.genesis.policies[0];
  const draft = await sender.service.draft(author, { document_id: policy.document_id, context_id: policy.context_id, scope_id: policy.scope_id,
    usage_scope: policy.usage_scope, title: '가상 검토 전달 시나리오', body_markdown: '# 가상 공유 문서\n\n이 문서의 본문은 댓글 전달 패킷에 포함하지 않습니다.' });
  const preview = await sender.service.preview(author, { draft_id: draft.draft_id });
  await sender.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'relay-demo-publish' });
  await receiver.service.ledger.execute(author, { command_id: 'relay-demo-fixture', type: 'publish_revision', input: { revision: draft.revision,
    publication: { revision_digest: draft.revision.revision_digest, config_version: 1, membership_epoch: 1 } } });
  const digest = draft.revision.revision_digest;
  const event = await sender.service.commentOnReview(author, digest, { operation_id: 'relay-demo-comment', body: '가상 검토 요청입니다. 적용 범위의 설명을 확인해 주세요.' });
  const before = sender.service.ledger.checkpoint();
  const queued = await sender.service.reviewDelivery!.enqueue(author, digest, { operation_id: 'relay-demo-delivery', event_id: event.event_id,
    destination_id: 'reviewer-inbox', destination_version: 1, confirm_shared: true });
  await sender.service.reviewDelivery!.worker.runOnce();
  assert.equal((await sender.service.reviewDelivery!.list(author, {})).deliveries[0].status, 'pending');
  await delay(20); await sender.service.reviewDelivery!.worker.runOnce();
  const final = (await sender.service.reviewDelivery!.list(author, {})).deliveries[0];
  const incoming = await receiver.service.reviewDelivery!.inbox(recipient, {});
  assert.equal(final.status, 'delivered'); assert.equal(attempts, 2); assert.equal(submitted[0], submitted[1]);
  assert.equal(incoming.deliveries.length, 1); assert.equal(incoming.deliveries[0].receipt.delivery_id, queued.delivery_id);
  assert.equal((await receiver.service.reviewDelivery!.inbox(author, {})).deliveries.length, 0);
  assert.equal(submitted[0].includes(JSON.stringify(draft.revision.payload.body_markdown).slice(1, -1)), false);
  assert.deepEqual(sender.service.ledger.checkpoint(), before);
  assert.equal(receiver.service.values('decision').length, 0);
  process.stdout.write(JSON.stringify({ mode: 'local-simulation', status: 'passed', fictional_participants: true, attempts,
    receiver_records: incoming.deliveries.length, identical_retry: true, recipient_isolation: true,
    shared_document_body_forwarded: false, approvals_created: 0, ledger_unchanged_by_delivery: true }, null, 2) + '\n');
} catch {
  process.stderr.write('review-delivery demo failed\n'); process.exitCode = 1;
} finally {
  try { await sender?.close(); } finally { try { await receiver?.close(); } finally { rmSync(root, { recursive: true, force: true }); } }
}
