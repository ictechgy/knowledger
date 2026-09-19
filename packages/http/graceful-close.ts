import type { Server } from 'node:http';

/**
 * closeHttpServer의 동작을 조절하는 옵션 — 마감과 정착 상한은 환경별로 조정할 수 있다.
 */
export interface CloseHttpServerOptions {
  /** 진행 중 요청이 끝나기를 기다리는 상한(ms) — 초과하면 잔여 연결을 강제 해제한다. 기본 DEFAULT_CLOSE_DEADLINE_MS. */
  deadlineMs?: number;
  /** close 콜백이 오지 않는 최악까지 기다리는 추가 상한(ms) — 기본 250. */
  settleMs?: number;
  /** 강제 해제 진단에 찍히는 서버 식별자 — 기본 'http'. */
  label?: string;
}

/** 서버 종료 대기의 결과 — 강제 해제와 콜백 미도착은 해제 실행 여부와 그 시점에 포착한 연결 수를 함께 돌려준다. */
type CloseWaitResult = { outcome: 'closed' } | { outcome: 'forced'; connections: number } | { outcome: 'abandoned'; forced: boolean; connections: number };

/** 종료 마감의 기본값(ms) — 앱 옵션 문서가 이 상수를 참조해 기본값 설명이 갈라지지 않게 한다. */
export const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

/** Node setTimeout의 최대 지연 — 이를 넘는 값은 1ms로 강등돼 마감·강제 해제의 발화 순서가 깨진다. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** 연결 수 조회 실패를 나타내는 센티널 — 진단이 실제 개수로 위장하지 않게 구분한다. */
const UNKNOWN_CONNECTION_COUNT = -1;

/** 마감·정착 상한은 0 이상 MAX_TIMEOUT_MS 이하의 유한 수여야 한다 — 범위 밖은 1ms 강등·순서 역전을 만든다. */
export function assertCloseBound(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) throw new RangeError(`${name} must be a finite number between 0 and ${MAX_TIMEOUT_MS}`);
}

/** 선택적 종료 상한을 기동 시점에 검증한다 — 미설정은 기본값 사용으로 통과시키고, 잘못된 값은 close() 전에 실패하게 한다. */
export function assertOptionalCloseBound(value: number | undefined, name: string): void {
  if (value !== undefined) assertCloseBound(value, name);
}

/**
 * close가 deadlineMs + settleMs를 넘기지 않게 감시한다 — deadlineMs까지는 진행 중 요청이
 * 끝나길 기다리고, 그 뒤에는 잔여 연결을 강제 해제하며, 추적이 끊긴 소켓으로 close 콜백이
 * 오지 않는 최악에는 deadlineMs + settleMs에 'abandoned'로 돌아온다. 모든 타이머는 finish
 * 경로에서 정리하고, settle 후 도착한 close 오류는 버리지 않고 진단으로 남긴다.
 */
