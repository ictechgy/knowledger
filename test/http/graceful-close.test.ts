import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { closeHttpServer, MAX_TIMEOUT_MS } from '../../packages/http/graceful-close.ts';

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
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([once(socket, 'close'), new Promise<void>(resolve => { timer = setTimeout(resolve, 2_000); timer.unref(); })]);
  } finally {
    // 경주에서 진 쪽의 대기 타이머는 해제한다 — 이후 테스트의 활성 타이머 계산이 흔들리지 않게 한다.
    clearTimeout(timer);
  }
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
  // listening하지 않은 서버는 마감을 기다리지 않고 close도 호출하지 않는다 — 벽시계 대신 호출 여부를 본다.
  let closeCalls = 0;
  server.close = (() => { closeCalls++; return server; }) as Server['close'];
  await closeHttpServer(server, { deadlineMs: 50 });
  assert.equal(closeCalls, 0, 'a non-listening server must not reach server.close');
});

test('closeHttpServer rejects non-finite or out-of-range close bounds', async () => {
  const server = createServer();
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: -1 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { settleMs: -5 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: Number.NaN }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { settleMs: Number.POSITIVE_INFINITY }), RangeError);
  // Node는 타이머 상한(2^31-1)을 넘는 지연을 1ms로 강등한다 — 마감 순서 역전을 막기 위해 거절한다.
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: MAX_TIMEOUT_MS + 1 }), RangeError);
  await assert.rejects(() => closeHttpServer(server, { deadlineMs: MAX_TIMEOUT_MS, settleMs: 2 }), RangeError);
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
    // close 콜백이 settle 안에 오면 '강제 해제' 단독, settle를 넘기면 마감 진단이 뒤따른다 — 둘 다 허용한다.
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    assert.ok(messages.length >= 1 && messages.length <= 2, 'forced release reports a diagnostic, abandon at most one more');
    assert.match(messages[0], /test-server/, 'the diagnostic carries the server label');
    assert.match(messages[0], /강제 해제/, 'the diagnostic names the forced-release reason');
    assert.match(messages[0], /연결 [1-9]\d*개/, 'the diagnostic counts the sockets held at release');
    if (messages.length === 2) assert.match(messages[1], /콜백이 도착하지 않아/, 'a second diagnostic can only be the abandon reason');
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
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    // 마감에서 강제 해제가 먼저 실행됐으므로 해제 진단과 콜백 미도착 진단이 둘 다 남아야 한다.
    assert.equal(messages.length, 2, 'forced release and abandon each report a diagnostic');
    assert.match(messages[0], /abandon-test/, 'the forced diagnostic carries the server label');
    assert.match(messages[0], /강제 해제/, 'the forced release is not swallowed by the abandon outcome');
    assert.match(messages[0], /연결 0개/, 'the swept socket means the release captured zero connections');
    assert.match(messages[1], /abandon-test/, 'the abandon diagnostic carries the server label');
    assert.match(messages[1], /콜백이 도착하지 않아/, 'the diagnostic names the abandon reason');
    assert.match(messages[1], /미해제 연결 0개/, 'the released socket leaves exactly zero remaining connections');
    // 마감 뒤 도착한 close 오류는 settled promise가 버리지 않고 진단으로 남긴다.
    closeCallback?.(new Error('late boom'));
    assert.equal(httpDiagnostics(diagnostic).length, 3, 'a late close error is still reported');
    assert.match(String(httpDiagnostics(diagnostic)[2][0]), /abandon-test/, 'the late error carries the server label');
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
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    // 강제 해제 진단과 마감 진단 둘 다 조회 실패를 개수가 아니라 '알 수 없음'으로 내려야 한다.
    assert.equal(messages.length, 2);
    assert.match(messages[0], /강제 해제/, 'the forced release ran at the deadline');
    assert.match(messages[0], /알 수 없음/, 'a lookup failure must not masquerade as a count');
    assert.match(messages[1], /알 수 없음/, 'the abandon diagnostic also degrades to unknown');
  } finally {
    server.getConnections = originalGetConnections;
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer bounds the post-abandon connection lookup instead of waiting forever', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server } = await listeningServer((_req, res) => { res.end('ok'); });
  const originalClose = server.close.bind(server);
  const originalGetConnections = server.getConnections.bind(server);
  try {
    // close 콜백도 연결 수 콜백도 오지 않는 최악 — 마감 뒤 진단 조회가 영원히 기다리지 않고 '알 수 없음'으로 끝나야 한다.
    server.close = (() => server) as Server['close'];
    server.getConnections = (() => server) as unknown as Server['getConnections'];
    const started = Date.now();
    await closeHttpServer(server, { deadlineMs: 60, settleMs: 30, label: 'lookup-bound' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 150, 'the abandon at 90ms plus the bounded lookup at ~100ms still applies');
    assert.ok(elapsed < 2_000, 'a hung connection-count lookup cannot stall shutdown');
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    assert.equal(messages.length, 2, 'forced release and abandon each report a diagnostic');
    assert.match(messages[1], /콜백이 도착하지 않아/, 'the diagnostic names the abandon reason');
    assert.match(messages[1], /알 수 없음/, 'the timed-out lookup degrades to an unknown count');
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
    // close 콜백과 마감 타이머의 도착 순서에 따라 진단은 '강제 해제' 단독이거나 '강제 해제 + 콜백 미도착' 둘이다.
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    assert.ok(messages.length >= 1 && messages.length <= 2, 'each happened event reports at most one diagnostic');
    assert.match(messages[0], /강제 해제/, 'the forced release is always diagnosed');
    if (messages.length === 2) assert.match(messages[1], /콜백이 도착하지 않아/, 'a second diagnostic can only be the abandon reason');
  } finally {
    server.closeAllConnections = originalCloseAll;
    socket.destroy();
  }
});

