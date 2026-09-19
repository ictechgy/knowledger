import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeHttpServer } from '../../packages/http/graceful-close.ts';

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

test('closeHttpServer rejects non-finite or negative close bounds', async () => {
  const server = createServer();
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: -1 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { settleMs: -5 }), RangeError);
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
    assert.equal(diagnostic.mock.callCount(), 0, 'a clean close must not emit the forced diagnostic');
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
    assert.equal(diagnostic.mock.callCount(), 0, 'no forced release happens inside the deadline');
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
    assert.equal(diagnostic.mock.callCount(), 1, 'forced release reports a diagnostic');
    const message = String(diagnostic.mock.calls[0].arguments[0]);
    assert.match(message, /test-server/, 'the diagnostic carries the server label');
    assert.match(message, /미해제 연결 \d+개/, 'the diagnostic carries the remaining connection count');
  } finally {
    socket.destroy();
  }
});

test('closeHttpServer abandons instead of hanging when the close callback never arrives', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.end('ok'); });
  const socket = connect(port, '127.0.0.1');
  const originalClose = server.close.bind(server);
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    // close 콜백이 도착하지 않는 최악(추적 끊긴 소켓 등)을 시뮬레이션한다.
    server.close = (() => server) as Server['close'];
    const started = Date.now();
    await closeHttpServer(server, { deadlineMs: 100, settleMs: 40, label: 'abandon-test' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 120, 'the abandon timer still lets the deadline elapse');
    assert.ok(elapsed < 2_000, 'a missing close callback cannot hang shutdown');
    assert.equal(diagnostic.mock.callCount(), 1, 'the abandon reports a diagnostic');
    const message = String(diagnostic.mock.calls[0].arguments[0]);
    assert.match(message, /abandon-test/, 'the diagnostic carries the server label');
    assert.match(message, /미해제 연결 \d+개/, 'the diagnostic carries the remaining connection count');
  } finally {
    socket.destroy();
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

test('closeHttpServer propagates a synchronous server.close throw without lingering timers', async () => {
  const { server } = await listeningServer((_req, res) => res.end());
  const originalClose = server.close.bind(server);
  try {
    server.close = (() => { throw new Error('sync boom'); }) as Server['close'];
    const started = Date.now();
    await assert.rejects(() => closeHttpServer(server, { deadlineMs: 5_000, settleMs: 250 }), /sync boom/);
    assert.ok(Date.now() - started < 500, 'a sync throw rejects immediately instead of lingering for the deadline');
  } finally {
    await releaseServer(server, originalClose);
  }
});
