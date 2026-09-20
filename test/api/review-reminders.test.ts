import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfiguredApp } from '../../apps/api/configured-runtime.ts';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../../packages/storage/runtime-snapshot.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { keyFor } from '../../packages/domain/index.ts';

async function fixture(t: any, options: any = { pollMs: 0, overdueAfterMs: 1000, batchSize: 2 }) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-reminders-')); let dataDir = join(root, 'runtime');
  const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'reminder-test'); const author = config.bootstrap_actor;
  const recipient = { org_id: 'BetaMSP', actor_id: 'maintainer', kind: 'human' as const };
  let app = await createConfiguredApp(config, { dataDir, port: 0, reviewReminders: options }); let seq = 0;
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const publish = async (document_id = 'doc-shared-guideline') => {
    const draft = await app.service.draft(author, { document_id, context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1', title: document_id, body_markdown: '# Reminder fixture' });
    const preview = await app.service.preview(author, { draft_id: draft.draft_id });
    await app.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: `reminder-publish-${++seq}` }); return draft.revision.revision_digest;
  };
  const digest = await publish(); const now = Date.now();
  const schedule = (id = digest, extra: any = {}) => app.service.scheduleReview(author, id, { operation_id: `reminder-schedule-${++seq}`, expected_version: 0,
    assignees: [{ org_id: recipient.org_id, actor_id: recipient.actor_id }], due_at: new Date(now).toISOString(), repeat_after_days: null, ...extra });
  return { get app() { return app; }, get dataDir() { return dataDir; }, author, recipient, digest, now, publish, schedule,
    async restore() { await app.close(); const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir, snapshotDir }); dataDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir, snapshotDir }); app = await createConfiguredApp(config, { dataDir, port: 0, reviewReminders: options }); } };
}

test('due and overdue notices occur once per schedule version without ledger writes or human events', async t => {
  const f = await fixture(t); await f.schedule(); const before = f.app.service.ledger.checkpoint();
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now - 1)).created, 0);
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now)).created, 1);
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now + 999)).created, 0);
  let inbox = await f.app.service.reviewReminderList(f.recipient); assert.equal(inbox.unread_count, 1); assert.equal(inbox.reminders[0].phase, 'due');
  await f.app.service.readReviewReminder(f.recipient, inbox.reminders[0].reminder_id, {});
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now + 1000)).created, 1);
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now + 2000)).created, 0);
  inbox = await f.app.service.reviewReminderList(f.recipient); assert.equal(inbox.reminders.length, 2); assert.equal(inbox.unread_count, 1); assert.equal(inbox.reminders[0].phase, 'overdue');
  assert.equal((await f.app.service.reviewReminderList(f.author)).reminders.length, 0);
  await assert.rejects(f.app.service.readReviewReminder(f.author, inbox.reminders[0].reminder_id, {}), (e: any) => e.status === 404);
  assert.deepEqual(f.app.service.ledger.checkpoint(), before);
  assert.equal((await f.app.service.review(f.author, f.digest)).events.length, 1, 'only the human schedule event exists');
  assert.equal(f.app.service.values('decision').length, 0);
});

test('restart and stopped-app restore retain read state and deduplicate downtime catch-up', async t => {
  const f = await fixture(t); await f.schedule();
  await f.app.service.reviewReminders!.runOnce(f.now + 5000);
  const inbox = await f.app.service.reviewReminderList(f.recipient);
  assert.equal(inbox.reminders.length, 1); assert.equal(inbox.reminders[0].phase, 'overdue', 'downtime does not emit both phases at once');
  await f.app.service.readReviewReminder(f.recipient, inbox.reminders[0].reminder_id, {});
  await f.restore(); assert.equal((await f.app.service.reviewReminders!.runOnce(f.now + 6000)).created, 0);
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now)).created, 0, 'clock rollback cannot emit due after overdue');
  const restored = await f.app.service.reviewReminderList(f.recipient);
  assert.equal(restored.reminders[0].reminder_id, inbox.reminders[0].reminder_id); assert.equal(restored.unread_count, 0);
});

