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

/** 서버 종료 대기의 결과 — 정상 종료와 마감 강제 해제, close 콜백 미도착 마감을 구분해 진단에 싣는다. */
type CloseOutcome = 'closed' | 'forced' | 'abandoned';

/** 마감·정착 상한은 0 이상의 유한 수여야 한다 — 음수 정착 상한은 마감이 강제 해제보다 먼저 발화하는 순서 역전을 만든다. */
function assertCloseBound(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number >= 0`);
}

/**
 * close가 settleUntil을 넘기지 않게 감시한다 — deadlineMs까지는 진행 중 요청이 끝나길 기다리고,
 * 그 뒤에는 잔여 연결을 강제 해제하며, 추적이 끊긴 소켓으로 close 콜백이 오지 않는 최악에는
 * settleUntil에 'abandoned'로 돌아온다. 모든 타이머는 settle 경로에서 정리하고, 이미 settle된
 * 뒤 도착한 close 오류는 버리지 않고 진단으로 남긴다.
 */
function waitForServerClose(server: Server, deadlineMs: number, settleUntil: number, label: string): Promise<CloseOutcome> {
  return new Promise<CloseOutcome>((resolve, reject) => {
    let settled = false;
    let forced = false;
    const forceTimer = setTimeout(() => { forced = true; server.closeAllConnections(); }, deadlineMs);
    const abandonTimer = setTimeout(() => finish(() => resolve('abandoned')), Math.max(0, settleUntil - Date.now()));
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(forceTimer); clearTimeout(abandonTimer); settle(); };
    try {
      server.close(error => {
        if (settled) { if (error) console.error(`[${label}] HTTP 종료 마감 후 close 오류가 도착했다: ${error.message}`); return; }
        finish(() => error ? reject(error) : resolve(forced ? 'forced' : 'closed'));
      });
      server.closeIdleConnections();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/**
 * 강제 해제 뒤 잔여 연결 수를 관측한다 — 소켓 절단이 관측되는 즉시 돌아오되
 * 예산이 다하면 남은 수를 돌려 진단에 싣는다(관측 불가한 핸들러 내부 대기까지
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
 * 식별자·사유·잔여 연결 수를 남기고, 잔여 연결이 끊기는지 예산 내에서 관측해
 * 끊긴 소켓 위에서 돌던 핸들러가 뒤따르는 자원 해제와 경주하는 시간을 줄인다.
 * 전체 대기는 deadlineMs + settleMs를 넘기지 않는다.
 */
export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<void> {
  const { deadlineMs = 5_000, settleMs = 250, label = 'http' } = options;
  assertCloseBound(deadlineMs, 'deadlineMs');
  assertCloseBound(settleMs, 'settleMs');
  if (!server.listening) return;
  const settleUntil = Date.now() + deadlineMs + settleMs;
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  sweep.unref();
  let outcome: CloseOutcome;
  try {
    outcome = await waitForServerClose(server, deadlineMs, settleUntil, label);
  } finally {
    clearInterval(sweep);
  }
  if (outcome === 'closed') return;
  const remaining = await remainingConnections(server, Math.max(0, settleUntil - Date.now()));
  const reason = outcome === 'abandoned' ? 'close 콜백이 도착하지 않아 마감했다' : '마감을 넘겨 잔여 연결을 강제 해제했다';
  console.error(`[${label}] HTTP 종료 ${reason} — 미해제 연결 ${remaining}개`);
}
