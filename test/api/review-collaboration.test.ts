import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-reviews-')); let dataDir = join(root, 'runtime');
  const config = createProjectTemplate(['WriterMSP', 'ReviewerMSP'], 'reviews');
  const writer = config.bootstrap_actor; const reviewer = { org_id: 'ReviewerMSP', actor_id: 'maintainer', kind: 'human' as const };
  const reader = { org_id: 'WriterMSP', actor_id: 'reader', kind: 'human' as const };
  const agent = { org_id: 'WriterMSP', actor_id: 'assistant', kind: 'agent' as const };
  for (const identity of [reader, agent]) { config.identities.push({ ...identity, label: identity.actor_id }); config.genesis.identities.push({ ...identity, publish_contexts: [], can_propose: false }); }
  const policy = config.genesis.policies[0];
  config.genesis.policies.push(...['second', 'third', 'info'].map(name => ({ ...structuredClone(policy), policy_id: `policy-${name}`, document_id: `doc-${name}`, acceptance_slot: `slot-${name}` })));
  let app = await createConfiguredApp(config, { dataDir, port: 0 }); let sequence = 0;
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const draft = (document_id = policy.document_id, dependencies: any[] = []) => app.service.draft(writer, { document_id, context_id: policy.context_id,
    scope_id: policy.scope_id, usage_scope: policy.usage_scope, title: document_id, body_markdown: '# Fixture', dependencies });
  const publish = async (documentId = policy.document_id, dependencies: any[] = []) => {
    const value = await draft(documentId, dependencies); const preview = await app.service.preview(writer, { draft_id: value.draft_id });
    await app.service.publish(writer, { preview_id: preview.preview_id, confirm_shared: true, command_id: `review-publish-${++sequence}` }); return value.revision;
  };
  const revision = await publish(); const digest = revision.revision_digest;
  const schedule = (extra: any = {}) => ({ operation_id: 'schedule-initial', expected_version: 0, assignees: [{ org_id: reviewer.org_id, actor_id: reviewer.actor_id }], due_at: '2020-01-01T00:00:00.000Z', repeat_after_days: null, ...extra });
  return { get app() { return app; }, writer, reviewer, reader, agent, revision, digest, config, schedule, draft, publish,
    async restart(backup = false) {
      await app.close();
      if (backup) { const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir, snapshotDir }); dataDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir, snapshotDir }); }
      app = await createConfiguredApp(config, { dataDir, port: 0 });
    } };
}
const rejects = (promise: Promise<any>, code: string) => assert.rejects(promise, (error: any) => error.code === code);
const ref = (revision: any, enforcement = 'requires_active') => ({ revision_digest: revision.revision_digest, relationship: 'reference', enforcement });

test('comments bind a published revision, notify selected recipients, and never become approval evidence', async t => {
  const f = await fixture(t); const before = f.app.service.ledger.checkpoint();
  const privateDraft = await f.draft();
  await rejects(f.app.service.commentOnReview(f.writer, privateDraft.revision.revision_digest, { operation_id: 'comment-private', body: 'Private', mentions: [] }), 'NOT_FOUND');
  const comment = { operation_id: 'comment-initial', body: '<img src=x onerror=alert(1)>', mentions: [{ org_id: f.reviewer.org_id, actor_id: f.reviewer.actor_id }] };
  const event = await f.app.service.commentOnReview(f.writer, f.digest, comment);
  assert.deepEqual(await f.app.service.commentOnReview(f.writer, f.digest, comment), event);
  await rejects(f.app.service.commentOnReview(f.writer, f.digest, { ...comment, body: 'Changed' }), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await f.app.service.reviewNotifications(f.reviewer)).unread_count, 1);
  assert.equal((await f.app.service.reviewNotifications(f.reader)).unread_count, 0);
  await rejects(f.app.service.readReviewNotification(f.reader, event.event_id, {}), 'NOT_FOUND');
  await f.app.service.readReviewNotification(f.reviewer, event.event_id, {});
  await f.app.service.readReviewNotification(f.reviewer, event.event_id, {});
  assert.equal((await f.app.service.reviewNotifications(f.reviewer)).unread_count, 0);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  assert.equal(f.app.service.values('decision').length, 0);
  const view = await f.app.service.review(f.reader, f.digest);
  assert.equal(view.events[0].body, comment.body); assert.equal(view.storage_scope, 'application');
  assert.equal(view.can_manage, false);
});

