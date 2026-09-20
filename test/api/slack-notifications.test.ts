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

const address = { team_id: 'TTEST123', user_id: 'UTEST123', dm_id: 'DTEST123' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(t: any, changes: any = {}) {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-slack-')); let dataDir = join(root, 'runtime');
  const config = createProjectTemplate(['AlphaMSP', 'BetaMSP'], 'slack-test'); const author = config.bootstrap_actor;
  const recipient = { org_id: 'BetaMSP', actor_id: 'maintainer', kind: 'human' as const };
  const remote = { post: 'accept', allowed: true, keys: 0, calls: [] as string[], posted: [] as any[], policies: [] as any[] };
  const target: any = { address, recipient: { org_id: recipient.org_id, actor_id: recipient.actor_id }, version: 1, appUrl: 'https://knowledger.example/',
    getBotToken: () => { remote.keys++; return 'xoxb-FIXTURE-TOKEN'; },
    allows: (request: any) => { remote.policies.push(request); return remote.allowed; },
    fetch: async (url: string, input: any) => {
      remote.calls.push(url);
      if (url.endsWith('auth.test')) return json({ ok: true, team_id: address.team_id, bot_id: 'BBOT123' });
      if (url.endsWith('conversations.open')) return json({ ok: true, channel: { id: address.dm_id, user: address.user_id, is_im: true } });
      remote.posted.push(JSON.parse(input.body));
      if (remote.post === 'lost') throw new Error('SECRET_RESPONSE_LOST');
      if (remote.post === 'hang') return new Promise<Response>(() => {});
      return json({ ok: true, channel: address.dm_id, ts: '1726839000.000001' });
    }, ...changes.target };
  const options = { reviewReminders: { pollMs: 0 }, slackNotifications: { targets: [target], worker: { pollMs: 0, ...changes.worker } } };
  let app = await createConfiguredApp(config, { dataDir, port: 0, ...options });
  let closed = false; const close = async () => { if (!closed) { closed = true; await app.close(); } };
  t.after(async () => { await close(); rmSync(root, { recursive: true, force: true }); });
  const draft = await app.service.draft(author, { document_id: 'doc-shared-guideline', context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1', title: 'PRIVATE_TITLE', body_markdown: 'PRIVATE_BODY' });
  const preview = await app.service.preview(author, { draft_id: draft.draft_id });
  await app.service.publish(author, { preview_id: preview.preview_id, confirm_shared: true, command_id: 'slack-publish' });
  const digest = draft.revision.revision_digest; const now = Date.now();
  await app.service.scheduleReview(author, digest, { operation_id: 'slack-schedule', expected_version: 0,
    assignees: [{ org_id: recipient.org_id, actor_id: recipient.actor_id }], due_at: new Date(now).toISOString(), repeat_after_days: null });
  await app.service.reviewReminders!.runOnce(now);
  const notice = (await app.service.reviewReminderList(recipient)).reminders[0];
  return { get app() { return app; }, get dataDir() { return dataDir; }, recipient, author, digest, now, notice, remote, close,
    run: () => app.service.slackNotifications!.worker.runOnce(),
    status: async () => (await app.service.reviewReminderList(recipient)).reminders[0]?.slack,
    async restore(change: any = {}) { await close(); const snapshotDir = join(root, 'snapshot'); createRuntimeSnapshot({ dataDir, snapshotDir });
      dataDir = join(root, 'restored'); restoreRuntimeSnapshot({ dataDir, snapshotDir }); options.slackNotifications.targets = [{ ...target, ...change }];
      app = await createConfiguredApp(config, { dataDir, port: 0, ...options }); closed = false; } };
}

test('Slack deadline notices are minimal, recipient-scoped and persist provider acceptance without approvals', async t => {
  const f = await fixture(t); const before = f.app.service.ledger.checkpoint();
  assert.deepEqual(await f.run(), { scanned: 1, created: 1 });
  const first = await f.status(); assert.equal(first?.status, 'provider_accepted'); assert.equal(first?.receipt?.provider, 'slack');
  await f.run(); assert.equal(f.remote.posted.length, 1);
  for (const value of [f.remote.posted, f.remote.policies]) { assert.equal(JSON.stringify(value).includes('PRIVATE_TITLE'), false); assert.equal(JSON.stringify(value).includes('PRIVATE_BODY'), false); }
  assert.deepEqual(f.app.service.ledger.checkpoint(), before); assert.equal(f.app.service.values('decision').length, 0);
  assert.equal((await f.app.service.reviewReminderList(f.author)).reminders.length, 0);
  assert.equal((f.app.service as any).vault.slackNotices.get(f.author, f.notice.reminder_id), null);
  await f.restore(); assert.deepEqual(await f.status(), first); await f.run(); assert.equal(f.remote.posted.length, 1);
});

test('a lost Slack response remains unknown across restore and cannot be retried by the worker', async t => {
  const f = await fixture(t); f.remote.post = 'lost'; await f.run();
  assert.equal((await f.status())?.status, 'unknown'); await f.restore(); f.remote.post = 'accept'; await f.run();
  assert.equal(f.remote.posted.length, 1); assert.equal((await f.status())?.status, 'unknown');
});

test('absent and false egress policies perform zero credential and external calls', async t => {
  for (const allows of [undefined, async () => false, async () => 'true']) {
    const f = await fixture(t, { target: { allows } }); await f.run();
    assert.equal(f.remote.keys, 0); assert.equal(f.remote.calls.length, 0); assert.equal((await f.status())?.status, 'blocked');
  }
});

test('read, completed and superseded reminders are not sent externally', async t => {
  const read = await fixture(t); await read.app.service.readReviewReminder(read.recipient, read.notice.reminder_id, {}); await read.run(); assert.equal(read.remote.calls.length, 0);
  const completed = await fixture(t); await completed.app.service.completeReview(completed.recipient, completed.digest, { operation_id: 'complete-review', expected_version: 1, body: 'Reviewed' }); await completed.run(); assert.equal(completed.remote.calls.length, 0);
  const overdue = await fixture(t); await overdue.app.service.reviewReminders!.runOnce(overdue.now + 86400000); await overdue.run();
  assert.equal(overdue.remote.posted.length, 1); assert.match(overdue.remote.posted[0].text, /지났습니다/);
});

test('completion during credential lookup is rechecked before the first external call', async t => {
  let release!: (value: string) => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
  const f = await fixture(t, { target: { getBotToken: () => { reached(); return new Promise(resolve => { release = resolve; }); } } });
  const run = f.run(); await entered;
  await f.app.service.completeReview(f.recipient, f.digest, { operation_id: 'complete-while-key', expected_version: 1, body: 'Reviewed' });
  release('xoxb-FIXTURE'); await run; assert.equal(f.remote.calls.length, 0);
  assert.equal((f.app.service as any).vault.slackNotices.get(f.recipient, f.notice.reminder_id).status, 'blocked');
});

test('serving freeze, membership withdrawal and policy revocation block current sends', async t => {
  const f = await fixture(t); const read = f.app.service.ledger.read.bind(f.app.service.ledger); let frozen = true;
  f.app.service.ledger.read = (key: string, at: any) => { const value = read(key, at); return key === keyFor.config() ? { ...value, serving_enabled: !frozen } : value; };
  await f.run(); assert.equal(f.remote.calls.length, 0); frozen = false; f.remote.allowed = false; await f.run(); assert.equal(f.remote.calls.length, 0);
  f.app.service.ledger.read = read;
  const removed = await fixture(t); const original = removed.app.service.ledger.read.bind(removed.app.service.ledger);
  removed.app.service.ledger.read = (key: string, at: any) => { const value = original(key, at); return key === keyFor.config() ? { ...value, identities: value.identities.filter((i: any) => i.org_id !== removed.recipient.org_id) } : value; };
  await assert.rejects(removed.run()); assert.equal(removed.remote.calls.length, 0); removed.app.service.ledger.read = original;
});

test('changed recipient binding cannot retry an earlier persisted attempt', async t => {
  const f = await fixture(t, { target: { getBotToken: () => { throw new Error('SECRET_UNAVAILABLE'); } } });
  await f.run(); assert.equal((await f.status())?.status, 'retry_wait');
  await f.restore({ version: 2, getBotToken: () => 'xoxb-FIXTURE' }); await f.run();
  assert.equal(f.remote.calls.length, 0); assert.equal((await f.status())?.status, 'blocked');
});

test('shutdown during a posted request saves unknown and completes without waiting on the provider', async t => {
  const f = await fixture(t); f.remote.post = 'hang'; const running = f.run(); const rejected = assert.rejects(running);
  while (!f.remote.posted.length) await delay(2);
  await f.close(); await rejected;
  const store = new PrivateStore(join(f.dataDir, 'private-local.sqlite'));
  try { assert.equal(store.slackNotices.get(f.recipient, f.notice.reminder_id)?.status, 'unknown'); } finally { store.close(); }
});

test('shutdown during a hung ledger refresh stops promptly and cannot create late jobs', async t => {
  const f = await fixture(t); let release!: () => void; let reached!: () => void; const entered = new Promise<void>(resolve => { reached = resolve; });
  f.app.service.ledger.refresh = () => { reached(); return new Promise<void>(resolve => { release = resolve; }); };
  const running = f.run(); const rejected = assert.rejects(running); await entered; await f.close(); await rejected;
  release(); await delay(5); assert.equal(f.remote.calls.length, 0);
});

test('configured automatic worker sends after listening and repeated ticks retain one acceptance', async t => {
  const f = await fixture(t, { worker: { pollMs: 5 } }); await f.app.listen(0);
  for (let i = 0; i < 100 && !f.remote.posted.length; i++) await delay(5);
  assert.equal(f.remote.posted.length, 1); await delay(20); assert.equal(f.remote.posted.length, 1);
});

test('two stores share claims, hold the DM and never reclaim an expired ambiguous send', () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-slack-store-')); const path = join(root, 'private.sqlite');
  const first = new PrivateStore(path); const second = new PrivateStore(path); const actor = { org_id: 'AlphaMSP', actor_id: 'maintainer', kind: 'human' as const }; const binding = 'sha256:' + 'a'.repeat(64);
  try {
    const one = first.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DTEST', 1000, 1000)!; assert.ok(one);
    assert.equal(second.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DTEST', 1500, 1000), null);
    assert.equal(second.slackNotices.claim(actor, 'reminder-two', binding, 'TTEST', 'DTEST', 1500, 1000), null);
    assert.equal(second.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DTEST', 2000, 1000), null);
    assert.equal(first.slackNotices.get(actor, 'reminder-one')?.status, 'unknown');
    first.slackNotices.settle(actor, one, 'TTEST', 'DTEST', { status: 'retry_wait', code: 'SLACK_UNAVAILABLE', retry_after_ms: 1000 }, 2001);
    assert.equal(first.slackNotices.get(actor, 'reminder-one')?.status, 'unknown');
  } finally { second.close(); first.close(); rmSync(root, { recursive: true, force: true }); }
});

test('rate limits persist across DM targets and retries stop after three confirmed retryable failures', () => {
  const store = new PrivateStore(':memory:'); const actor = { org_id: 'AlphaMSP', actor_id: 'maintainer', kind: 'human' as const }; const binding = 'sha256:' + 'a'.repeat(64);
  try {
    let now = 1000;
    for (let i = 1; i <= 3; i++) {
      const job = store.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DONE', now, 1000)!; assert.equal(job.attempts, i);
      store.slackNotices.settle(actor, job, 'TTEST', 'DONE', { status: 'retry_wait', code: 'SLACK_RATE_LIMITED', retry_after_ms: 17000 }, now);
      assert.equal(store.slackNotices.claim(actor, 'reminder-other', binding, 'TTEST', 'DTWO', now + 1000, 1000), null);
      assert.equal(store.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DONE', now + 16999, 1000), null); now += 17000;
    }
    assert.equal(store.slackNotices.get(actor, 'reminder-one')?.status, 'failed');
    assert.equal(store.slackNotices.claim(actor, 'reminder-one', binding, 'TTEST', 'DONE', now, 1000), null);
  } finally { store.close(); }
});
