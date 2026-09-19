import test from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoApp } from '../../examples/order-workflow/application.ts';
import { ReadinessMonitor } from '../../apps/api/readiness.ts';
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
    const created: unknown = await createDemoApp({ dataDir: directory, shutdownDeadlineMs }).then(app => app, (error: unknown) => error);
    if (created instanceof Error) { assert.match(created.message, /shutdownDeadlineMs/); return; }
    // Error가 아닌 거절 값이면 close() 접근이 TypeError로 원인을 가린다 — 형태를 먼저 단언한다.
    const closable = created as { close?: unknown };
    if (!closable || typeof closable.close !== 'function') assert.fail('startup must reject with an Error, not a non-Error value');
    await (closable as { close(): Promise<void> }).close();
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
  // HTTP 종료가 거부돼도 나머지 해제 단계는 실행돼야 한다 — 실제 close는 t.after에서 복구해 마무리한다.
  const originalClose = app.server.close.bind(app.server);
  app.server.close = ((callback: (error?: Error) => void) => { callback(new Error('injected close boom')); return app.server; }) as Server['close'];
  t.after(async () => {
    app.server.close = originalClose;
    await new Promise<void>(resolve => { app.server.close(() => resolve()); });
  });
  const failure = await app.close().then(() => assert.fail('app.close must reject when the HTTP close rejects'), (error: unknown) => error);
  assert.ok(failure instanceof Error && /injected close boom/.test(failure.message), 'the single failure rethrows the original error');
  assert.equal((failure as { stage?: string }).stage, 'http', 'a single failure still carries its stage name');
  assert.equal(indexClosed, true, 'vectorIndex.close must still run when the HTTP close rejects');
});

test('app.close still tears down HTTP and stores when readiness teardown fails', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-readiness-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let indexClosed = false;
  const vectorIndex: VectorCandidateIndex = { candidates: () => [], close: () => { indexClosed = true; } };
  const app = await createDemoApp({ dataDir: directory, vectorIndex, embedQuery: () => [1, 0, 0], embedRevision: () => [1, 0, 0], seed: false });
  await app.listen(0);
  let serverCloseCalls = 0;
  const originalServerClose = app.server.close.bind(app.server);
  app.server.close = ((callback?: (error?: Error) => void) => { serverCloseCalls++; return originalServerClose(callback); }) as Server['close'];
  const originalReadinessClose = ReadinessMonitor.prototype.close;
  try {
    // readiness 해제 실패가 HTTP 종료와 저장소 해제를 건너뛰게 하지 않는지 본다.
    ReadinessMonitor.prototype.close = () => { throw new Error('readiness boom'); };
    await assert.rejects(() => app.close(), /readiness boom/);
    assert.equal(serverCloseCalls, 1, 'HTTP close must still run when readiness teardown fails');
    assert.equal(indexClosed, true, 'store teardown must still run when readiness teardown fails');
  } finally {
    ReadinessMonitor.prototype.close = originalReadinessClose;
    app.server.close = originalServerClose;
    await new Promise<void>(resolve => { app.server.close(() => resolve()); });
  }
});

test('app.close forwards shutdownDeadlineMs and labels diagnostics as api', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-label-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createDemoApp({ dataDir: directory, shutdownDeadlineMs: 60, seed: false });
  await app.listen(0);
  const originalClose = app.server.close.bind(app.server);
  try {
    // close 콜백을 가로채 abandon 경로를 탄다 — 60ms 마감의 강제 해제와 'api' 레이블이 진단에 도달해야 한다.
    app.server.close = (() => app.server) as Server['close'];
    const started = Date.now();
    await app.close();
    // 마감 60 + 기본 정착 250 + 진단 예산 100 — 기본값(5000)이 전달되지 않았다면 이 상한 안에 끝날 수 없다.
    assert.ok(Date.now() - started < 2_000, 'the 60ms deadline must reach closeHttpServer');
    const messages = diagnostic.mock.calls.map(call => String(call.arguments[0])).filter(m => /HTTP 종료/.test(m));
    assert.ok(messages.some(m => /\[api\]/.test(m) && /강제 해제/.test(m)), 'the api label reaches the forced-release diagnostic');
    assert.ok(messages.some(m => /\[api\]/.test(m) && /마감까지/.test(m)), 'the api label reaches the abandon diagnostic');
  } finally {
    app.server.close = originalClose;
    await new Promise<void>(resolve => { app.server.close(() => resolve()); });
  }
});

test('app.close aggregates multiple teardown failures into one AggregateError', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-aggregate-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createDemoApp({ dataDir: directory, seed: false });
  await app.listen(0);
  const originalReadinessClose = ReadinessMonitor.prototype.close;
  const originalServerClose = app.server.close.bind(app.server);
  try {
    // 두 단계가 함께 실패하면 어느 오류도 덮어쓰지 않고 AggregateError로 보고돼야 한다.
    ReadinessMonitor.prototype.close = () => { throw new Error('readiness boom'); };
    app.server.close = ((callback?: (error?: Error) => void) => { callback?.(new Error('http close boom')); return app.server; }) as Server['close'];
    const failure = await app.close().then(
      () => assert.fail('app.close must reject when two teardown stages fail'),
      error => error,
    );
    assert.ok(failure instanceof AggregateError, 'multiple teardown failures must surface as AggregateError');
    assert.equal(failure.errors.length, 2, 'both stage failures are collected');
    assert.match(String(failure.message), /readiness.*http|http.*readiness/, 'the message names the failed stages');
    assert.deepEqual((failure as { stages?: string[] }).stages, ['readiness', 'http'], 'the stages array aligns with errors order for machine aggregation');
    assert.ok(failure.errors.some((e: unknown) => e instanceof Error && /readiness boom/.test(e.message)), 'the readiness failure is preserved');
    assert.ok(failure.errors.some((e: unknown) => e instanceof Error && /http close boom/.test(e.message)), 'the http failure is preserved');
  } finally {
    ReadinessMonitor.prototype.close = originalReadinessClose;
    app.server.close = originalServerClose;
    await new Promise<void>(resolve => { app.server.close(() => resolve()); });
  }
});
