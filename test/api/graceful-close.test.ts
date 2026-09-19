import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { closeHttpServer } from '../../packages/http/graceful-close.ts';

/** 짧은 수신 대기 — 응답 본문을 다 읽지 않아도 헤더 도착이면 충분하다. */
async function waitForData(socket: Socket): Promise<void> {
  await once(socket, 'data');
}

async function listeningServer(handler: (req: any, res: any) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port };
}

test('closeHttpServer returns immediately for a non-listening server', async () => {
  const server = createServer();
  const started = Date.now();
  await closeHttpServer(server, 50);
  assert.ok(Date.now() - started < 50, 'non-listening close must not wait for the deadline');
});

test('closeHttpServer reaps an idle keep-alive socket without waiting for the deadline', async () => {
  const { server, port } = await listeningServer((_req, res) => { res.end('ok'); });
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await waitForData(socket);
    const started = Date.now();
    await closeHttpServer(server, 10_000);
    assert.ok(Date.now() - started < 5_000, 'idle keep-alive sockets must not stall close');
  } finally {
    socket.destroy();
  }
});

test('closeHttpServer force-releases a request that never finishes after the deadline', async () => {
  const { server, port } = await listeningServer((_req, res) => { res.writeHead(200); res.flushHeaders(); /* never ends — models a stuck handler */ });
  const socket = connect(port, '127.0.0.1');
  try {
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    await waitForData(socket);
    const started = Date.now();
    await closeHttpServer(server, 150, 10);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 150, 'the deadline still lets in-flight requests finish');
    assert.ok(elapsed < 5_000, 'stuck requests are force-released after the deadline');
    assert.equal(socket.destroyed, true, 'forced close destroys the held socket');
  } finally {
    socket.destroy();
  }
});