test('schedule CAS, actor rules, recurring completion and retried requests preserve exact records', async t => {
  const f = await fixture(t); const before = f.app.service.ledger.checkpoint();
  await rejects(f.app.service.scheduleReview(f.reader, f.digest, f.schedule()), 'REVIEW_MANAGER_REQUIRED');
  await rejects(f.app.service.scheduleReview(f.agent, f.digest, f.schedule()), 'REVIEW_MANAGER_REQUIRED');
  const input = f.schedule({ repeat_after_days: 30 });
  const scheduled = await f.app.service.scheduleReview(f.writer, f.digest, input);
  assert.deepEqual(await f.app.service.scheduleReview(f.writer, f.digest, input), scheduled);
  await rejects(f.app.service.scheduleReview(f.writer, f.digest, f.schedule({ operation_id: 'schedule-stale' })), 'REVIEW_VERSION_CONFLICT');
  assert.equal((await f.app.service.dueReviews(f.reviewer)).tasks.length, 1);
  assert.equal((await f.app.service.dueReviews(f.reader)).tasks.length, 0);
  const complete = { operation_id: 'review-complete', expected_version: 1, body: 'Fictional reviewer checked wording' };
  await rejects(f.app.service.completeReview(f.writer, f.digest, complete), 'REVIEW_ASSIGNEE_REQUIRED');
  await rejects(f.app.service.completeReview(f.agent, f.digest, complete), 'HUMAN_REVIEW_REQUIRED');
  const result = await f.app.service.completeReview(f.reviewer, f.digest, complete);
  assert.deepEqual(await f.app.service.completeReview(f.reviewer, f.digest, complete), result);
  assert.equal(result.schedule.version, 2);
  assert.equal(Date.parse(result.schedule.due_at) - Date.parse(result.schedule.completed_at), 30 * 86400000);
  await rejects(f.app.service.completeReview(f.reviewer, f.digest, { ...complete, operation_id: 'review-too-soon', expected_version: 2 }), 'REVIEW_NOT_DUE');
  assert.equal((await f.app.service.dueReviews(f.reviewer)).tasks.length, 0);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  const proposal = await f.app.service.propose(f.writer, { revision_digest: f.digest, policy_id: f.config.genesis.policies[0].policy_id, policy_version: 1, command_id: 'propose-after-review' });
  await rejects(f.app.service.activate(f.writer, proposal.result.proposal_id, { expected_active_agreement_id: null, command_id: 'activate-after-review' }), 'APPROVAL_INCOMPLETE');
});

test('review writes reject unknown fields, invalid recipients and invalid calendars; actor and serving checks stay fresh', async t => {
  const f = await fixture(t);
  for (const extra of [{ due_at: '2026-02-30T00:00:00.000Z' }, { due_at: '2026-01-01' }, { assignees: [] }, { repeat_after_days: 0 }, { due_at: null, repeat_after_days: 30 }, { expected_version: -1 }, { actor_id: 'forged' }]) {
    await assert.rejects(f.app.service.scheduleReview(f.writer, f.digest, f.schedule(extra)), (e: any) => e.status === 400);
  }
  await rejects(f.app.service.scheduleReview(f.writer, f.digest, f.schedule({ assignees: [{ org_id: f.agent.org_id, actor_id: f.agent.actor_id }] })), 'NOT_FOUND');
  await rejects(f.app.service.commentOnReview(f.writer, f.digest, { operation_id: 'comment-forged', body: 'Hi', mentions: [{ org_id: 'ForeignMSP', actor_id: 'someone' }] }), 'NOT_FOUND');
  await rejects(f.app.service.review({ ...f.reader, actor_id: 'unknown' }, f.digest), 'NOT_FOUND');
  const original = f.app.service.ledger.read.bind(f.app.service.ledger);
  f.app.service.ledger.read = (key: string, checkpoint: any) => { const value = original(key, checkpoint); return key === keyFor.config() ? { ...value, serving_enabled: false } : value; };
  await rejects(f.app.service.reviewNotifications(f.reviewer), 'SERVING_FROZEN');
  await rejects(f.app.service.commentOnReview(f.writer, f.digest, { operation_id: 'comment-frozen', body: 'No' }), 'SERVING_FROZEN');
});

