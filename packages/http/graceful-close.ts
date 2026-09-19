import type { Server } from 'node:http';

/**
 * HTTP 서버를 순서대로 닫는다 — 새 연결을 막고 유휴 keep-alive 소켓을 즉시 거두며,
 * 진행 중 요청에는 마감을 둔다. 마감을 넘으면 잔여 연결을 강제 해제하고, 끊긴 요청의
 * 핸들러가 정리될 짧은 시간을 더 기다린 뒤 돌아온다.
 * 강제 해제는 진단 출력으로 남겨 조용한 절단이 되지 않게 한다.
 */
export async function closeHttpServer(server: Server, deadlineMs = 5_000, settleMs = 250): Promise<void> {
  if (!server.listening) return;
  let forced = false;
  await new Promise<void>((resolve, reject) => {
    const forceTimer = setTimeout(() => { forced = true; server.closeAllConnections(); }, deadlineMs);
    server.close(error => { clearTimeout(forceTimer); error ? reject(error) : resolve(); });
    server.closeIdleConnections();
  });
  if (!forced) return;
  console.error('HTTP 서버 종료가 마감을 넘겨 잔여 연결을 강제 해제했다');
  await new Promise(resolve => setTimeout(resolve, settleMs));
}
