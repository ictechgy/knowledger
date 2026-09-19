import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeHttpServer } from '../../packages/http/graceful-close.ts';
import { createApp } from '../../apps/api/server.ts';

/** 포트 0으로 듣는 서버를 띄워 주소를 돌려준다 — 매 테스트가 독립 포트를 쓰게 한다. */
async function listeningServer(handler: RequestListener): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

/** 소켓이 끊길 때까지 기다리되 상한을 둔다 — 이미 끊겼거나 close 이벤트가 안 오는 경우에도 테스트가 멈추지 않게 한다. */
async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await Promise.race([once(socket, 'close'), sleep(2_000, undefined, { ref: false })]);
}

/** 우리 종료 진단만 골라낸다 — 같은 stderr를 쓰는 Node 경고(실험 기능 경고 등)가 모킹에 섞이지 않게 한다. */
function httpDiagnostics(diagnostic: { mock: { calls: { arguments: unknown[] }[] } }): unknown[][] {
  return diagnostic.mock.calls.map(call => call.arguments).filter(args => /HTTP 종료/.test(String(args[0])));
}

/** 서버를 실제로 닫아 정리한다 — close를 스텁한 테스트가 프로세스에 열린 서버를 남기지 않게 한다. */
async function releaseServer(server: Server, originalClose: Server['close']): Promise<void> {
  server.close = originalClose;
  await new Promise<void>(resolve => { server.close(() => resolve()); });
}

test('closeHttpServer returns immediately for a non-listening server', async () => {
  const server = createServer();
  const started = Date.now();
  await closeHttpServer(server, { deadlineMs: 50 });
  assert.ok(Date.now() - started < 50, 'non-listening close must not wait for the deadline');
});

test('closeHttpServer rejects non-finite or out-of-range close bounds', async () => {
  const server = createServer();
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: -1 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { settleMs: -5 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: Number.NaN }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { settleMs: Number.POSITIVE_INFINITY }), RangeError);
  // Node는 타이머 상한(2^31-1)을 넘는 지연을 1ms로 강등한다 — 마감 순서 역전을 막기 위해 거절한다.
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: 2 ** 31 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: 2 ** 31 - 1, settleMs: 2 }), RangeError);
});

test('closeHttpServer reaps an idle keep-alive socket without waiting for the deadline', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.end('ok'); });
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await once(socket, 'data');
    const started = Date.now();
    await closeHttpServer(server, { deadlineMs: 10_000 });
    assert.ok(Date.now() - started < 3_000, 'idle keep-alive sockets must not stall close');
    assert.equal(httpDiagnostics(diagnostic).length, 0, 'a clean close must not emit the forced diagnostic');
  } finally {
    socket.destroy();
  }
});

test('closeHttpServer lets a request finishing mid-close complete without forcing', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  // 핸들러가 요청을 받은 뒤에만 닫아야 한다 — 파싱 전 소켓은 서버가 유휴로 간주해 스윕이 끊어버린다.
  let requestSeen!: () => void;
  const requestArrived = new Promise<void>(resolve => { requestSeen = resolve; });
  const { server, port } = await listeningServer((_req, res) => { requestSeen(); setTimeout(() => res.end('ok'), 80); });
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await requestArrived;
    const closePromise = closeHttpServer(server, { deadlineMs: 5_000 });
    let body = '';
    socket.on('data', chunk => { body += chunk.toString(); });
    const started = Date.now();
    await closePromise;
    assert.ok(Date.now() - started < 2_000, 'the request completes and its now-idle socket is re-swept');
    assert.ok(body.includes('ok'), 'the in-flight response is fully delivered');
    assert.equal(httpDiagnostics(diagnostic).length, 0, 'no forced release happens inside the deadline');
  } finally {
    socket.destroy();
  }
});

test('closeHttpServer force-releases a request that never finishes after the deadline', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.writeHead(200); res.flushHeaders(); });
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    const started = Date.now();
    await closeHttpServer(server, { deadlineMs: 150, settleMs: 30, label: 'test-server' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 140, 'the deadline still lets in-flight requests finish');
    assert.ok(elapsed < 3_000, 'stuck requests are force-released after the deadline');
    await waitForClose(socket);
    assert.equal(socket.destroyed, true, 'forced close destroys the held socket');
    assert.equal(httpDiagnostics(diagnostic).length, 1, 'forced release reports a diagnostic');
    const message = String(httpDiagnostics(diagnostic)[0][0]);
    assert.match(message, /test-server/, 'the diagnostic carries the server label');
    assert.match(message, /강제 해제/, 'the diagnostic names the forced-release reason');
    assert.match(message, /연결 [1-9]\d*개/, 'the diagnostic counts the sockets held at release');
  } finally {
    socket.destroy();
  }
});

