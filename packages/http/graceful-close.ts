import type { Server } from 'node:http';

/**
 * closeHttpServer의 동작을 조절하는 옵션 — 마감과 정착 상한은 환경별로 조정할 수 있다.
 */
export interface CloseHttpServerOptions {
  /** 진행 중 요청이 끝나기를 기다리는 상한(ms) — 초과하면 잔여 연결을 강제 해제한다. 기본 5_000. */
  deadlineMs?: number;
  /** 강제 해제 후 잔여 연결이 실제로 끊기는지 관측하는 상한(ms) — 기본 250. */
  settleMs?: number;
  /** 강제 해제 진단에 찍히는 서버 식별자 — 기본 'http'. */
  label?: string;
}

/**
 * 강제 해제 뒤 잔여 연결 수를 관측한다 — 소켓 절단이 관측되는 즉시 돌아오되
 * 상한을 넘기면 남은 수를 돌려 진단에 싣는다(관측 불가한 핸들러 내부 대기까지
 * 기다릴 수는 없으므로 best-effort다).
 */
async function remainingConnections(server: Server, capMs: number): Promise<number> {
  const until = Date.now() + capMs;
  for (;;) {
    const count = await new Promise<number>((resolve, reject) => server.getConnections((error, n) => error ? reject(error) : resolve(n)));
    if (count === 0 || Date.now() >= until) return count;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/**
 * 유휴 keep-alive 소켓은 즉시 거두고 진행 중 요청이 끝나길 기다린 뒤, 마감을
 * 넘긴 잔여 연결은 강제 해제한다 — 종료 중 완료되는 요청의 소켓도 주기 스윕이
 * 다시 거둬 마감 낭비와 강제 해제 오탐을 막는다. 강제 해제가 일어나면 stderr에
 * 진단을 남기고, 잔여 연결이 끊기는지 짧게 관측해 끊긴 소켓 위에서 돌던
 * 핸들러가 뒤따르는 자원 해제와 경주하는 시간을 줄인다. upgrade 등으로 추적이
 * 끊긴 소켓 때문에 close 콜백이 오지 않는 최악에도 deadlineMs + settleMs를
 * 넘겨 대기하지 않는다.
 */
export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<void> {
  const { deadlineMs = 5_000, settleMs = 250, label = 'http' } = options;
  if (!server.listening) return;
  let forced = false;
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  sweep.unref();
  try {
    await new Promise<void>((resolve, reject) => {
      const forceTimer = setTimeout(() => { forced = true; server.closeAllConnections(); }, deadlineMs);
      const abandonTimer = setTimeout(() => { forced = true; resolve(); }, deadlineMs + settleMs);
      server.close(error => { clearTimeout(forceTimer); clearTimeout(abandonTimer); error ? reject(error) : resolve(); });
      server.closeIdleConnections();
    });
  } finally {
    clearInterval(sweep);
  }
  if (!forced) return;
  const remaining = await remainingConnections(server, settleMs);
  console.error(`[${label}] HTTP 종료가 마감을 넘겨 잔여 연결을 강제 해제했다 — 미해제 연결 ${remaining}개`);
}
