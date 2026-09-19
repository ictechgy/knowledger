import type { Server } from 'node:http';

/**
 * closeHttpServer의 동작을 조절하는 옵션 — 마감과 정착 상한은 환경별로 조정할 수 있다.
 */
export interface CloseHttpServerOptions {
  /** 진행 중 요청이 끝나기를 기다리는 상한(ms) — 초과하면 잔여 연결을 강제 해제한다. 기본 DEFAULT_CLOSE_DEADLINE_MS. */
  deadlineMs?: number;
  /** close 콜백이 오지 않는 최악까지 기다리는 추가 상한(ms) — 기본 DEFAULT_SETTLE_MS. */
  settleMs?: number;
  /** 강제 해제 진단에 찍히는 서버 식별자 — 기본 'http'. */
  label?: string;
}

/** 서버 종료 대기의 결과 — 강제 해제 시점에 포착한 연결 수와, 콜백 미도착 뒤 읽은 잔여 연결 수, 그리고 마감 창 안에 도착한 늦은 콜백 여부를 함께 돌려준다. */
type CloseWaitResult = { outcome: 'closed' } | { outcome: 'forced'; connections: number } | { outcome: 'abandoned'; connections: number; remaining: number; lateClose: boolean };

/** 종료 마감의 기본값(ms) — 앱 옵션 문서가 이 상수를 참조해 기본값 설명이 갈라지지 않게 한다. */
export const DEFAULT_CLOSE_DEADLINE_MS = 5_000;

/** close 콜백 미도착 최악에 추가로 기다리는 기본값(ms) — 옵션 문서가 같은 이름을 참조한다. */
export const DEFAULT_SETTLE_MS = 250;

/** 종료 대기 중 유휴 keep-alive 소켓을 다시 거두는 주기(ms) — 마감 사이에 유휴해진 소켓을 놓치지 않는다. */
export const SWEEP_INTERVAL_MS = 50;

/** Node setTimeout의 최대 지연 — 이를 넘는 값은 1ms로 강등돼 마감·강제 해제의 발화 순서가 깨진다. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** 연결 수 조회 실패를 나타내는 센티널 — 진단이 실제 개수로 위장하지 않게 구분한다. */
export const UNKNOWN_CONNECTION_COUNT = -1;

/** 개수 포착·잔여 조회가 공유하는 진단 대기의 총 상한(ms) — 조회가 늦어져도 총 대기 상한을 넘기지 않게 한다. */
export const REMAINING_LOOKUP_MS = 100;

/** 마감·정착 상한은 0 이상 MAX_TIMEOUT_MS 이하의 유한 수여야 한다 — 범위 밖은 1ms 강등·순서 역전을 만든다. */
export function assertCloseBound(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > MAX_TIMEOUT_MS) throw new RangeError(`${name} must be a finite number between 0 and ${MAX_TIMEOUT_MS}`);
}

/**
 * 선택적 종료 상한을 기동 시점에 검증한다 — 미설정은 기본값 사용으로 통과시키고, 잘못된 값은
 * close() 전에 실패하게 한다. closeHttpServer가 마감과 기본 정착 상한의 합까지 검증하므로
 * 기동 검증도 같은 합을 봐야 한다 — 합산을 빠뜨리면 close() 시점에 뒤늦게 거절된다.
 */
export function assertOptionalCloseBound(value: number | undefined, name: string, settleMs: number = DEFAULT_SETTLE_MS): void {
  // 명시적으로 넘긴 정착 상한도 검증한다 — value가 undefined라고 잘못된 settleMs를 통과시키지 않는다.
  assertCloseBound(settleMs, 'settleMs');
  if (value === undefined) return;
  assertCloseBound(value, name);
  assertCloseBound(value + settleMs, `${name} + settleMs`);
}

/**
 * close가 deadlineMs + settleMs를 넘기지 않게 감시한다 — deadlineMs까지는 진행 중 요청이
 * 끝나길 기다리고, 그 뒤에는 잔여 연결을 강제 해제하며, 추적이 끊긴 소켓으로 close 콜백이
 * 오지 않는 최악에는 deadlineMs + settleMs에 'abandoned'로 돌아온다. 마감·정착 타이머는
 * finish 경로에서 정리하고(개수 포착의 짧은 상한 타이머는 스스로 해제된다), settle 후
 * 도착한 close 오류는 버리지 않고 진단으로 남긴다. 포착·조회 진단 대기는 두 경로를 합쳐
 * 최대 REMAINING_LOOKUP_MS만 더한다.
 */