test('closeHttpServer abandons instead of hanging when the close callback never arrives', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.end('ok'); });
  const socket = connect(port, '127.0.0.1');
  const originalClose = server.close.bind(server);
  let closeCallback: ((error?: Error) => void) | undefined;
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    // close 콜백이 도착하지 않는 최악(추적 끊긴 소켓 등)을 시뮬레이션한다 — 콜백은 가로채 둔다.
    server.close = ((callback: (error?: Error) => void) => { closeCallback = callback; return server; }) as Server['close'];
    const started = Date.now();
    await closeHttpServer(server, { deadlineMs: 100, settleMs: 40, label: 'abandon-test' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 120, 'the abandon timer still lets the deadline elapse');
    assert.ok(elapsed < 2_000, 'a missing close callback cannot hang shutdown');
    assert.equal(httpDiagnostics(diagnostic).length, 1, 'the abandon reports a diagnostic');
    const message = String(httpDiagnostics(diagnostic)[0][0]);
    assert.match(message, /abandon-test/, 'the diagnostic carries the server label');
    assert.match(message, /콜백이 도착하지 않아/, 'the diagnostic names the abandon reason');
    assert.match(message, /미해제 연결 0개/, 'the swept socket leaves exactly zero remaining connections');
    // 마감 뒤 도착한 close 오류는 settled promise가 버리지 않고 진단으로 남긴다.
    closeCallback?.(new Error('late boom'));
    assert.equal(httpDiagnostics(diagnostic).length, 2, 'a late close error is still reported');
    assert.match(String(httpDiagnostics(diagnostic)[1][0]), /abandon-test/, 'the late error carries the server label');
  } finally {
    socket.destroy();
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer degrades a connection-count lookup failure to an unknown count', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server } = await listeningServer((_req, res) => { res.end('ok'); });
  const originalClose = server.close.bind(server);
  const originalGetConnections = server.getConnections.bind(server);
  try {
    // close 콜백 미도착 + 연결 수 조회 실패 — 진단이 개수를 위장하지 않고 '알 수 없음'으로 내려야 한다.
    server.close = (() => server) as Server['close'];
    server.getConnections = ((callback: (error: Error | null, count: number) => void) => { callback(new Error('count boom'), 0); }) as Server['getConnections'];
    await closeHttpServer(server, { deadlineMs: 60, settleMs: 30, label: 'count-test' });
    assert.equal(httpDiagnostics(diagnostic).length, 1);
    assert.match(String(httpDiagnostics(diagnostic)[0][0]), /알 수 없음/, 'a lookup failure must not masquerade as a count');
  } finally {
    server.getConnections = originalGetConnections;
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer propagates a server.close error instead of hanging', async () => {
  const { server } = await listeningServer((_req, res) => res.end());
  const originalClose = server.close.bind(server);
  try {
    server.close = ((callback: (error?: Error) => void) => { callback(new Error('close boom')); return server; }) as Server['close'];
    await assert.rejects(() => closeHttpServer(server, { deadlineMs: 5_000 }), /close boom/);
  } finally {
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer still reports the forced release when close errors after the deadline', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.writeHead(200); res.flushHeaders(); });
  const socket = connect(port, '127.0.0.1');
  const originalClose = server.close.bind(server);
  let closeCallback: ((error?: Error) => void) | undefined;
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    // 마감 뒤 도착하는 close 오류가 강제 해제 사실을 지우지 않는지 본다 — 콜백은 가로채 둔다.
    server.close = ((callback: (error?: Error) => void) => { closeCallback = callback; return server; }) as Server['close'];
    const closePromise = closeHttpServer(server, { deadlineMs: 60, settleMs: 1_000, label: 'forced-error' });
    await sleep(120);
    closeCallback?.(new Error('late close boom'));
    await assert.rejects(() => closePromise, /late close boom/);
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    assert.equal(messages.length, 1, 'the forced release is reported even when close rejects');
    assert.match(messages[0], /강제 해제/, 'the diagnostic names the forced-release reason');
  } finally {
    socket.destroy();
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer releases exactly once when deadline and settle are both zero', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.writeHead(200); res.flushHeaders(); });
  const socket = connect(port, '127.0.0.1');
  const originalCloseAll = server.closeAllConnections.bind(server);
  let releases = 0;
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    server.closeAllConnections = (() => { releases++; originalCloseAll(); }) as Server['closeAllConnections'];
    await closeHttpServer(server, { deadlineMs: 0, settleMs: 0, label: 'zero-zero' });
    assert.equal(releases, 1, 'release runs exactly once even when both timers fire together');
    assert.equal(httpDiagnostics(diagnostic).length, 1, 'a single diagnostic is emitted');
  } finally {
    server.closeAllConnections = originalCloseAll;
    socket.destroy();
  }
});

test('createApp rejects an invalid shutdown deadline at startup instead of half-closing', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-close-bound-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  await assert.rejects(() => createApp({ dataDir: directory, shutdownDeadlineMs: -1 }), RangeError);
  await assert.rejects(() => createApp({ dataDir: directory, shutdownDeadlineMs: Number.NaN }), RangeError);
});

test('startDevelopmentIssuer rejects an invalid shutdown deadline at startup', async () => {
  const { startDevelopmentIssuer } = await import('../../packages/auth/development-issuer.ts');
  await assert.rejects(
    () => startDevelopmentIssuer({ accounts: [], port: 1, redirectUri: 'http://127.0.0.1:1/auth/callback', shutdownDeadlineMs: -1 }),
    RangeError,
  );
});

test('closeHttpServer propagates a synchronous server.close throw without lingering timers', async () => {
  const { server } = await listeningServer((_req, res) => res.end());
  const originalClose = server.close.bind(server);
  const timeouts = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  try {
    server.close = (() => { throw new Error('sync boom'); }) as Server['close'];
    const before = timeouts();
    await assert.rejects(() => closeHttpServer(server, { deadlineMs: 5_000, settleMs: 250 }), /sync boom/);
    await sleep(20);
    assert.equal(timeouts(), before, 'a sync throw must not leak the deadline timers');
  } finally {
    await releaseServer(server, originalClose);
  }
});
