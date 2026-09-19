import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoApp } from '../../examples/order-workflow/application.ts';
import { MAX_TIMEOUT_MS } from '../../packages/http/graceful-close.ts';
import type { VectorCandidateIndex } from '../../packages/storage/vector-index.ts';

/**
 * 앱 수준 종료 동작 — packages/http의 closeHttpServer를 쓰는 createApp의 계약을 본다.
 * 서버·타이머 수준의 불변식은 test/http/graceful-close.test.ts가 담당한다.
 */

test('createApp rejects an invalid shutdown deadline at startup instead of half-closing', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-bound-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // 검증이 회귀해 앱이 생성돼도 러너가 매달리지 않게 성공 시 닫고 실패를 보고한다.
  const rejectsStartup = async (shutdownDeadlineMs: number) => {
    const created = await createDemoApp({ dataDir: directory, shutdownDeadlineMs }).then(app => app, (error: unknown) => error);
    if (created instanceof Error) { assert.match(created.message, /shutdownDeadlineMs/); return; }
    await created.close();
    assert.fail(`shutdownDeadlineMs=${shutdownDeadlineMs} must reject at startup`);
  };
  // 메시지까지 단언한다 — RangeError만 보면 다른 기동 검증의 RangeError로 위장 통과할 수 있다.
  await rejectsStartup(-1);
  await rejectsStartup(Number.NaN);
  // 단독으로는 범위 안이지만 기본 정착 상한과의 합이 넘치는 값 — 기동에서 거절되지 않으면 close() 시점에 뒤늦게 실패한다.
  await rejectsStartup(MAX_TIMEOUT_MS - 100);
});

test('app.close still runs resource teardown when the HTTP close rejects', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-teardown-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let indexClosed = false;
  const vectorIndex: VectorCandidateIndex = { candidates: () => [], close: () => { indexClosed = true; } };
  const app = await createDemoApp({ dataDir: directory, vectorIndex, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0], seed: false });
  await app.listen(0);
  // HTTP 종료가 거부돼도 finally의 자원 해제는 실행돼야 한다 — 실제 close는 t.after에서 복구해 마무리한다.
  const originalClose = app.server.close.bind(app.server);
  app.server.close = ((callback: (error?: Error) => void) => { callback(new Error('injected close boom')); return app.server; }) as Server['close'];
  t.after(async () => {
    app.server.close = originalClose;
    await new Promise<void>(resolve => { app.server.close(() => resolve()); });
  });
  await assert.rejects(() => app.close(), /injected close boom/);
  assert.equal(indexClosed, true, 'vectorIndex.close must still run when the HTTP close rejects');
});
