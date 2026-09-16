# Claude 공동 리뷰: 성능·보안·구조·사용성

2026-09-16, 구현 기준 **`419a26d`**. Claude Sonnet 5의 독립적인 두 검토(서버/원장,
제품/화면)를 받은 뒤 Codex가 소스와 격리된 실행으로 지적을 검증했다.
본문의 발견 항목은 수정 전 리뷰다. 이후 적용한 수정과 검증은 끝의 **후속 수정**에 기록한다.

## 결론

기능 구현과 기존 검증을 마쳤더라도 수정할 코드가 남아 있다. 가장 먼저 고칠 것은
**문서 개정 이력에 따라 제곱으로 커지는 조회 응답**이다. 공개 운영 전에는 인증 없는
health 요청의 원장 조회 비용을 제한해야 한다. 가져오기 화면에는 잘못된 manifest 선택 뒤
이전 선택으로 동작하는 버그와 저장소 목록의 다음 페이지 누락이 있다.

| 관점 | 판정 |
| --- | --- |
| 성능 | 짧은 본문 200개 개정만으로 overview JSON이 약 16.8 MB. 기존 단일 개정 벤치마크로는 드러나지 않은 병목 |
| 보안 | 검토 범위에서 승인 위조·인가 우회를 확정하지 못함. `/healthz`에는 인증 전 비용 큰 작업을 유발하는 가용성 문제 |
| 구조 | 공통 도메인 엔진과 VALID 블록 기반 판정은 유지할 가치가 있음. 조회 계산, 쓰기 대기, 전체 이력 메모리 보관은 확장 전에 개선 필요 |
| 사용성 | 잘못된 manifest 선택 뒤 이전 원본으로 가져오기 가능. 저장소 21개부터 첫 페이지 밖의 항목을 목록에서 열 수 없음 |

P1은 다음 수정 묶음에서 우선 처리, P2는 영향 조건이 있는 수정/확장 과제다.
P0나 실제 서비스 침해·중단을 확인한 것은 아니다.

## 확인한 항목

### R1 · P1 · 개정 이력이 조회 계산과 응답에 중복된다

- 위치: [service.ts](../apps/api/service.ts) 175–201행, 506–511행.
- 각 개정마다 전체 개정을 다시 탐색해 같은 슬롯의 **전체 history**를 붙인다.
  같은 슬롯에 R개 개정이 있으면 응답에 R²개의 history 항목이 들어간다.
  검색도 먼저 전체 overview를 만들고 결과를 거른다. 본문까지 모든 개정을 반환하며 페이지 제한이 없다.
- 격리된 실제 local service에서 같은 슬롯의 26-byte 본문을 부모 개정으로 연결해 게시했다.
  승인 없이도 재현된다. 아래 시간은 각 크기에서 한 번 측정한 값이며 SLA나 Fabric 실측이 아니다.

| 개정 수 | 응답의 history 항목 수 | JSON bytes | overview 계산 ms |
| ---: | ---: | ---: | ---: |
| 10 | 100 | 53,427 | 2.70 |
| 50 | 2,500 | 1,088,907 | 28.61 |
| 100 | 10,000 | 4,246,561 | 95.77 |
| 200 | 40,000 | 16,811,761 | 359.60 |

CPU 계산 외에도 전송·JSON 파싱·화면 처리 비용이 커진다. 시간 측정에는 JSON 직렬화·전송을 포함하지 않았다.
단순히 history를 한 번 계산해 공유해도 JSON에 중복 삽입하면 응답 크기는 줄지 않는다.

**수정 방향:** 목록/검색을 요약과 페이지 단위로 제공하고 본문·이력은 선택한 정확한 개정에서 조회한다.
슬롯별 판정과 체크포인트 조회를 중복 제거한다. 목록의 파생 상태가 resolver의 최종 사용 판정을 대신해서는 안 된다.
[local-ledger.ts](../packages/storage/local-ledger.ts) 104–112행도 전체 행 조회 후 각 행을 다시 읽는다.
범위 조회·일괄 검증으로 줄이되 현재의 projection 무결성 검사를 생략하지 않는다.

**완료 기준:** 10/50/100/200개 동일 슬롯 이력에서 목록 응답이 제곱으로 증가하지 않고,
페이지 이동과 과거 개정 상세에서 정확한 digest·slot·checkpoint가 유지된다.

### R2 · P2 · 인증 없는 health 요청마다 Fabric 조회 대기열을 사용한다