test('reschedule, reassignment and completion hide stale notices and start a new recurring cycle', async t => {
  const f = await fixture(t); await f.schedule(); await f.app.service.reviewReminders!.runOnce(f.now);
  const old = (await f.app.service.reviewReminderList(f.recipient)).reminders[0];
  await f.schedule(f.digest, { expected_version: 1, assignees: [{ org_id: f.author.org_id, actor_id: f.author.actor_id }], repeat_after_days: 1 });
  assert.equal((await f.app.service.reviewReminderList(f.recipient)).reminders.length, 0);
  await assert.rejects(f.app.service.readReviewReminder(f.recipient, old.reminder_id, {}), (e: any) => e.status === 404);
  await f.app.service.reviewReminders!.runOnce(f.now);
  assert.equal((await f.app.service.reviewReminderList(f.author)).unread_count, 1);
  const completed = await f.app.service.completeReview(f.author, f.digest, { operation_id: 'reminder-complete', expected_version: 2, body: 'Fictional review completion' });
  assert.equal((await f.app.service.reviewReminderList(f.author)).unread_count, 0);
  await f.app.service.reviewReminders!.runOnce(Date.parse(completed.schedule!.due_at!));
  const current = await f.app.service.reviewReminderList(f.author);
  assert.equal(current.reminders.length, 1); assert.equal(current.reminders[0].schedule_version, 3);
});

test('concurrent database handles deduplicate notices and stale captured schedules cannot create one', async t => {
  const f = await fixture(t); await f.schedule(); const first = (f.app.service as any).vault.reviews;
  const second = new PrivateStore(join(f.dataDir, 'private-local.sqlite'));
  try {
    const timestamp = new Date(f.now).toISOString(); const earlier = new Date(f.now - 1000).toISOString();
    const a = first.reminderCandidates(timestamp, earlier, null, 2)[0]; const b = second.reviews.reminderCandidates(timestamp, earlier, null, 2)[0];
    assert.equal(first.recordReminder(a, timestamp), true); assert.equal(second.reviews.recordReminder(b, timestamp), false);
    await f.schedule(f.digest, { expected_version: 1, due_at: new Date(f.now + 5000).toISOString() });
    assert.equal(second.reviews.recordReminder(b, timestamp), false);
    assert.equal((await f.app.service.reviewReminderList(f.recipient)).unread_count, 0);
  } finally { second.close(); }
});

test('a bounded scan advances past revoked recipients and current serving freeze prevents generation', async t => {
  const f = await fixture(t, { pollMs: 0, overdueAfterMs: 1000, batchSize: 1 }); await f.schedule();
  const next = await f.publish('doc-other'); await f.schedule(next, { due_at: new Date(f.now + 1).toISOString(), assignees: [{ org_id: f.author.org_id, actor_id: f.author.actor_id }] });
  const read = f.app.service.ledger.read.bind(f.app.service.ledger); let frozen = true;
  f.app.service.ledger.read = (key: string, at: any) => { const value = read(key, at); return key === keyFor.config() ? { ...value, serving_enabled: !frozen, identities: value.identities.filter((i: any) => i.org_id !== f.recipient.org_id) } : value; };
  await assert.rejects(f.app.service.reviewReminders!.runOnce(f.now + 2));
  assert.equal(f.app.service.reviewReminders!.lastError, 'REMINDER_UNAVAILABLE'); frozen = false;
  assert.deepEqual(await f.app.service.reviewReminders!.runOnce(f.now + 2), { scanned: 1, created: 0 });
  assert.deepEqual(await f.app.service.reviewReminders!.runOnce(f.now + 2), { scanned: 1, created: 1 });
  assert.equal((await f.app.service.reviewReminderList(f.author)).reminders.length, 1);
  f.app.service.ledger.read = read;
});