function waitForServerClose(server: Server, deadlineMs: number, settleMs: number, label: string, onSweepFailure: (error: unknown) => void): Promise<CloseWaitResult> {
  return new Promise<CloseWaitResult>((resolve, reject) => {
    let isSettled = false;
    let isForced = false;
    let hasAbandoned = false;
    let hasLateClose = false;
    let connections = UNKNOWN_CONNECTION_COUNT;
    let pendingCount: Promise<void> | undefined;
    let closeError: Error | null = null;
    let forceTimer: NodeJS.Timeout;
    let abandonTimer: NodeJS.Timeout;
    // 모든 settle 경로가 거치는 단일 출구 — 중복 settle을 막고 두 타이머를 반드시 해제한다.
    // settle 안의 진단 출력이 던져도 귀결을 막지 못하게 한다 — 그대로 올라가면 isSettled만 선 채
    // 대기 promise가 영구 pending + 미처리 거절이 된다.
    const finish = (settle: () => void) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      try {
        settle();
      } catch (error) {
        reject(error);
      }
    };
    // 개수 포착 promise를 주어진 상한으로 기다린다 — 늦거나 오지 않으면 그냥 넘겨 대기가 마감을 넘기지 않게 한다.
    // 현재 소스(포착·타이머)는 거절하지 않지만 promise 계약상 거절될 수 있다 — 소비 측의 거절 귀결이
    // 미처리 거절을 막는 방어선이다.
    // 상한 타이머는 의도적으로 ref다 — abandon 상황(서버 핸들 소실)에서 진단 창 도중 프로세스가
    // 종료되면 진단 출력과 호출자 측 finally 자원 해제가 건너뛰어진다. 경주 종료 시 .finally가 해제한다.
    const boundedWait = (pending: Promise<void>, timeoutMs: number): Promise<void> => {
      let boundTimer: NodeJS.Timeout | undefined;
      return Promise.race([pending, new Promise<void>(resolve => { boundTimer = setTimeout(resolve, timeoutMs); })])
        .finally(() => clearTimeout(boundTimer));
    };
    // 마감 도달 시 잔여 연결을 끊는다 — 시점의 연결 수를 포착해 두는 이유는 close 콜백 도착 뒤에는 항상 0이라 진단이 빈 값이 되기 때문이다.
    // getConnections 콜백은 nextTick 이후 도착해 비클러스터 경로에서는 소켓 파괴 전 값을 읽는다 — 클러스터 primary의 IPC 왕복에서는 늦어질 수 있다.
    // 돌려주는 promise는 개수 포착이 끝나는 시점을 알린다 — close 콜백과 포착의 도착 순서는 보장이 없어 진단 전에 유한하게 기다린다.
    const release = () => {
      isForced = true;
      pendingCount = connectionCount(server).then(count => { connections = count; });
      server.closeAllConnections();
      return pendingCount;
    };
    forceTimer = setTimeout(() => { try { release(); } catch (error) { finish(() => reject(error)); } }, deadlineMs);
    // forceTimer가 어떤 이유로든 못 돈 최악(타이머 순서 역전)에도 강제 해제는 시도한 뒤 마감한다 — 폴백 해제는 개수 포착을 기다려 UNKNOWN 남발을 피한다.
    abandonTimer = setTimeout(() => {
      // 마감 발화를 먼저 기록한다 — 이후 도착하는 close 콜백은 settle 경주 없이 '늦은 도착'으로 확정된다.
      hasAbandoned = true;
      try {
        // 해제가 마감에 일어났든 지금 폴백으로 일어나든 포착이 진행 중이다 — 포착 대기와 잔여 조회가 하나의
        // 진단 예산(REMAINING_LOOKUP_MS)을 나눠 두 대기가 직렬로 쌓여 총 상한을 넘기는 일이 없게 한다.
        // 단조 시계를 쓴다 — 벽시계가 뒤로 가도 예산 상한이 깨지지 않는다.
        const counting = pendingCount ?? release();
        const budgetEnd = performance.now() + REMAINING_LOOKUP_MS;
        void boundedWait(counting, Math.max(0, budgetEnd - performance.now()))
          // 다른 경로가 먼저 settle했거나 close 오류가 이미 도착했으면 잔여 조회를 건너뛴다 —
          // 닫힌 서버에 조회를 다시 걸지 않고, 오류 전파가 조회 예산만큼 늦어지지도 않게 한다.
          .then(() => (isSettled || closeError) ? UNKNOWN_CONNECTION_COUNT : connectionCountBounded(server, Math.max(0, budgetEnd - performance.now())))
          .then(
            remaining => finish(() => {
              // 마감 창 안에 도착한 close 오류는 '마감' 결과보다 우선한다 — 실제 close 실패를 성공으로 보고하지 않는다.
              if (closeError) {
                reportForcedRelease(label, connections);
                reject(closeError);
                return;
              }
              resolve({ outcome: 'abandoned', connections, remaining, lateClose: hasLateClose });
            }),
            lookupError => finish(() => reject(lookupError)),
          );
      } catch (error) {
        finish(() => reject(error));
      }
    }, deadlineMs + settleMs);
    try {
      server.close(error => {
        // 콜백 도착 자체는 settle 순서와 무관하게 기록한다 — abandon settle이 창 안 도착한 close 오류를 우선 거절한다.
        closeError = error ?? null;
        // 마감이 이미 발화했다면 settle 경주를 걸지 않는다 — 늦은 도착으로 확정해 순서를 결정론적으로 만든다.
        if (isSettled || hasAbandoned) {
          if (isSettled) {
            reportLateClose(label, error);
            return;
          }
          // 마감 창 안의 도착 — 오류는 abandon 귀결이 '강제 해제 → 거절'로 보고하고, 정상 도착은
          // 결과에 실어 강제 해제·마감 진단 뒤에 찍는다. 도착 즉시 찍으면 아직 출력되지 않은
          // 진단들보다 앞에 서서 인과 순서가 뒤집힌다.
          if (!error) hasLateClose = true;
          return;
        }
        // 강제 해제 후 close 오류로 reject돼도 해제 사실은 진단으로 남긴다 — 포착한 연결 수가 버려지지 않게 한다.
        const settleClose = () => {
          try {
            // 포착 대기 사이 abandon이 먼저 마감했을 수 있다 — 콜백은 마감 전에 도착했으므로 늦은 도착이
            // 아니고, 오류는 closeError로 이미 귀결에 반영됐다. 다시 진단하면 이중 보고가 된다.
            if (isSettled) return;
            if (error && isForced) reportForcedRelease(label, connections);
            finish(() => error ? reject(error) : resolve(isForced ? { outcome: 'forced', connections } : { outcome: 'closed' }));
          } catch (settleError) {
            finish(() => reject(settleError));
          }
        };
        // close 콜백이 개수 포착보다 먼저 도착할 수 있다 — 진단이 항상 '알 수 없음'이 되지 않게 유한하게 기다린다.
        if (isForced && pendingCount) {
          void boundedWait(pendingCount, REMAINING_LOOKUP_MS).then(settleClose, waitError => finish(() => reject(waitError)));
        } else {
          settleClose();
        }
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

/** 서버의 현재 연결 수를 한 번 읽는다 — 조회 오류·동기 throw는 센티널로 강등해 진단이 위장하거나 거절로 번지지 않게 한다(진단용 best-effort다). */
function connectionCount(server: Server): Promise<number> {
  return new Promise<number>(resolve => {
    try {
      server.getConnections((error, count) => resolve(error ? UNKNOWN_CONNECTION_COUNT : count));
    } catch {
      resolve(UNKNOWN_CONNECTION_COUNT);
    }
  });
}

/** 연결 수를 주어진 상한 안에 읽는다 — 클러스터 IPC 같은 느린 조회는 '알 수 없음'으로 강등해 진단 예산을 지킨다. */
function connectionCountBounded(server: Server, timeoutMs: number): Promise<number> {
  let lookupTimer: NodeJS.Timeout | undefined;
  return Promise.race([
    connectionCount(server),
    new Promise<number>(resolve => { lookupTimer = setTimeout(() => resolve(UNKNOWN_CONNECTION_COUNT), timeoutMs); }),
  ]).finally(() => clearTimeout(lookupTimer));
}

/** 진단에 싣는 연결 수 표현 — 조회 실패 센티널을 개수로 위장하지 않게 '알 수 없음'으로 표시한다. */
function describeConnections(count: number): string {
  return count < 0 ? '알 수 없음' : `${count}개`;
}

/** 강제 해제 사실을 stderr에 남긴다 — close 오류로 reject되는 경로에서도 같은 진단이 남게 두 지점이 공유한다. */
function reportForcedRelease(label: string, connections: number): void {
  emitDiagnostic(label, `마감을 넘겨 잔여 연결을 강제 해제했다 — 해제 시점 연결 ${describeConnections(connections)}`);
}

/** settle 이후에 도착한 close 콜백 — 오류든 정상이든 버리지 않고 진단으로 남긴다. */
function reportLateClose(label: string, lateError: Error | null | undefined): void {
  if (lateError) emitDiagnostic(label, `마감 후 close 오류가 도착했다: ${lateError.message}`);
  else emitDiagnostic(label, '마감 후 close 콜백이 늦게 도착했다');
}

/** 종료 진단 한 줄을 stderr에 남긴다 — 식별자·주어 접두어와 구분자는 여기서만 붙여 호출자가 문장 조각의 앞 글자를 맞출 필요가 없게 한다. */
function emitDiagnostic(label: string, message: string): void {
  // 진단 출력은 best-effort다 — stderr 실패가 종료 귀결이나 실제 오류 보고를 대체하지 못하게 삼킨다.
  try {
    console.error(`[${label}] HTTP 종료: ${message}`);
  } catch {
    // stderr가 닫혀도 종료 진행은 계속된다 — 진단 실패를 오류로 번지게 하지 않는다.
  }
}

/**
 * 유휴 keep-alive 소켓은 즉시 거두고 진행 중 요청이 끝나길 기다린 뒤, 마감을
 * 넘긴 잔여 연결은 강제 해제한다 — 종료 중 완료되는 요청의 소켓도 주기 스윕이
 * 다시 거둬 마감 낭비와 강제 해제 오탐을 막는다. 강제 해제나 close 콜백
 * 미도착이 일어나면 stderr에 식별자·사유·연결 수를 남긴다. close 대기는
 * deadlineMs + settleMs 안에 끝나고, 포착·조회 진단 대기를 합해도 추가
 * REMAINING_LOOKUP_MS를 넘지 않는다.
 */
export async function closeHttpServer(server: Server, options: CloseHttpServerOptions = {}): Promise<void> {
  const { deadlineMs = DEFAULT_CLOSE_DEADLINE_MS, settleMs = DEFAULT_SETTLE_MS, label = 'http' } = options;
  assertCloseBound(deadlineMs, 'deadlineMs');
  assertCloseBound(settleMs, 'settleMs');
  // 두 타이머의 합도 타이머 상한 안이어야 한다 — 합이 넘치면 마감이 강제 해제보다 먼저 발화하는 순서 역전이 된다.
  assertCloseBound(deadlineMs + settleMs, 'deadlineMs + settleMs');
  if (!server.listening) return;
  // 스윕 실패는 종료 자체를 막지 않는다 — 50ms 간격의 반복 실패가 stderr를 도배하지 않게 첫 실패만 진단으로 남긴다.
  let hasSweepWarned = false;
  const reportSweepFailure = (error: unknown) => {
    if (hasSweepWarned) return;
    hasSweepWarned = true;
    emitDiagnostic(label, `유휴 연결 스윕에 실패했다: ${error instanceof Error ? error.message : String(error)}`);
  };
  const sweep = setInterval(() => {
    try {
      server.closeIdleConnections();
    } catch (error) {
      reportSweepFailure(error);
    }
  }, SWEEP_INTERVAL_MS);
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
  // 콜백 미도착 경로는 마감이든 폴백이든 강제 해제가 반드시 실행됐다 — 해제 사실과 포착 수를 버리지 않는다.
  reportForcedRelease(label, result.connections);
  emitDiagnostic(label, `close 콜백이 마감까지 도착하지 않아 마감했다 — 미해제 연결 ${describeConnections(result.remaining)}`);
  // 마감 창 안에 도착한 정상 콜백은 결과에 실어 왔다 — 강제 해제·마감 진단 뒤에 찍어 인과 순서를 유지한다.
  if (result.lateClose) reportLateClose(label, null);
}