function waitForServerClose(server: Server, deadlineMs: number, settleMs: number, label: string, onSweepFailure: (error: unknown) => void): Promise<CloseWaitResult> {
  return new Promise<CloseWaitResult>((resolve, reject) => {
    let settled = false;
    let forced = false;
    let connections = UNKNOWN_CONNECTION_COUNT;
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
    // getConnections 콜백은 nextTick 이후 도착해 비클러스터 경로에서는 소켓 파괴 전 값을 읽는다 — 클러스터 primary의 IPC 왕복에서는 늦어질 수 있다.
    const release = () => {
      forced = true;
      server.getConnections((error, count) => { connections = error ? UNKNOWN_CONNECTION_COUNT : count; });
      server.closeAllConnections();
    };
    forceTimer = setTimeout(() => { try { release(); } catch (error) { finish(() => reject(error)); } }, deadlineMs);
    // forceTimer가 어떤 이유로든 못 돈 최악(타이머 순서 역전)에도 강제 해제는 시도한 뒤 마감한다.
    abandonTimer = setTimeout(() => {
      try {
        if (!forced) release();
        finish(() => resolve({ outcome: 'abandoned', forced, connections }));
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
        // 강제 해제 후 close 오류로 reject돼도 해제 사실은 진단으로 남긴다 — 포착한 연결 수가 버려지지 않게 한다.
        if (error && forced) reportForcedRelease(label, connections);
        finish(() => error ? reject(error) : resolve(forced ? { outcome: 'forced', connections } : { outcome: 'closed' }));
      });
      try {
        server.closeIdleConnections();
      } catch (error) {
        onSweepFailure(error);
      }
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

/** 잔여 연결 수를 단회 읽는다 — 조회 오류는 센티널로 강등해 진단이 끊긴 수를 위장하지 않게 한다(진단용 best-effort다). */
async function remainingConnections(server: Server): Promise<number> {
  return new Promise<number>(resolve => server.getConnections((error, count) => resolve(error ? UNKNOWN_CONNECTION_COUNT : count)));
}

/** 진단에 싣는 연결 수 표현 — 조회 실패 센티널을 개수로 위장하지 않게 '알 수 없음'으로 표시한다. */
function describeConnections(count: number): string {
  return count < 0 ? '알 수 없음' : `${count}개`;
}

/** 강제 해제 사실을 stderr에 남긴다 — close 오류로 reject되는 경로에서도 같은 진단이 남게 두 지점이 공유한다. */
function reportForcedRelease(label: string, connections: number): void {
  console.error(`[${label}] HTTP 종료가 마감을 넘겨 잔여 연결을 강제 해제했다 — 해제 시점 연결 ${describeConnections(connections)}`);
}

/**
 * 유휴 keep-alive 소켓은 즉시 거두고 진행 중 요청이 끝나길 기다린 뒤, 마감을
 * 넘긴 잔여 연결은 강제 해제한다 — 종료 중 완료되는 요청의 소켓도 주기 스윕이
 * 다시 거둬 마감 낭비와 강제 해제 오탐을 막는다. 강제 해제나 close 콜백
 * 미도착이 일어나면 stderr에 식별자·사유·연결 수를 남긴다. 전체 대기는
 * deadlineMs + settleMs를 넘기지 않는다.
 */
export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<void> {
  const { deadlineMs = DEFAULT_CLOSE_DEADLINE_MS, settleMs = 250, label = 'http' } = options;
  assertCloseBound(deadlineMs, 'deadlineMs');
  assertCloseBound(settleMs, 'settleMs');
  // 두 타이머의 합도 타이머 상한 안이어야 한다 — 합이 넘치면 마감이 강제 해제보다 먼저 발화하는 순서 역전이 된다.
  assertCloseBound(deadlineMs + settleMs, 'deadlineMs + settleMs');
  if (!server.listening) return;
  // 스윕 실패는 종료 자체를 막지 않는다 — 50ms 간격의 반복 실패가 stderr를 도배하지 않게 첫 실패만 진단으로 남긴다.
  let sweepWarned = false;
  const reportSweepFailure = (error: unknown) => {
    if (sweepWarned) return;
    sweepWarned = true;
    console.error(`[${label}] HTTP 종료 중 유휴 연결 스윕에 실패했다: ${error instanceof Error ? error.message : String(error)}`);
  };
  const sweep = setInterval(() => {
    try {
      server.closeIdleConnections();
    } catch (error) {
      reportSweepFailure(error);
    }
  }, 50);
  sweep.unref();
  let result: CloseWaitResult;
  try {
    result = await waitForServerClose(server, deadlineMs, settleMs, label, reportSweepFailure);
  } finally {
    clearInterval(sweep);
  }
  if (result.outcome === 'closed') return;
  if (result.outcome === 'forced') {
    reportForcedRelease(label, result.connections);
    return;
  }
  // 마감이 먼저 발화해 강제 해제가 실행됐다면 그 사실과 포착한 연결 수를 버리지 않는다 — 콜백 미도착 진단만 남기면 해제가 무소음이 된다.
  if (result.forced) reportForcedRelease(label, result.connections);
  const remaining = await remainingConnections(server);
  console.error(`[${label}] HTTP 종료 close 콜백이 도착하지 않아 마감했다 — 미해제 연결 ${describeConnections(remaining)}`);
}