test('shutdown during refresh cannot write a late reminder; explicit disable creates no worker', async t => {
  const f = await fixture(t); await f.schedule(); let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const refresh = f.app.service.ledger.refresh.bind(f.app.service.ledger); f.app.service.ledger.refresh = async () => { entered(); await gate; };
  const running = f.app.service.reviewReminders!.runOnce(f.now); const rejected = assert.rejects(running, /REMINDER_UNAVAILABLE/);
  await started; await f.app.service.reviewReminders!.close(); await rejected; release(); await delay(10); f.app.service.ledger.refresh = refresh;
  assert.equal((await f.app.service.reviewReminderList(f.recipient)).reminders.length, 0);
  const disabled = await fixture(t, false); assert.equal(disabled.app.service.reviewReminders, undefined);
  assert.equal((await disabled.app.service.reviewReminderList(disabled.author)).automation.enabled, false);
});

test('reminder HTTP routes protect recipient state and enforce pagination/CSRF', async t => {
  const f = await fixture(t); await f.schedule(f.digest, { assignees: [{ org_id: f.author.org_id, actor_id: f.author.actor_id }] });
  await f.app.service.reviewReminders!.runOnce(f.now); await f.app.service.reviewReminders!.runOnce(f.now + 1000);
  const origin = await f.app.listen(0); const login = await fetch(origin + '/api/session'); const cookie = login.headers.get('set-cookie')!.split(';')[0]; const session = await login.json() as any;
  const root = origin + '/v1/workspaces/reminder-test'; const headers = { Cookie: cookie };
  const first = await (await fetch(root + '/review-reminders?limit=1', { headers })).json() as any; assert.equal(first.reminders.length, 1); assert.ok(first.next_cursor);
  const second = await (await fetch(root + '/review-reminders?limit=1&cursor=' + first.next_cursor, { headers })).json() as any; assert.notEqual(first.reminders[0].reminder_id, second.reminders[0].reminder_id);
  for (const query of ['?limit=51', '?limit=1&limit=2', '?cursor=-1', '?unknown=1']) assert.equal((await fetch(root + '/review-reminders' + query, { headers })).status, 400);
  const path = root + `/review-reminders/${first.reminders[0].reminder_id}/read`;
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(path, { method: 'POST', headers: { ...headers, Origin: origin, 'X-KNOWLEDGER-CSRF': session.csrf_token, 'Content-Type': 'application/json' }, body: '{}' })).status, 200);
});

test('automatic scheduling creates one local reminder after listen and avoids repeated ticks', async t => {
  const f = await fixture(t, { pollMs: 5, overdueAfterMs: 86400000, batchSize: 10 }); await f.schedule(); await f.app.listen(0);
  for (let i = 0; i < 50 && !(await f.app.service.reviewReminderList(f.recipient)).reminders.length; i++) await delay(10);
  assert.equal((await f.app.service.reviewReminderList(f.recipient)).reminders.length, 1); await delay(20);
  assert.equal((await f.app.service.reviewReminderList(f.recipient)).reminders.length, 1);
});

test('a timed-out refresh cannot create a late notice and a subsequent healthy tick recovers', async t => {
  const f = await fixture(t, { pollMs: 0, timeoutMs: 20, overdueAfterMs: 86400000 }); await f.schedule();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const refresh = f.app.service.ledger.refresh.bind(f.app.service.ledger); f.app.service.ledger.refresh = async () => { await gate; };
  await assert.rejects(f.app.service.reviewReminders!.runOnce(f.now), /REMINDER_UNAVAILABLE/);
  release(); await delay(10); f.app.service.ledger.refresh = refresh;
  assert.equal((await f.app.service.reviewReminderList(f.recipient)).reminders.length, 0);
  assert.equal((await f.app.service.reviewReminders!.runOnce(f.now)).created, 1);
  assert.equal(f.app.service.reviewReminders!.lastError, null);
});