- 위치: [server.ts](../apps/api/server.ts) 171–176행, 198행;
  [application-ledger.ts](../packages/fabric/application-ledger.ts) 54–58행, 68–88행.
- `/healthz`가 인증과 세션별 요청 제한보다 먼저 `service.refresh()`를 실행한다.
  Fabric refresh는 하나의 큐에서 매번 peer tip을 조회한다. 이 경로에는 별도의 요청 수/동시성 제한이 없다.
- 실제 API와 Fabric adapter에 40ms 지연의 모의 peer/projection을 주입했다.
  일반 보호 경로는 익명 요청에 401을 반환했지만, 동시 익명 health 8건은 모두 200이었다.
  인증 함수 호출 0회, peer 조회 8회, peer 최대 동시 호출 1회, 전체 약 339ms였다.
- 서버의 loopback 바인딩은 노출 범위를 줄인다. `public_origin`과 reverse proxy로 health 경로를
  외부에 노출하고 별도 제한이 없으면 비인증 사용자가 정상 요청과 같은 대기열을 계속 점유할 수 있다.
  실제 peer 과부하·서비스 중단은 시험하지 않았다. 응답의 채널·체크포인트는 메타데이터이며 본문 유출 증거가 아니다.

**수정 방향:** 가벼운 liveness와 제한된 readiness를 분리하고, readiness 동시 실행 합치기 및
진입량/대기열 상한을 둔다. 관측용 health의 캐시를 resolver의 strict freshness 근거로 재사용하지 않는다.

**완료 기준:** 익명 health 동시 호출 수만큼 peer RPC와 대기열이 늘지 않고,
peer 장애 때 readiness와 지식 사용 판정이 각각 정해진 실패 동작을 지킨다.

### R3 · P2 · 공유 명령 대기가 비공개 동기화까지 막는다

- 위치: [service.ts](../apps/api/service.ts) 41행, 243–297행, 314–317행, 361–378행;
  [application-ledger.ts](../packages/fabric/application-ledger.ts) 39행, 54–59행, 111–135행.
- service의 한 `commandQueue`에서 게시/승인 등 원장 명령과 private source write·초안 편집을 함께 기다린다.
  Fabric adapter에는 별도로 refresh·execute·명령 관측을 직렬화하는 큐가 있다.
- 격리된 실제 configured service에서 게시의 `ledger.execute` 반환을 gate로 지연했다.
  뒤에 요청한 private import는 100ms 뒤에도 대기했고, gate 해제 후 둘 다 정상 완료됐다.
  외부 peer 지연을 실제 운영에서 측정한 결과는 아니다.
- configured Fabric 앱은 조직별 프로세스다. 따라서 일반 배포에서 모든 조직이 하나의 service 큐를
  공유한다는 지적은 과장이다. 영향 범위는 해당 프로세스의 사용자와 작업이다.

**수정 방향:** 외부 I/O 대기와 private atomic write의 잠금 범위를 재설계하고 큐 상한·대기 시간을 관측한다.
같은 actor/source의 CAS, 동일 command ID 재시도, 블록 적용 순서는 보존해야 한다.
서비스 큐만 여러 개로 나눠도 Fabric 큐 병목은 남으므로 함께 검증한다.

**완료 기준:** 느린 명령과 독립적인 private 작업을 함께 실행해 불필요한 대기를 줄이면서
동일 키 경합·재시도·actor 경계 테스트가 유지된다.

### R4 · P2 · 전체 Fabric 이력을 여러 메모리 구조에 보관한다

- 위치: [sqlite-projection.ts](../packages/fabric/sqlite-projection.ts) 87–89행, 155–160행,
  237–243행, 377–403행, 430–455행.
- 시작할 때 모든 raw block을 배열로 읽고 replay 결과 Map, 키별 값 이력 Map도 만든다.
  새 블록마다 계속 추가하며 시점별 값 조회는 해당 키의 이력을 선형 탐색한다.
- 코드상 보관 범위에 상한이 없다는 사실은 확인했다. 장기 운영 시 heap 크기·OOM·복구 시간은
  측정하지 않았다. 따라서 메모리 누수나 이미 발생한 장애로 부르지 않는다.
  전체 replay와 이력은 변조 검출·정확한 거래 증명에 쓰이는 현재 설계다.

**수정 방향:** raw journal은 보존하면서 순차 replay와 디스크 기반 검증 조회, 제한된 캐시를 검토한다.
오래된 이력을 단순 삭제하거나 SQL projection을 검증 없이 신뢰하는 변경은 피한다.

