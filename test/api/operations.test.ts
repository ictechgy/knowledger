import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';

async function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-ops-test-'));
  const app = await createApp({ dataDir: directory });
  const url = await app.listen(0);
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  return { url };
}

test('operations view requires a session and reports verified metadata only', async t => {
  const { url } = await fixture(t);
  const unauthenticated = await fetch(`${url}/v1/workspaces/demo/operations`);
  assert.equal(unauthenticated.status, 401);

  const initial = await fetch(`${url}/api/session`);
  const cookie = initial.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(`${url}/v1/workspaces/demo/operations`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const view = await response.json() as any;
  assert.equal(view.view, 'operations');
  assert.equal(view.mode, 'local-simulation');
  assert.equal(view.channel_id, 'kcl-demo');
  assert.equal(view.ledger_available, true);
  assert.equal(typeof view.generated_at, 'string');
  assert.equal(typeof view.process_uptime_ms, 'number');
  assert.equal(view.readiness.healthy === true || view.readiness.healthy === false, true);
  assert.equal(view.checkpoint?.block_number >= 1, true);
  assert.match(view.checkpoint?.block_hash ?? '', /^[a-f0-9]{64}$/);
  assert.equal(view.configuration?.serving_enabled, true);
  assert.equal(typeof view.counts?.documents, 'number');
  assert.equal(typeof view.counts?.proposals, 'number');
  assert.equal(typeof view.counts?.agreements, 'number');
  // 운영 스냅샷은 문서 본문이나 비공개 데이터를 포함하지 않는다.
  assert.equal(JSON.stringify(view).includes('body_markdown'), false);
  for (const event of view.recent_events) {
    assert.equal(event.validation_code, undefined);
    assert.equal(typeof event.writes, 'number');
    assert.ok(Array.isArray(event.kinds));
  }
});

test('operations view still rejects identities outside the configuration', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-ops-test-'));
  const app = await createApp({ dataDir: directory });
  await app.listen(0);
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  await assert.rejects(
    () => app.service.operations({ org_id: 'UnknownMSP', actor_id: 'person-nobody', kind: 'human' }),
    (error: any) => error.code === 'NOT_FOUND',
  );
});