test('review history and unread notifications survive restart and stopped-app snapshot restoration', async t => {
  const f = await fixture(t);
  const input = { operation_id: 'durable-comment', body: 'Retained comment', mentions: [{ org_id: f.reviewer.org_id, actor_id: f.reviewer.actor_id }] };
  const comment = await f.app.service.commentOnReview(f.writer, f.digest, input);
  await f.app.service.scheduleReview(f.writer, f.digest, f.schedule());
  const before = await f.app.service.review(f.writer, f.digest);
  await f.restart(); assert.deepEqual(await f.app.service.review(f.writer, f.digest), before);
  await f.restart(true); assert.deepEqual(await f.app.service.review(f.writer, f.digest), before);
  assert.deepEqual(await f.app.service.commentOnReview(f.writer, f.digest, input), comment);
  assert.equal((await f.app.service.reviewNotifications(f.reviewer)).unread_count, 2);
  assert.equal((await f.app.service.dueReviews(f.reviewer)).tasks.length, 1);
});

test('review pagination stays revision- and recipient-scoped and handles concurrent insertion', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.app.service.commentOnReview(f.writer, f.digest, { operation_id: `paged-comment-${i}`, body: `comment ${i}`, mentions: [{ org_id: f.reviewer.org_id, actor_id: f.reviewer.actor_id }] });
  const first = await f.app.service.review(f.writer, f.digest, { limit: 2 });
  await f.app.service.commentOnReview(f.writer, f.digest, { operation_id: 'paged-comment-new', body: 'New' });
  const second = await f.app.service.review(f.writer, f.digest, { limit: 2, cursor: first.next_cursor });
  assert.equal(second.events[0].body, 'comment 2');
  const other = await f.publish('doc-other');
  assert.equal((await f.app.service.review(f.writer, other.revision_digest, { cursor: first.next_cursor })).events.length, 0);
  const notifications = await f.app.service.reviewNotifications(f.reviewer, { limit: 2 });
  assert.equal((await f.app.service.reviewNotifications(f.reader, { cursor: notifications.next_cursor })).notifications.length, 0);
  for (const cursor of ['NaN', '0', '-1', '99999999999999999999']) await rejects(f.app.service.review(f.writer, f.digest, { cursor }), 'INVALID_QUERY');
});

test('impact follows required paths transitively and distinguishes informational paths at an exact checkpoint', async t => {
  const f = await fixture(t); const second = await f.publish('doc-second', [ref(f.revision)]);
  const third = await f.publish('doc-third', [ref(second)]);
  const info = await f.publish('doc-info', [ref(f.revision, 'informational')]);
  const infoChild = await f.publish('doc-info-child', [ref(info)]);
  await f.publish('doc-unrelated');
  const first = await f.app.service.revisionImpact(f.writer, f.digest, { limit: 1 });
  assert.equal(first.total, 4); assert.equal(first.required_count, 2); assert.equal(first.informational_count, 2);
  assert.equal(first.revisions[0].revision_digest, second.revision_digest);
  const later = await f.publish('doc-later', [ref(f.revision)]);
  const page = await f.app.service.revisionImpact(f.writer, f.digest, { limit: 50, cursor: first.next_cursor });
  assert.deepEqual(page.checkpoint, first.checkpoint); assert.equal(page.total, 4);
  assert.equal(page.revisions.find((r: any) => r.revision_digest === third.revision_digest).impact.depth, 2);
  assert.equal(page.revisions.find((r: any) => r.revision_digest === infoChild.revision_digest).impact.kind, 'informational');
  assert.equal(JSON.stringify(page).includes(later.revision_digest), false);
  await rejects(f.app.service.revisionImpact(f.reviewer, f.digest, { cursor: first.next_cursor }), 'INVALID_CURSOR');
  await rejects(f.app.service.revisionImpact(f.writer, second.revision_digest, { cursor: first.next_cursor }), 'INVALID_CURSOR');
  assert.equal((await f.app.service.revisionImpact(f.writer, f.digest)).total, 5);
});