**완료 기준:** 긴 합성 VALID/INVALID 블록 이력에서 시작/증분 적용의 peak heap과 복구 시간을 측정하고,
메모리 보관량을 제한한 뒤에도 변조 검출·과거 checkpoint·원래 거래 receipt가 유지된다.

### R5 · P2 · 큰 manifest를 거절한 뒤 이전 선택으로 가져온다

- 위치: [app.js](../apps/web/app.js) 268–284행.
- valid manifest A와 폴더를 선택한 다음 131,073-byte manifest B를 선택하면
  128 KiB 제한에서 먼저 반환한다. 이전 manifest와 미리보기, 작업 버전을 무효화하는 코드는 그 뒤에 있다.
- 실제 Chromium에서 파일 입력은 B인데 A 미리보기와 가져오기 버튼이 유지됐고,
  클릭하면 A의 source로 import됐다. 이 동작은 private source에 한정되며 자동 공유 게시를 일으키지 않는다.

**수정 방향:** 파일 선택이 바뀌면 크기/유무 검사보다 먼저 이전 상태와 진행 중 응답을 무효화하고,
새 검증이 성공할 때만 가져오기를 허용한다.

**완료 기준:** valid A → oversized B, 선택 해제, 늦은 A 검증 응답 경로에서 A로 가져올 수 없다.
이번 실행으로 확인한 경로는 oversized B이며 나머지는 수정 시 회귀 검증 대상이다.

### R6 · P2 · 비공개 저장소 목록에서 다음 페이지로 이동할 수 없다

- 위치: [app.js](../apps/web/app.js) 224–245행;
  [source-store.ts](../packages/connectors/source-store.ts) 38–42행.
- API는 기본 20개와 `next_cursor`를 반환하지만 화면은 첫 응답만 표시하며 cursor를 사용하지 않는다.
  초안/명령 목록의 더 보기와 달리 저장소 목록에는 다음 페이지 동작이 없다.
- 격리된 configured app에 합성 source 21개를 넣고 Chromium으로 확인했다.
  API 첫 페이지 20개·다음 페이지 1개였으나 화면은 20개로 표시하고 가장 오래된 source는 목록에 없었다.
  데이터 삭제나 API 접근 상실은 아니다. 해당 manifest를 다시 선택하는 우회는 가능하다.

**수정 방향:** 다음 페이지/더 보기와 불러온 개수 표시를 추가하고, actor 변경 때 cursor·늦은 응답을 폐기한다.

**완료 기준:** 21개 이상에서 모든 source를 목록으로 열고 계정 전환 뒤 다른 actor의 목록이 섞이지 않는다.

## 제외한 지적과 유지할 설계

