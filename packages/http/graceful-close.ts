import type { Server } from 'node:http';

/**
 * closeHttpServer의 동작을 조절하는 옵션 — 마감과 정착 상한은 환경별로 조정할 수 있다.
 */
export interface CloseHttpServerOptions {
  /** 진행 중 요청이 끝나기를 기다리는 상한(ms) — 초과하면 잔여 연결을 강제 해제한다. 기본 5_000. */
  deadlineMs?: number;
  /** close 콜백이 오지 않는 최악까지 기다리는 추가 상한(ms) — 기본 250. */
  settleMs?: number;
  /** 강제 해제 진단에 찍히는 서버 식별자 — 기본 'http'. */
  label?: string;
}

/** 서버 종료 대기의 결과 — 정상 종료는 수를 싣지 않고, 강제 해제는 시점의 연결 수를, 콜백 미도착은 사유만 구분해 돌려준다. */
type CloseWaitResult = { outcome: 'closed' } | { outcome: 'forced'; connections: number } | { outcome: 'abandoned' };

/** 마감·정착 상한은 0 이상의 유한 수여야 한다 — 음수 정착 상한은 마감이 강제 해제보다 먼저 발화하는 순서 역전을 만든다. */
export function assertCloseBound(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite number >= 0`);
}

/**
 * close가 deadlineMs + settleMs를 넘기지 않게 감시한다 — deadlineMs까지는 진행 중 요청이
 * 끝나길 기다리고, 그 뒤에는 잔여 연결을 강제 해제하며, 추적이 끊긴 소켓으로 close 콜백이
 * 오지 않는 최악에는 deadlineMs + settleMs에 'abandoned'로 돌아온다. 모든 타이머는 finish
 * 경로에서 정리하고, settle 후 도착한 close 오류는 버리지 않고 진단으로 남긴다.
 */
function waitForServerClose(server: Server, deadlineMs: number, settleMs: number, label: string): Promise<CloseWaitResult> {
  return new Promise<CloseWaitResult>((resolve, reject) => {
    let settled = false;
    let forced = false;
    let connections = -1;
    let forceTimer: NodeJS.Timeout;
    let abandonTimer: NodeJS.Timeout;
    // 모든 settle 경로가 거치는 단일 출구 — 중복 settle을 막고 두 타이머를 반드시 해제한다.
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      settle();
    };
    // 마감 도달 시 잔여 연결을 끊는다 — 시점의 연결 수를 포착해 두는 이유는 close 콜백 도착 뒤에는 항상 0이라 진단이 빈 값이 되기 때문이다.
    const release = () => {
      forced = true;
      server.getConnections((error, count) => { connections = error ? -1 : count; });
      server.closeAllConnections();
    };
    forceTimer = setTimeout(() => { try { release(); } catch (error) { finish(() => reject(error)); } }, deadlineMs);
    // forceTimer가 어떤 이유로든 못 돈 최악(타이머 순서 역전)에도 강제 해제는 시도한 뒤 마감한다.
    abandonTimer = setTimeout(() => {
      try {
        if (!forced) release();
        finish(() => resolve({ outcome: 'abandoned' }));
      } catch (error) {
        finish(() => reject(error));
      }
    }, deadlineMs + settleMs);
    try {
      server.close(error => {
        if (settled) {
          if (error) console.error(`[${label}] HTTP 종료 마감 후 close 오류가 도착했다: ${error.message}`);
          return;
        }
        finish(() => error ? reject(error) : resolve(forced ? { outcome: 'forced', connections } : { outcome: 'closed' }));
      });
      server.closeIdleConnections();
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** 잔여 연결 수를 단회 읽는다 — 조회 오류는 -1로 강등해 진단이 끊긴 수를 위장하지 않게 한다(진단용 best-effort다). */
async function remainingConnections(server: Server): Promise<number> {
  return new Promise<number>(resolve => server.getConnections((error, count) => resolve(error ? -1 : count)));
}

/** 진단에 싣는 연결 수 표현 — 조회 실패(-1)를 개수로 위장하지 않게 '알 수 없음'으로 표시한다. */
function describeConnections(count: number): string {
  return count < 0 ? '알 수 없음' : `${count}개`;
}

/**
 * 유휴 keep-alive 소켓은 즉시 거두고 진행 중 요청이 끝나길 기다린 뒤, 마감을
 * 넘긴 잔여 연결은 강제 해제한다 — 종료 중 완료되는 요청의 소켓도 주기 스윕이
 * 다시 거둬 마감 낭비와 강제 해제 오탐을 막는다. 강제 해제나 close 콜백
 * 미도착이 일어나면 stderr에 식별자·사유·연결 수를 남긴다. 전체 대기는
 * deadlineMs + settleMs를 넘기지 않는다.
 */
export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<void> {
  const { deadlineMs = 5_000, settleMs = 250, label = 'http' } = options;
  assertCloseBound(deadlineMs, 'deadlineMs');
  assertCloseBound(settleMs, 'settleMs');
  if (!server.listening) return;
  const sweep = setInterval(() => server.closeIdleConnections(), 50);
  sweep.unref();
  let result: CloseWaitResult;
  try {
    result = await waitForServerClose(server, deadlineMs, settleMs, label);
  } finally {
    clearInterval(sweep);
  }
  if (result.outcome === 'closed') return;
  if (result.outcome === 'forced') {
    console.error(`[${label}] HTTP 종료가 마감을 넘겨 잔여 연결을 강제 해제했다 — 해제 시점 연결 ${describeConnections(result.connections)}`);
    return;
  }
  const remaining = await remainingConnections(server);
  console.error(`[${label}] HTTP 종료 close 콜백이 도착하지 않아 마감했다 — 미해제 연결 ${describeConnections(remaining)}`);
}