test('HTTP review routes enforce CSRF and input bounds and serve the new browser module', async t => {
  const f = await fixture(t); const origin = await f.app.listen(0); const root = `${origin}/v1/workspaces/reviews`;
  const login = await fetch(origin + '/api/session'); const cookie = login.headers.get('set-cookie')!.split(';')[0]; const session = await login.json() as any;
  assert.equal((await fetch(origin + '/review-workspace.js')).status, 200);
  const route = `${root}/revisions/${encodeURIComponent(f.digest)}/review`;
  const input = { operation_id: 'http-comment', body: 'HTTP comment' };
  assert.equal((await fetch(route + '/comments', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 403);
  const response = await fetch(route + '/comments', { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'X-KNOWLEDGER-CSRF': session.csrf_token, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(response.status, 200);
  for (const suffix of ['?limit=51', '?limit=1&limit=2', '?unknown=1']) assert.equal((await fetch(route + suffix, { headers: { Cookie: cookie } })).status, 400);
  for (const path of ['/review-notifications', '/review-due', `/revisions/${encodeURIComponent(f.digest)}/impact`]) assert.equal((await fetch(root + path, { headers: { Cookie: cookie } })).status, 200);
});

test('fresh impact eligibility reflects dependency withdrawal without treating informational references as blockers', async t => {
  const f = await fixture(t); const second = await f.publish('doc-second', [ref(f.revision)]);
  const info = await f.publish('doc-info', [ref(f.revision, 'informational')]); let sequence = 0;
  const activate = async (revision: any) => {
    const policy = f.config.genesis.policies.find(p => p.document_id === revision.payload.document_id)!;
    const proposal = await f.app.service.propose(f.writer, { revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1, command_id: `impact-propose-${++sequence}` });
    for (const actor of [f.writer, f.reviewer]) await f.app.service.decide(actor, proposal.result.proposal_id, { decision: 'approve', rationale: 'Fictional fixture only', command_id: `impact-approve-${++sequence}` });
    return f.app.service.activate(f.writer, proposal.result.proposal_id, { expected_active_agreement_id: null, command_id: `impact-activate-${++sequence}` });
  };
  const source = await activate(f.revision); await activate(second); await activate(info);
  assert.ok((await f.app.service.revisionImpact(f.writer, f.digest)).revisions.every((r: any) => r.eligible));
  await f.app.service.changeAgreement(f.writer, source.result.agreement_id, 'withdraw', { reason: 'Fixture withdrawal', command_id: 'impact-withdraw' });
  const current = await f.app.service.revisionImpact(f.writer, f.digest);
  assert.equal(current.revisions.find((r: any) => r.revision_digest === second.revision_digest).eligible, false);
  assert.equal(current.revisions.find((r: any) => r.revision_digest === info.revision_digest).eligible, true);
});

test('notification storage failure rolls back comment and schedule changes atomically', async t => {
  const f = await fixture(t); const store = (f.app.service as any).vault.reviews; const db = store.db;
  const original = db.prepare.bind(db); let fail = true;
  db.prepare = (sql: string) => { if (fail && sql.startsWith('INSERT OR IGNORE INTO review_notifications')) throw new Error('Synthetic notification failure'); return original(sql); };
  await assert.rejects(f.app.service.scheduleReview(f.writer, f.digest, f.schedule()));
  assert.equal((await f.app.service.review(f.writer, f.digest)).schedule, null);
  assert.equal((await f.app.service.review(f.writer, f.digest)).events.length, 0);
  fail = false; await f.app.service.scheduleReview(f.writer, f.digest, f.schedule());
  assert.equal((await f.app.service.reviewNotifications(f.reviewer)).notifications.length, 1);
});