- **“15초 requestTimeout 때문에 30초 resolver가 중간에 끊긴다”는 오탐.**
  이 설정은 요청 전체의 수신 제한이다. [Node.js HTTP 문서](https://nodejs.org/docs/latest-v24.x/api/http.html#serverrequesttimeout)와
  Node 24.18.0 실행으로 확인했다. 수신 제한 100ms, 이미 수신된 본문, handler 지연 300ms에서
  약 314ms 뒤 200 응답을 받았다. 이 지적을 이유로 수신 제한을 늘릴 근거가 없다.
- **“완료된 명령 재시도마다 Fabric에 재제출한다”는 오탐.**
  adapter는 동기화 후 검증된 committed receipt를 확인하고 transport 호출 전에 반환한다.
  기존 테스트를 다시 실행해 retry 후 제출 횟수 1회를 확인했다. private tracking 상태를 VALID 판정 근거로 바꾸면 안 된다.
- resolver/revalidate의 fence 쓰기는 신선한 커밋 증거를 확보하는 의도된 계약이다.
  단순 읽기 API처럼 없애거나 임의 TTL로 대체하지 않는다.
- 운영자가 지정한 인증서 경로의 symlink 허용은 별도 방어 강화 제안이다.
  공개 인증서의 신뢰된 설정 경로에서 원격 공격 경로를 확인하지 못했으므로 취약점으로 세지 않았다.
- 동기 SQLite와 static genesis만으로 결함을 단정하지 않는다. 실제 병목은 위 경로와 부하를 기준으로 판단한다.

## 권장 수정 순서

1. R1의 목록/검색 응답 구조와 조회 비용을 줄인다. 정확한 개정 조회와 사용 판정은 유지한다.
2. R2의 health 비용 제한과 R5/R6의 작은 화면 버그를 수정한다.
3. R3의 큐 범위를 조정하고 동시성 회귀 검사를 추가한다.
4. R4는 긴 원장 기준을 먼저 측정하고 무결성 보존 조건으로 메모리 구조를 바꾼다.

R1/R2/R3/R4는 Claude의 지적을 소스/실행으로 좁힌 결과이며,
R5/R6는 Codex가 후속 브라우저 확인에서 발견했다. R1/R2/R3/R5/R6는 국소 재현,
R4는 코드 구조 확인 수준이다. 이것은 새로운 제품 기능 목록이 아니라 현재 구현의 개선 목록이다.

## 검토 범위와 근거

검토 대상은 API·인가·서명·저장소·도메인/Fabric adapter·source connector·SDK·guarded generation·웹 화면과
관련 테스트/설계다. 일반 코드 리뷰이며 전체 보안 스캐너 실행, 침투 시험, 접근성 인증,
실제 회사 데이터/인증서 또는 장기 Fabric 부하 시험을 수행한 것은 아니다.

Claude에는 선택한 Git 추적 파일을 `packet-ask`로 정리해 전달했다. 실행 DB, private source,
인증서/키, `.env`, 개인 인증파일, `.serena/`는 전달하지 않았다. 줄/값 redaction 때문에 일부
보안 관련 문자열은 보이지 않는 한계가 있다. 정리는 유출 방지나 공급자 보관 정책의 완전한 보장이 아니다.

기존 구독 Claude CLI에 정리된 패킷을 stdin으로 전달했다. 별도 임시 cwd에서
safe/restricted, 도구 없음, MCP 없음, 별도 세션 저장 없음으로 실행했고 전역 설정을 바꾸지 않았다.
두 초기 응답은 `claude-sonnet-5` 실제 실행 결과이며 코드 수정 권한으로 사용하지 않았다.

재현 결과와 반론을 전달한 세 번째 검토도 같은 모델로 완료했고, Claude는 두 오탐의 제외와
R1/R2/R3/R4/R5의 원인에 동의했다. R6는 이 재검토와 병행한 추가 브라우저 확인 결과다.
심각도와 구현 제안은 그대로 받아들이지 않고 다음처럼 조정했다.

- Claude는 R2를 P1로 보았다. 현재 loopback 기본값과 외부 health 노출 조건을 반영해 최종 P2로 두되,
  외부 공개 운영 전 우선 처리한다.
- Claude는 R5를 P3로 보았다. 실제 private source 쓰기가 이전 선택으로 수행됐으므로 단순 표시 결함보다 높은 P2로 판단했다.
- 메모리를 단순 LRU로 바꾸면 무결성이 자동 보존된다는 주장은 채택하지 않았다.
  현재 독립적으로 replay한 값과 SQL 파생값을 대조하는 구조라, 둘 다 같은 SQL 값을 읽게 바꾸면
  검증이 순환할 수 있다. R4는 raw journal에서 검증 근거를 복원하는 설계·회귀 시험이 선행돼야 한다.

| 패킷 | 파일 수 | bytes | SHA-256 |
| --- | ---: | ---: | --- |
| 서버/원장 | 36 | 505,802 | `0b9ae7675b8588f84dde3ef06a58494c0e779c5f4fdeae23775def152d216ed9` |
| 제품/화면 | 21 | 346,126 | `31b843fe9d4085a8632edda7c3691af82483761417d3621901eec2ee5091d9c6` |
| 재현 결과/오탐 재검토 | 7 | 245,240 | `9c8a5f7c76b05923b8f8cd17bf5341be265dc5bdb46b17325d2fb5a50ac81afe` |

로컬 상세 근거는 Git 제외 `.artifacts/claude-review-419a26d/`의 `*-review.md`, packet/응답 metadata,
`history-evidence.json`, `health-evidence.json`, `command-queue-evidence.json`, `ui-evidence.json`,
`source-list-evidence.json`, `timeout-evidence.json`, `idempotency-check.log`에 있다.
각 probe는 임시 데이터 폴더·포트·합성 입력을 사용했다. 기존 앱·원장·네트워크를 변경하지 않았다.

리뷰 중 멱등성/재시작 테스트 2개를 다시 실행해 통과했다. 기존 227개 런타임 검사·브라우저 9개는
이전 구현 검증 기록이며 이번에 모두 재실행한 것은 아니다. 런타임 코드 변경 없이 문서만 기록한다.
문서 링크·구조 검사는 `python3 -B tools/check_docs.py`, 공백 오류는 `git diff --check`로 검증한다.

## 후속 수정 — 2026-09-16

사용자의 수정 요청에 따라 R1–R6를 구현했다. 최초 검토의 오탐 두 건은 수정 대상에 넣지 않았다.

| 항목 | 적용한 변경 | 현재 근거 |
| --- | --- | --- |
| R1 | 최신 슬롯 요약·검색·제안·이력 페이지와 정확한 원문/제안 상세 분리, snapshot cursor, LocalLedger 일괄 조회 | 동일 슬롯200개 개정 overview **16,811,761→2,820 bytes**, 이력은20개/페이지, 원문 보존 |
| R2 | `/healthz` 원장 호출 제거, `/readyz` 단일 비동기 probe·1초 간격·5초 샘플 한도 | 익명 생존 확인8건에서 원장 호출0회, 실패/정체/회복 회귀 검사 |
| R3 | private CAS 쓰기와 service 원장 대기 분리, 명령 진입32개/adapter64개 제한, Fabric projection/transport 대기 분리 | 지연된 제출 중 private import와 refresh 완료, CAS·재시도·혼잡 상태 유지 |
| R4 | raw journal 순차 재생, 현재 상태 유지, 과거 snapshot/검증 block 각각8개 LRU, 최초 VALID 쓰기 anchor | 512블록의 시점별 읽기·영수증·변조·재시작 검사, 고정 키에서 raw29.5MB 추가 시 retained ArrayBuffer 증가9 bytes |
| R5 | 파일 선택 직후 이전 manifest·작업 버전·미리보기 무효화 | 유효 선택→초과/해제 및 늦은 검증 응답에서 가져오기 차단 |
| R6 | source cursor와 더 보기·불러온 개수 표시 | 실제21개 source를 모두 표시, actor 경계 유지 |

페이지 밖의 수정 부모·과거 제안 선택, 활성 합의 교체, 문서/제안 페이지 간 cursor 독립성,
더 최신인 상세 상태의 우선 표시, 비동기 이력 도착 뒤 입력한 승인 근거 보존도 브라우저로 검사했다.
관련 API는 콜론 ID와 retryable429를 영구 거절로 오인하지 않는 회귀 검사를 추가했다.

R4는 SQL 파생 테이블끼리 비교하는 것으로 증명을 대신하지 않는다. 검증 replay에서 만든 최초 쓰기/거래/raw digest와
대조하고, 재생 결과는 현재 검증 상태 및 원시 journal의 누적 digest와 맞아야 한다. 따라서 과거 INVALID 필터와
raw digest·파생 인덱스를 함께 바꿔도, 이후 쓰기로 최종 상태가 우연히 같아지는 경우까지 거부한다.
이 누적 digest는 로컬 무결성 검사용이며 별도의 원장 합의나 독립 Fabric quorum 증명이 아니다.

**검증:** `npm run check` 249 passed/0 failed/1 GC 전용 skip, `--expose-gc` projection 검사12개 모두 통과,
`check:types`, `demo`, `demo:kb` 통과. Chromium18개 통과. 외부 패키지 없는 복사본은208 passed/42 skipped.
`.artifacts/review-fixes/`에 실행 로그·성능 JSON·개발 앱 재시작 상태를 보관한다.

**남는 비용:** browse는 페이지마다 현재 전체 key 집합을 읽어 O(N) 계산한다. 현재 Fabric 상태와 최초 쓰기
metadata는 key 수에 비례하고, 과거 snapshot은 최대8개 상태 복사본을 보관한다. 캐시 미스 과거 조회와
시작 시 검증 replay 비용은 남는다. 고정 키 합성 측정은 성장하는 문서 집합의 메모리 상한이나 운영 SLA를 뜻하지 않는다.
1,000개 문서 실험은 모든 요약 페이지를 순회하므로, 이전 단일 거대 응답의 시간과 같은 작업으로 비교하지 않는다.

호출자 변경 사항과 readiness 의미는 [실행 API](11-RUNTIME.md#조회-페이지와-원문), 상세 실행 기록은
[검증 기록](VALIDATION.md)에 있다. 기존 앱/원장 데이터는 보존했고 chaincode 재배포나 네트워크 초기화는 하지 않았다.

### 이후 조회 인덱스 최적화

페이지마다 모든 원문을 읽던 위의 O(N) 경로는 [검증된 조회 참조 인덱스](26-BROWSE-INDEX.md)로 개선했다.
선택된 페이지의 canonical 값만 읽으며, 새 substring 검색의 최초 후보 원문 읽기와
cache miss의 메타데이터 순회는 남는다. 최신 검증은 해당 문서와 검증 기록을 따른다.
