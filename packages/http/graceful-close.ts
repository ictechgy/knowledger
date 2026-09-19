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

/** 서버 종료 대기의 결과 — 정상 종료와 마감 강제 해제, close 콜백 미도착 마감을 구분해 진단에 싣는다. */
type CloseOutcome = 'closed' | 'forced' | 'abandoned';

/** 종료 대기가 돌려주는 결과 — 강제 해제 시점에 관측된 연결 수를 함께 실어 진단이 실제로 끊긴 수를 말하게 한다. */
interface CloseWaitResult {
  outcome: CloseOutcome;
  connections: number;
}

/** 마감·정착 상한은 0 이상의 유한 수여야 한다 — 음수 정착 상한은 마감이 강제 해제보다 먼저 발화하는 순서 역전을 만든다. */
function assertCloseBound(value: number, name: string): void {
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
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(forceTimer); clearTimeout(abandonTimer); settle(); };
    const release = () => {
      forced = true;
      server.getConnections((error, count) => { connections = error ? -1 : count; });
      server.closeAllConnections();
    };
    const forceTimer = setTimeout(() => { try { release(); } catch (error) { finish(() => reject(error)); } }, deadlineMs);
    const abandonTimer = setTimeout(() => { try { if (!forced) release(); finish(() => resolve({ outcome: 'abandoned', connections })); } catch (error) { finish(() => reject(error)); } }, deadlineMs + settleMs);
    try {
      server.close(error => {
        if (settled) { if (error) console.error(`[${label}] HTTP 종료 마감 후 close 오류가 도착했다: ${error.message}`); return; }
        finish(() => error ? reject(error) : resolve({ outcome: forced ? 'forced' : 'closed', connections }));
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
 * 기다릴 수는 없으므로 best-effort다). 조회 오류는 -1로 돌려 진단으로 승격시킨다.
 */
async function remainingConnections(server: Server, capMs: number): Promise<number> {
  const until = Date.now() + capMs;
  for (;;) {
    const count = await new Promise<number>(resolve => server.getConnections((error, n) => resolve(error ? -1 : n)));
    if (count <= 0 || Date.now() >= until) return count;
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, until - Date.now()))));
  }
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
    console.error(`[${label}] HTTP 종료가 마감을 넘겨 잔여 연결 ${Math.max(0, result.connections)}개를 강제 해제했다`);
    return;
  }
  // abandoned는 deadlineMs + settleMs 상한을 이미 소비했다 — 잔여 수는 진단용 단회 읽기만 한다.
  const remaining = await remainingConnections(server, 0);
  console.error(`[${label}] HTTP 종료 close 콜백이 도착하지 않아 마감했다 — 미해제 연결 ${remaining < 0 ? '알 수 없음' : `${remaining}개`}`);
}