test('closeHttpServer propagates a forced-release failure without lingering timers', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  const { server, port } = await listeningServer((_req, res) => { res.writeHead(200); res.flushHeaders(); });
  const socket = connect(port, '127.0.0.1');
  const originalClose = server.close.bind(server);
  const originalCloseAll = server.closeAllConnections.bind(server);
  const timeouts = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await once(socket, 'data');
    // 마감의 강제 해제 자체가 실패하는 경로 — 오류는 전파되고 두 타이머는 정리돼야 한다.
    server.closeAllConnections = (() => { throw new Error('release boom'); }) as Server['closeAllConnections'];
    const before = timeouts();
    await assert.rejects(() => closeHttpServer(server, { deadlineMs: 60, settleMs: 1_000, label: 'release-test' }), /release boom/);
    await sleep(20);
    assert.equal(timeouts(), before, 'a release failure must not leak the deadline timers');
    assert.equal(httpDiagnostics(diagnostic).length, 0, 'a failed release must not masquerade as a completed one');
  } finally {
    server.closeAllConnections = originalCloseAll;
    socket.destroy();
    await releaseServer(server, originalClose);
  }
});

test('closeHttpServer survives a failing idle sweep and reports it once', async (t) => {
  const diagnostic = t.mock.method(console, 'error');
  // 진행 중 요청이 80ms에 끝나게 해 close 대기 동안 주기 스윕이 한 번 이상 돌게 한다.
  let requestSeen!: () => void;
  const requestArrived = new Promise<void>(resolve => { requestSeen = resolve; });
  const { server, port } = await listeningServer((_req, res) => { requestSeen(); setTimeout(() => res.end('ok'), 80); });
  const socket = connect(port, '127.0.0.1');
  const originalCloseIdle = server.closeIdleConnections.bind(server);
  const originalClose = server.close.bind(server);
  let insideServerClose = false;
  let sweepAttempts = 0;
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await requestArrived;
    // Node는 server.close() 내부(httpServerPreClose)에서도 closeIdleConnections를 호출한다 — 내부 호출은
    // 통과시키고 우리 스윕(초기 호출 + 첫 주기 호출)만 실패시킨다. 두 번 실패해도 진단은 한 번이어야 한다.
    server.close = ((callback?: (error?: Error) => void) => {
      insideServerClose = true;
      try {
        return originalClose(callback);
      } finally {
        insideServerClose = false;
      }
    }) as Server['close'];
    server.closeIdleConnections = (() => {
      if (insideServerClose) return originalCloseIdle();
      sweepAttempts++;
      if (sweepAttempts <= 2) throw new Error('sweep boom');
      return originalCloseIdle();
    }) as Server['closeIdleConnections'];
    await closeHttpServer(server, { deadlineMs: 500, settleMs: 100, label: 'sweep-test' });
    assert.ok(sweepAttempts >= 2, 'the periodic sweep must have run during the close wait');
    const messages = httpDiagnostics(diagnostic).map(args => String(args[0]));
    assert.equal(messages.length, 1, 'repeated sweep failures are reported once, not every 50ms');
    assert.match(messages[0], /sweep-test/, 'the sweep diagnostic carries the server label');
    assert.match(messages[0], /스윕에 실패/, 'the diagnostic names the sweep failure');
  } finally {
    server.closeIdleConnections = originalCloseIdle;
    socket.destroy();
    await releaseServer(server, originalClose);
  }
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
