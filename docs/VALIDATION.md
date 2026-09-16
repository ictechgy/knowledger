# 검증 기록

## 테스트 인증서 갱신 — 2026-09-16

9월22일 만료 예정이던 예제 User1 인증서3개를 **2026-12-15T06:29:11Z**까지 갱신했다.
81개 공개 인증서 중 해당3개만 교체됐고 모든 공개키는 같다. 교체 대상 외130개 파일은 내용·inode·수정시각을
유지했다. 사용자/CA 개인키, peer/orderer TLS, MSP, genesis를 보존했으며 원장 초기화·chaincode 재배포는 없었다.

- `npm run check`: **274 passed /0 failed /1 GC 전용 skipped**. 이전 GC 검증은 해당 코드가 같아 재사용했다.
- `npm run check:types`, `npm run demo` 통과.
- 인증서·signer 집중 검사 **19개 통과**. signer 만료 경계 테스트가 수정 전 실패하고 수정 후 통과했다.
- 기존 키·속성 유지, 공개 점검의 키 접근 없음, tamper·actor/CA/key mismatch, CA 유효기간,
  만료 후 갱신, 중간 rename 및 rename 후 fsync 실패 롤백, 부분 적용 재개와 재실행을 검사했다.
- 외부 패키지 없는 source copy에서 공개 인증서81개 점검 정상 종료. 개인키는 복사하지 않았다.
- 독립 리뷰의 raw Fabric attribute 인코딩과 재실행 시 재시작 안내 문제를 수정하고 재검토했다.

기존 인증서로 서명한 실제 거래를 제출하고 acknowledged outbox를 저장한 뒤 연결을 종료했다.
새 인증서 연결에서 commit bytes를 이용해 재제출 없이 복구했고, 전체 블록에서 **VALID247**을 확인했다.
세 조직 각각 새 인증서·별도 signer로 인증 조회와 fence 쓰기를 실행해 **VALID248/249/250**을 확인했다.
이는 이전 인증서가 아직 유효한 중첩 기간의 실제 복구 검증이다.

설정 기반 통합 검증은 게시251·승인253·활성254·철회262, 최종 block265로 통과했다.
OIDC, SDK exact revision, 결과 반환 직전 철회 차단, 원래 receipt 재시도와 version3 복원 후 private 데이터 유지도 확인했다.
시험 합의는 기존4318 앱에서 다시 조회해 withdrawn을 확인했다.

Fabric 앱5개와 signer를 정상 재시작했고 기본4317은 기존 local block1·문서0개를 유지했다.
앱6개의 liveness와 probe 완료 후 readiness200, OIDC 앱4개의 익명 overview401,
3 peer·3 orderer running을 확인했다. readiness는 기존 계약대로 오래된 표본에서503을 반환하고 비동기 probe 후200이 된다.

실행 근거는 `.artifacts/certificates/`의 `check.log`, `types.log`, `targeted.log`, `demo.log`,
`before.json`, `after.json`, `restart.json`, `fabric-evidence.json`, `runtime-health.json`, `no-optional.json`과
`.data/configured-smoke-LACMrn/evidence.json`이다. 강제 종료 복구는 부분 적용 상태 구성으로 검증했으며 실제 SIGKILL은 주입하지 않았다.
원격 공개/CI는 실행하지 않았다. [명령·실패 복구·제한](27-TEST-CERTIFICATES.md)을 참조한다.

## 조회 참조 인덱스 최적화 — 2026-09-16

기준 `de3e953`의 별도 source copy와 수정본을 같은 Node24·1,000개1KiB 문서·5회·모든50개 요약 페이지
순회 조건으로 비교했다. 두 비교 실행 동안 다른 테스트/브라우저 부하를 함께 실행하지 않았다.

| 항목 | 이전 | 이후 |
| --- | ---: | ---: |
| overview 전 페이지 p95 | 1,071.24ms | 176.56ms |
| search 전 페이지 p95 | 995.32ms | 209.72ms |
| publication p95 | 1.43ms | 1.58ms |
| restart replay | 248.99ms | 268.17ms |

읽기 비용은 이 표본에서 약84%/79% 감소했다. 인덱스 유지 비용으로 쓰기/재시작은 소폭 증가했다.
10,000개에서도 전체 목록/검색/재시작 뒤 개수 일치. 단일 순회는 목록1.71초·검색2.05초·replay2.69초였다.
운영 SLA나 대규모 Fabric 성능 보장은 아니다. [구조와 측정 범위](26-BROWSE-INDEX.md)에 제한을 명시했다.

- `npm run check`: **264 passed /0 failed /1 GC 전용 skipped**.
- `node --expose-gc --test test/fabric/sqlite-projection.test.ts`: **14 passed /0 skipped**.
- `check:types`, `demo`, `demo:kb` 통과. Chromium **18개 통과**.
- 외부 패키지 없는 source copy: **221 passed /0 failed /44 skipped**.
- 페이지에서 전체 revision/proposal/agreement prefix scan 없이 선택된 canonical 값만 읽는 것을 계수했다.
  metadata index와 검증 scan 호환 경로의 응답 순서/값, 과거 cursor, fresh withdrawal withheld를 확인했다.
- 검색 scope·한글·emoji·짧은 문자열·literal `%_`·잘못된 Unicode, 캐시 entry/ID/byte 상한을 확인했다.
- SQL rollback, 원시 journal 재생/복원, mutable indexed field 변조, 다중 거래/INVALID/빈 Fabric 블록,
  파생 SQL 누락·변조를 검사했다. 시작 시 원문 write 배열을 누적하지 않고 generator로 참조를 구성한다.

실제 설정 기반 Fabric 재검증도 통과했다. 게시232·승인234·활성235·철회243, 최종 block246.
OIDC, 원래 receipt 재시도, SDK exact revision, 반환 직전 철회로 output 차단,
version3 복원 후 index/source/초안/명령 유지가 근거다. 시험 합의는 withdrawn으로 확인했다.
이번에는 peer 중단이나 chaincode 재배포를 반복하지 않았다.

근거는 `.artifacts/browse-index/`의 비교 JSON, check/types/browser/memory/no-optional 로그와
`.data/configured-smoke-X8z08j/evidence.json`이다. 기존6개 앱을 graceful restart했고 로그인 세션은 초기화됐다.
기본4317의 빈 local block1과 기존 private 데이터·인증서를 보존했다. 원격 공개/CI는 실행하지 않았다.

## 실제 Fabric 쓰기·동시 요청·장애 복구 — 2026-09-16 13:23 KST

런타임 `90bdcda`를 기존 Colima3 peer·3 Raft orderer에서 검증했다. 새 임시 앱 데이터/포트를 사용했고,
최초 `fabric:smoke`, 네트워크 초기화, chaincode 재배포는 실행하지 않았다.

| 시나리오 | 확인한 결과 |
| --- | --- |
| HTTP 게시→승인→활성→철회 | VALID block207→209→210→214. peer 전체 블록에서 확인한 원래 receipt 사용 |
| 동시 요청 | 동일 게시3건이 같은 receipt와 VALID 게시1건, private import2건이 초안1개로 귀결 |
| 읽기/상태 확인 병행 | overview8건, `/healthz`16건, `/readyz`16건 병행 완료 |
| 원장 제출 대기 분리 | 해당 실행에서 private import 약111.5ms, 첫 게시 receipt 약1,174.1ms. private 작업이 먼저 완료 |
| 실제 peer 장애 | Fulfillment peer 중단 중 readiness/resolve503, liveness200. 다시 기동한 뒤 fresh provided 복구 |
| 앱 재시작 | 동일 승인 명령이 원래 checkpoint/result 반환. 이전 run은 `SESSION_RESTARTED_RESOLVE_AGAIN`으로 보류 |
| 철회 전파 | 기존 manifest 재검증과 새 resolve 모두 withheld |
| 설정 기반 OIDC/별도 signer | 선택한 조직만 연결, 미등록 subject403, 브라우저 역할 변경403, 계정 비활성화 후401 |
| 설정 기반 게시→승인→활성→철회 | VALID block217→219→220→228 |
| SDK/guarded generation | 정확한 원문/manifest 검사, 결과 반환 직전 철회 시 output 미반환 |
| version3 백업/복원 | 원장 projection·원래 command receipt·private source·초안 유지, 복원 후 철회 상태 유지 |

HTTP 검증은206→216, 설정 기반 검증은216→231까지 진행됐다. 시험 합의2건은 최종 앱에서
다시 조회해 **withdrawn**을 확인했다. 합성 공유 개정/승인/철회 이력은 원장에 남는다.

`fabric:http-smoke`는 이번 실행 시작 checkpoint 이후의 events만 검사하도록 수정했다.
처음100블록만 확인하던 방식으로는 긴 원장에서 새 게시를 검증할 수 없었다. 두 스크립트의 활성화 기대값은
새 목록 계약의 `active_agreement`를 사용한다. 실패 시 단계와 정리 결과도 evidence에 남기고,
기동한 peer 복구 및 아직 활성인 시험 합의 철회를 시도하도록 보완했다.

최종3 peer·3 orderer가 모두 running.4317·4318·4319·4321·4331·4341의 health/readiness200,
OIDC 앱4개의 익명 overview401을 확인했다. 기본4317은 block1·문서0개 그대로이며4318은 Fabric block231이다.
기존 앱을 재시작하거나 기존 private DB를 바꾸지 않았다. 시험 앱과 signer/issuer는 종료했다.

실행 근거:

- `.data/fabric-http-smoke-Z7z3wH/http-evidence.json`
- `.data/configured-smoke-1R4sjZ/evidence.json`
- `.artifacts/fabric-verification/{http-smoke,configured-smoke,types}.log`, `final-state.json`

`npm run fabric:http-smoke`, `npm run configured:smoke`, `npm run check:types` 통과.
제품 런타임 변경은 없으며 기존249개 런타임·Chromium18개 검사는 앞선 기록을 재사용했다.
수치는 한 번의 작은 통합 시나리오이며 운영 처리량/SLA, 독립 호스트 장애나 orderer quorum 장애의 증거가 아니다.

## Claude 리뷰 후 성능·보안·구조·사용성 수정 — 2026-09-16

`399f78b`의 리뷰 기록에 대한 R1–R6 수정이다. 원래 발견과 최종 제한은
[공동 리뷰의 후속 수정](25-CLAUDE-REVIEW.md#후속-수정--2026-09-16)에 있다.

- `npm run check`: **249 passed /0 failed /1 skipped**. skip은 명시적 GC가 필요한 메모리 실험이다.
- `node --expose-gc --test test/fabric/sqlite-projection.test.ts`: **12 passed /0 skipped**로 해당 실험까지 확인.
- `npm run check:types`, `npm run demo`, `npm run demo:kb` 통과.
- `npm run test:browser`: **Chromium18개 통과**. source21개 pagination, 큰/해제된 manifest와 늦은 응답,
  문서·제안 페이지 동시 이동, 페이지 밖 부모 개정·과거 제안 유지, 활성 합의 교체,
  더 최신인 상세 상태 우선 표시와 승인 근거 입력 보존을 포함한다.
- 외부 패키지 없는 source copy: **208 passed /0 failed /42 skipped**. optional Fabric/auth/GC 조건을
  분리했고 로컬 실행 경로에 새 외부 의존성을 추가하지 않았다.
- API는 actor/조회조건/snapshot에 결속된 cursor, invalid query, 콜론 ID, 명령 대기 상한,
  retryable429 후 같은 명령 재시도, 지연된 게시 중 private CAS, health/readiness 실패·정체·회복을 검사한다.
- projection은 최초 VALID 쓰기/영수증 locator 변조, history/current 변조, live VALID filter/raw digest 동시 변조,
  최종 값이 같아지는 과거 메타데이터 변조, append rollback, additive index 재구축을 검사한다.

### 측정

같은26-byte 문서를 한 슬롯에서200번 개정한 overview JSON은 **16,811,761→2,820 bytes**다.
새5회 계산은 약7.33–9.70ms였고 이력은20개씩22,176 bytes로 조회됐다. 전체 원문과200개 이력은 유지된다.
이전359.6ms는 한 번의 로컬 측정이므로 p95/SLA 개선으로 표현하지 않는다.

1,000개1KiB 문서 실험은 모든50개 요약 페이지를 끝까지 순회해 검색/목록 p95 약1,095.74/1,071.22ms,
재시작 replay 약255.24ms였다. 전체1,000개를 재시작 전후 모두 조회했다. 이전 단일 거대 응답과
새 전체 페이지 순회는 서로 다른 작업이며, 첫 페이지 응답이나 Fabric 운영 성능의 보증이 아니다.

고정 key를 갱신하는64→512블록 실험은 raw29,527,920 bytes를 추가했고, GC 뒤 retained ArrayBuffer 증가9 bytes였다.
512블록에서 현재 읽기16회 약0.14ms, warm 과거 영수증16회 약0.68ms, cold 영수증 약15.36ms,
검증 재시작 약25.55ms. 상태 key가 늘면 현재 상태/anchor도 늘고 과거 snapshot은 최대8개를 보관하므로
이 결과를 전체 heap이 항상 일정하다는 주장으로 사용하지 않는다.

### 실행 중인 앱

기존 데이터 폴더를 보존하고4317·4318·4319·4321·4331·4341 개발 앱만 graceful restart했다.
모두 `/healthz`와 `/readyz`200. 기본4317은 local block1·문서0개,4318은 실제 Fabric block206·최신 슬롯4개.
OIDC 앱4개는 익명 overview401. 4318에서 exact revision view/history의200과 페이지 한도를 읽기 전용으로 확인했다.
이번 검증은 실제 Fabric 새 거래 제출·peer 정지·chaincode 배포·네트워크 초기화를 하지 않았다.
개발 로그인 세션은 재시작으로 초기화됐다.

상세 근거: `.artifacts/review-fixes/{check-final,types-final,browser-final,projection-memory-final,no-optional-check}.log`,
`history-after.json`, `performance-1000.json`, `runtime-health.json`, `live-fabric-browse.json`.

## Markdown KB 연결과 지식 클라이언트 — 2026-09-16

- `npm run check`: **227 passed /0 failed /0 skipped**, `check:types`·`demo`·`demo:kb` 통과.
- 외부 패키지 없는 새 source copy: **192 passed /0 failed /35 optional skipped**.
  마지막 SDK의 strict nested manifest 검사12개도 해당 copy에서 별도로 통과했다.
- `npm run test:browser`: **Chromium9개 통과**. 기존7개에 저장소 allowlist/반복/변경 가져오기,
  비공개 상태 격리, 잘못된 파일과 계정 전환 중 업로드 차단을 추가했다.
- 파일 reader는 symlink/hardlink/FIFO/숨김·상위 경로/256KiB·16MiB 한도/UTF-8·BOM·CRLF,
  삭제된 하위 폴더와 읽는 도중 inode 교체를 검사한다. allowlist 밖 파일을 읽지 않는 브라우저 검사도 통과했다.
- source API는 global version CAS, operation 재시도, actor 격리, private path/hash 비공개,
  receipt 저장 실패 시 draft/state rollback, URL-encoded source ID와 동시 쓰기를 확인했다.
  256KiB 파일64개(16MiB) 뒤 추가 import가 거절되고 기존 state·초안64개가 보존되는 것도 확인했다.
- SDK는 full revision·strict fence/manifest binding, 별도 개발 mode opt-in, timeout/abort,
  늦은 header callback의 전송 차단, 잘못된/만료된 증거 거부를 확인했다.
- `demo:kb`는 합성 원본을 가져와 **미승인 withheld→가상 담당자 승인 후 provided→생성 중 철회 withheld**를
  실제 로컬 HTTP 경로로 실행한다. model은 로컬 callback stub이며 외부 모델 요청은 없었다.
- 실제 `configured:smoke`: private source import·재시도·동일 파일 재사용,
  VALID 게시192·승인194, SDK의 정확한 개정 검증, release authorization 단계의 철회 후 output 차단,
  v3 복원 뒤 source와 draft 보존을 확인했다. `.data/configured-smoke-zv1THX/evidence.json`.
- 기존6개 앱을 새 코드로 재기동했고4317 health200/block1, Fabric 앱들 health200/block206 확인.
  기존 데이터·원장·인증서는 보존했다. 원격 push와 CI 실행은 하지 않았다.

이번 근거 로그는 `.artifacts/kb-integration/`에 있다. SDK는 신뢰하는 Knowledger 응답을 검증하며
별도의 Fabric quorum proof를 검증하지 않는다. 실제 회사의 source/SSO·모델 공급자·egress 운영 설정은
이번 합성 데이터/개발 IdP·local callback 검증과 구분한다.

## 요청 추적·개정 비교·자동화 검사 — 2026-09-16

- `npm run check`: **197 passed /0 failed /0 skipped**. `check:types`, `demo` 통과.
- 외부 패키지 없는 source copy: **162 passed /0 failed /35 optional skipped**.
- `npm run test:browser`: **Chromium 7개 통과**. 기본 실행과 분리된 Playwright1.63.0 패키지를 고정했다.
  게시·2조직 승인·조회·철회, 계정별 비공개 상태, exact revision diff, 앱 재시작 후 pending 복원,
  확인503·지연 커밋·이전 계정의 늦은401·빠른 중복 클릭·게시 응답 유실을 검사한다.
- 미확정 거래 GET은 새 proposal/endorsement/submission을 만들지 않는다. 확인된 peer 상태는
  로컬 outbox 관측 캐시에 저장할 수 있다. SDK VALID만으로 완료하지 않고 projection의
  원래 actor/type/digest/tx receipt를 확인한다. POST retry는 저장된 명령을 그대로 사용한다.
- 실제 `configured:smoke`: VALID 게시184·승인186, 요청 조회의 동일 checkpoint,
  같은 요청 재시도의 원래 receipt, v3 복원 후 요청 이력 보존 통과.
  근거 `.data/configured-smoke-911QRl/evidence.json`.
- `test:performance --documents 1000 --samples 5 --body-bytes 1024`:
  Node24.18.0/macOS arm64/12 logical CPU. 작성·미리보기·게시 p95 약1.85ms,
  검색 p95 약247.59ms, overview p95 약249.07ms, 재시작 replay 약262.15ms,
  DB footprint30,367,448 bytes. 생성/조회/replay 문서1,000개를 각각 확인했다.
  `.artifacts/experiments/performance-1000.json`에 기록했다. 작은 표본의 현재 장비 측정이며 SLA 판정은 아니다.
- `test:resilience`: 별도 Node worker 강제 종료→재기동→동일 명령 재시도의 단일 효과,
  종료 후 snapshot/restore 동일 상태, fixture peer 장애의 strict503→복구200 통과.
  `.artifacts/experiments/resilience.json`. 실제 Fabric 호스트 장애나 재해 복구 시간의 증거는 아니다.
- 새 체크아웃에서 `.data`가 없어도 CLI가 실행되며 상대 output 경로를 지원한다.
  기존 nonempty 데이터 폴더를 거부한다. CI에 브라우저·소규모 성능·장애 실험 명령을 연결했다.
- 브라우저 검사 중 발견한 재시도 후 화면 갱신 누락, 계정 전환 뒤 요청 목록 재로딩 누락,
  응답 유실 뒤 게시 결과 미표시를 회귀 검사와 함께 고쳤다.

근거 로그는 `.artifacts/delivery/{check,browser,no-optional-check}.log`다.
기존 원장·키·데이터는 보존했고 원격 push/CI 실행은 하지 않았다.

## 범용 조직 설정과 예제 분리 — 2026-09-16

- `npm run check`: **178 passed / 0 failed / 0 skipped**, 설계 계약·문서 검사 통과.
- `npm run check:types`, `npm run demo` 통과. 새 외부 의존성을 추가하지 않았다.
- 의존성·runtime 없는 별도 source copy: **143 passed / 0 failed / 35 optional skipped**.
  마지막 local snapshot 재기동·legacy channel 검사도 해당 copy에서13개 통과했다.
- 임의 2·4조직의 빈 초기 상태, 중복 actor 이름의 조직 구분, 전원 승인 전 제공 보류,
  actor별 비공개 초안, 설정/데이터 바인딩, 고정 HTTPS Host/Origin과 chaincode 패키징을 검증했다.
- `npm run configured:smoke`: 기존 테스트 네트워크에 새 JSON 설정·OIDC·별도 generic key signer를 연결.
  게시/승인 VALID block159/161, 미등록 subject·역할 변경 거부, 철회 후 withheld,
  version3 snapshot 복원 뒤 비공개 초안·상태 재조회 통과.
  `.data/configured-smoke-IUrZJI/evidence.json`에 근거가 있다. 선택하지 않은 조직의 인증서 경로는
  존재하지 않는 값으로 두어 해당 파일을 읽지 않는 것도 확인했다.
- 예제 회귀: `organization:smoke` 게시block167·3개 앱·단일 key/outbox·scope 복원;
  `auth:smoke` 게시/승인block175/177·권한 회수·전송 전 취소·signer 복구·version1 복원 통과.
  근거는 `.data/organization-smoke-WZUdAW/organization-evidence.json`,
  `.data/auth-smoke-2ME3X7/auth-evidence.json`이다.
- 새 프로필의 복원 manifest를 scope 검사가 거부하는 문제를 재현한 뒤 고쳤다.
  복원 파일 존재 검사에 더해 `ensureConfigurationScope`와 앱 재기동을 회귀 검사에 포함했다.
- 브라우저: 2조직 초안→미리보기→게시→승인→활성→제공, 계정 전환 시 private 목록 제거,
  최신 개정이 있어도 검토함의 정확한 과거 개정 본문 선택, 내비게이션 focus를 확인했다.
  390/600/1440px에서 가로 넘침 없음, 600px 문서 목록1열. 스크린샷 비교는 수행하지 못했다.
  일부 native click이 반영되지 않아 DOM 이벤트를 사용했다. 근거는 `.artifacts/configuration/ui-evidence.json`이다.

실제 물리적 2·4조직 Fabric 네트워크, 회사 SSO/KMS, 독립 호스트의 장애 내성은 이번 검사 범위가 아니다.
chaincode는 재배포하지 않았으며 기존 테스트 원장·인증서·공유 이력을 보존했다. 원격 push와 CI 실행은 하지 않았다.

## 조직별 실행과 Claude 디자인 논의 — 2026-09-16

`npm run check`: **154 passed / 0 failed / 0 skipped**, `npm run check:types`와
`npm run demo` 통과. 의존성·runtime 파일이 없는 source copy도 **119 passed / 0 failed /
35 optional skipped**로 통과했다. 마지막 manifest의 문자열 mode 검증을 보강한 뒤 snapshot
검사15개와 타입 검사를 다시 통과했다.

조직 scope 검사8개는 새 폴더 바인딩, 기존 DB 자동 채택 거부, 다른 조직/로컬/비인증 재사용 거부,
권한·symlink·불완전 파일·잘못된 JSON과 재시작을 확인했다. 서명 서비스는 선택한 조직의 파일만
읽고 다른 key ID를 거부하는지 실제 승인된 테스트 키와 SDK 서명 검증으로 확인했다.
CLI의 누락/잘못된 organization 옵션은 data 파일 생성 전에 실패한다.

실제 브라우저 쿠키는 포트를 구분하지 않는다는 점을 테스트 helper에도 반영했다.
서로 다른 두 앱에 로그인할 때 첫 세션이401이 되는 실패를 재현했고, 앱·IdP 이름을
origin별로 나눠 두 로그인과 독립 로그아웃을 검증했다. origin별 쿠키 이름은 같은 호스트의
악의적인 서비스에 대한 보안 경계로 취급하지 않는다.

`npm run organization:smoke`의 최종 근거는
`.data/organization-smoke-yggNNy/organization-evidence.json`이다. 사용자와 같은 CLI 진입점으로
**별도 앱 프로세스3개**와 각 IdP·단일 키 signer를 실행했다.

- 세 앱의 동시 로그인 유지, 자기 outbox1개와 private 초안·개수 격리.
- 다른 subject 로그인·다른 조직 초안 조회·잘못된 조직 승인 거부.
- 명시적으로 게시한 개정은 다른 조직에서도 열람, 사람 승인·활성 뒤 provided, 철회 뒤 withheld.
- 한 조직 프로세스 종료→version2 scoped 백업→새 폴더 복원→새 프로세스 로그인·초안/철회 상태 확인.
  그동안 다른 조직 세션 유지, 다른 조직과 unscoped 모드로 복원 폴더를 여는 요청 거부.

기존3조직 통합 모드의 `auth:smoke`도 재검증했다. 근거는
`.data/auth-smoke-rsdSdP/auth-evidence.json`이며 게시/승인은 VALID block128/130이었다.
권한 회수·미제출 취소·signer 장애 복구·version1 백업/복원 흐름을 유지했다.

웹 디자인은 사용자 요청에 따라 화면 코드3개만 정리해 실제 Claude Sonnet5와 논의했다.
제안과 소스 대조, 전달 범위는 [검토 기록](18-DESIGN-REVIEW.md)에 남겼다.
`DESIGN.md`는 필수 heading·placeholder 검사와 문서 링크 검사를 통과했다.

브라우저에서 HTTP202 응답을 주입해 pending 안내가6.5초 뒤 사라지는 동작을 재현하고,
수정 후6.8초에도 유지됨을 확인했다. 새 게시본은 “공유 게시됨·합의 전”, 기존 제안은 “합의 검토 중”,
활성 문서는 “합의 활성”으로 구별했다. 390/1440px에서 가로 넘침은 없었다.
이는 상태 동작 검증이며 전체 디자인 재구성이나 스크린샷 비교 완료가 아니다.

현재4319 통합 앱과4321/4331/4341 조직 앱을 최신 소스로 실행하고 healthz200·block144를 확인했다.
세 peer·Raft orderer와 앱들은 같은 로컬 환경이다. 실제 회사 인증·독립 기관/OS/host·HSM/KMS,
운영 재해 복구·성능 SLA를 검증한 것으로 확대하지 않는다.

## 비공개 초안 재개와 런타임 백업·복원 — 2026-09-16 02:30 KST

`npm run check`: **140 passed / 0 failed / 0 skipped**, `npm run check:types`와
`npm run demo` 통과. 외부 패키지·runtime 데이터가 없는 별도 source copy의 `npm test`도
**107 passed / 0 failed / 33 optional skipped**로 통과했다.

초안 API 검사 10개는 본인 목록·본문·개수, 타 actor와 cursor의404, 익명401·CSRF403,
수동/가져온/공유 개정 기반 초안의 재개, 원본·slot·dependency·parent 보존,
동시 수정·재시작 후 같은 edit_id 결과, 변경된 요청409를 확인한다. 새로 저장한 초안에
private 출처나 원본 파일 hash를 공유 metadata로 복사하지 않는다.
저장된 revision의 digest·author 바인딩을 검증하고 손상된 상세/목록은503으로 보류한다.

동일 timestamp와 페이지 사이 insert를 검사했다. malformed JSON의 정렬 값이 null이어도
cursor 뒤에서 조용히 누락되지 않는다. 긴255-byte 파일명·대문자 `.MARKDOWN`을
가져온 뒤 재조회가503으로 실패하던 검증 불일치는 실패 테스트 후 공통 파일명 검증기로 수정했다.
목록은 body를 JS로 올리지 않고 SQLite JSON projection으로 필요한 요약만 읽는다.
실제 페이지 조회의 `EXPLAIN QUERY PLAN`은 `private_draft_actor_order`를 사용했고
추가 임시 정렬은 없었다. startup마다 index를 삭제·재생성하지 않는다.

백업 검사 13개는 local/Fabric 파일 프로필, 읽기 전용 SQLite 무결성, 원본 hash·stat 보존,
WAL/SHM/journal·손상 manifest·hash 변조·잘못된 파일·symlink·실제 중첩 경로 거부를 확인한다.
단순히 순서대로 호출하지 않고 **별도 Node 프로세스 두 개**를 동시에 시작해 한 백업만
대상을 확보하는지 확인했다. 첫 DB 복사 직후 원본 DB 변경과 두 번째 복사 전 실패를 주입했고,
잘못된 출력이나 소유 staging 잔여물을 남기지 않았다. CLI 상대경로 backup/restore도 통과했다.
복원은 새 디렉터리에만 수행하고 파일0600·디렉터리0700을 유지한다. 파일·디렉터리를 flush한다.

격리 브라우저에서 저장→새로고침→키보드로 다시 열기→수정본 저장→원본 재조회,
계정 전환 후 제목·개수·본문 제거를 확인했다. 이전 계정의 목록 응답을 지연시킨 뒤 계정을
바꿔도 늦은 응답이 목록을 복구하지 않았다. 390/1440px에서 가로 넘침이 없었다.
근거는 `.artifacts/private-drafts/ui-evidence.json`이며 브라우저/별도4321 서버는 종료했다.
스크린샷 검증은 하지 않았다.

실제 OIDC·서명·Fabric 검증은 `.data/auth-smoke-LeU5Zr/auth-evidence.json`에 있다.
private import·목록·재조회·수정 동안 원장 checkpoint가 같았고 명시적 게시/승인은
peer VALID block **111/113**에서 확인했다. 권한 회수·서명 서비스 장애 복구·철회 검증 후 앱을
종료하고 `.data/auth-snapshot-8221ca3a`에 DB를 백업했다. `.data/auth-restored-8221ca3a`로
복원한 새 앱의 projection checkpoint가 일치했으며, 재로그인 후 두 초안·원문·수정 재시도와
철회된 지식의 withheld를 재검증했다. 로그인 세션은 복원되지 않았다.

최신 기능은 `http://127.0.0.1:4319`에 반영했다. 이 검증은 로컬 앱 데이터 복구다.
peer/orderer·CA·키의 전체 인프라 재해 복구, 독립 조직 운영, 운영 RTO/RPO·대규모 성능은
아직 측정하지 않았다. [초안 가이드](15-PRIVATE-DRAFTS.md)와 [백업 가이드](16-RUNTIME-BACKUP.md)를 참조한다.

## Markdown 비공개 초안 가져오기 — 2026-09-16 01:49 KST

`npm run check`: **117 passed / 0 failed / 0 skipped**, `npm run check:types`와
`npm run demo` 통과. 외부 의존성을 추가하지 않고 기존 actor별 private store와
공개 preview·게시·승인 경로를 재사용했다.

추가 HTTP 회귀 검사 5개에서 다음을 확인했다.

- BOM·CRLF·한글 원문 보존, 256 KiB 본문과 255-byte 파일명 경계.
- 동일·동시 요청과 재시작 뒤 같은 초안 반환, 변경된 입력의 import_id 재사용은409.
- 익명401·CSRF 누락403·다른 actor의 preview404, AI actor의 초안 가져오기 허용.
- 잘못된 UTF-8·제어문자·Base64·파일 경로·초과 크기·빈 base digest·추가 필드 거부.
- 가져오기와 preview의 원장 쓰기 없음, 확인 없는 게시 거부, 게시 후 파일명·요청 ID·원본 hash 비노출.
- frontmatter와 링크를 해석하지 않고 원문에 보존, 기존 개정의 slot·의존성·parent 유지.

빈 base digest가 새 문서로 처리되던 경우를 실패 테스트로 확인한 뒤 가져오기 경계에서
거부하도록 수정했다. 공유 확인 검사는 command_id를 함께 보내 실제로
`PUBLICATION_CONFIRMATION_REQUIRED`를 받는지 확인한다.

`agent-browser`의 격리 브라우저에서 키보드로 파일 가져오기, 편집창 표시·공용 목록 미노출,
HTML script 비실행, 공유 확인 전 게시 비활성, 편집 후 preview 초기화, 잘못된 UTF-8 거부를
확인했다. 실제 import 응답을 지연시킨 뒤 작성창을 닫아 늦은 응답이 본문을 복원하지 않는지도
확인했다. 390/1440px에서 가로 넘침이 없었고 파일 입력→가져오기 버튼의 Tab 이동을 확인했다.
근거는 `.artifacts/markdown-import/ui-evidence.json`; 브라우저와 별도 UI 테스트 서버는 종료했다.
스크린샷 검증은 하지 않았다.

실제 OIDC·별도 서명 프로세스·Fabric의 `npm run auth:smoke`도 통과했다. 근거는
`.data/auth-smoke-JkDZbf/auth-evidence.json`이다. 파일 가져오기·동일 요청 재시도 동안 원장
checkpoint가 그대로였고, 명시적인 게시/승인은 peer VALID block **103/105**에서 확인했다.
게시 거래에 원본 파일명은 없었고, 후속 권한 회수·서명 장애 복구·철회 후 withheld도 통과했다.

첫 실행은 게시 뒤 검사 코드의 이벤트 조회 한도 초과로 중단됐다. 게시 거래가 들어 있는
블록 한 개를 정확히 조회하도록 검사 코드를 수정한 뒤 위 전체 흐름을 통과했다.
그 실행의 미승인 게시본(block102)은 불변 테스트 이력으로 보존했다.

최신 기능은 `http://127.0.0.1:4319`에 반영했다. 자세한 흐름과 요청 계약은
[Markdown 가져오기 가이드](14-MARKDOWN-IMPORT.md)를 참조한다.

## 개발 OIDC 로그인과 별도 서명 프로세스 — 2026-09-16 01:29 KST

`npm run check` **112 passed / 0 failed / 0 skipped**, `npm run check:types`
**TypeScript 7.0.2 strict 통과**, `npm run demo` 통과. 기본 로컬 실행을 보존하기 위해
외부 패키지와 runtime 데이터가 없는 별도 source copy에서도 **79 passed / 0 failed /
33 optional skipped**를 확인했다. 이 검사에서 발견한 issuer 테스트의 정적 import를
지연 import로 수정했고, 설치된 환경의 해당 테스트 5개도 다시 통과했다.

auth 패키지는 openid-client 6.8.8 / oidc-provider 9.12.2 / jose 6.2.12로 고정했다.
해당 lockfile의 `npm audit` 결과는 알려진 취약점 0건이었다. 런타임은 Node 24의
native TypeScript 실행을 유지하며 `erasableSyntaxOnly`를 적용했다. CI에는 선택적
auth 의존성 설치와 경계 검사를 추가했으나 원격 실행은 하지 않았다.

| 검사 범위 | 확인 결과 |
| --- | --- |
| 로그인 프로토콜 | 실제 code/PKCE 흐름, state·nonce·PKCE 변조·callback 재사용 거부 |
| ID token | 잘못된 서명·issuer·audience·만료 거부 |
| 권한 바인딩 | 서버 issuer/subject 매핑만 actor 선택, 미등록 계정·역할 전환 거부 |
| 세션 | 로그아웃·만료·계정 비활성화·권한 버전/바인딩 변경 후 접근 거부 |
| 일시 장애 | UserInfo 429는 503으로 보류하며 같은 세션의 복구 허용 |
| 신선도 | 최종 인증 검사까지 포함해 30초를 넘긴 컨텍스트 제공 거부 |
| 서명 경계 | SDK prehashed digest를 다시 해시하지 않음, 인증서 불일치·잘못된 framing/UTF-8/중복 필드 거부 |
| 서비스 한계 | socket 0600·부모 0700, 연결 수 제한·부분 요청 timeout 확인 |
| 실행 설정 | 누락·빈 인증 옵션은 가상 역할 모드로 전환하지 않고 시작 실패 |

`npm run auth:smoke`를 실제 OIDC 서버, 별도 서명 child process와 기존 Fabric
네트워크에 실행했다. 근거는 `.data/auth-smoke-TLo2ny/auth-evidence.json`이며 Git 제외다.
게시/승인은 각각 peer VALID block **94/96**에서 확인했다.

- 익명 actor 없음, 비공개 초안 격리, 계정/권한 버전 회수 거부.
- endorsement 뒤 로그아웃하고 submit 직전 재검사에서 차단: 추가 원장 블록 없음.
  해당 outbox 시도는 `cancelled`로 끝나며 복구 조회 대상에서 제외된다.
- 서명 프로세스 정지 시 resolve 503, 새 서명 프로세스 기동 뒤 provided 복구.
- 실제 승인·채택 후 provided, 원장 철회 후 withheld, 로그아웃 후 보호 경로 401.

브라우저 익명 화면에서 로그인 링크만 사용할 수 있고 가상 역할·로그아웃·보호된 편집
영역이 숨겨지는 것을 accessibility snapshot으로 확인했다. CSS가 HTML `hidden`을
덮어쓰던 문제를 수정했다. 화면 JavaScript 구문 검사도 통과했다.

실행 주소는 `http://127.0.0.1:4319`, 시작 명령은 `npm run start:login`이다.
개발 계정은 비밀번호 없는 고정 fixture이며 IdP 상태와 로그인 키는 메모리에만 있다.
같은 OS 사용자의 별도 서명 프로세스는 HSM이나 조직별 강제 격리의 증거가 아니다.
실제 회사 SSO/KMS·독립 조직 배포·운영 백업 및 성능은 후속 단계다.
사용자에게 업체 선택을 개발 선행 조건으로 요구하지 않기로 했으며 자세한 구성은
[개발 로그인 가이드](13-DEVELOPMENT-LOGIN.md)를 참조한다.

## 영속 Fabric projection과 웹 API — 2026-09-15 18:04 KST

현재 소스에서 `npm run check` **87 passed / 0 failed**, `npm run check:types`
**TypeScript 7.0.2 strict 통과**, `npm run demo` 통과. TypeScript와 Node 타입은
root 개발 의존성/lockfile에 고정했으며, Fabric 경계 CI job에 타입 검사를 추가했다.
원격 CI 실행은 아직 하지 않았다.
Fabric/개발 의존성이 없는 별도 복사본도 **67 passed / 0 failed / 20 optional skipped**로
검증해 로컬 실행의 선택적 의존성 경계를 유지했다.

영속 projector는 새 블록의 raw bytes·거래 이력·상태·cursor를 하나의 SQL transaction으로
저장하고 commit 뒤 메모리 상태를 교체한다. SQL 실패 시 rollback, 재시작 replay,
과거 transaction-index 조회, 위조 checkpoint, 최신/과거 캐시 손상, VALID 필터만의
손상, cursor 손상, 기존 이력을 삭제하지 않는 증분 append를 회귀 검사했다.

`npm run fabric:http-smoke`를 실제 테스트 네트워크에 실행했다. 최종 근거는
`.data/fabric-http-smoke-X5cJOF/http-evidence.json`에 있으며 생성 데이터는 Git 제외다.

| 실제 HTTP 검사 | 결과 |
| --- | --- |
| 비공개 초안 | 다른 actor의 preview는 404, 공개 전 원장 events에 본문 canary 없음 |
| 공유 확인 | 확인 없는 publish는 400, 명시적 확인 후 실제 VALID 게시 |
| 권한/승인 | 비대표 승인 403, 승인 전 채택 409, 승인·채택 후 정확한 본문 제공 |
| peer 단절 | Fulfillment peer 실제 정지 시 healthz/resolve 503, peer 기동 후 fresh 제공 복구 |
| 프로세스 재시작 | 새 API 프로세스가 영속 projection을 재생하고 이전 명령의 동일 receipt 반환 |
| run 경계 | 이전 프로세스 manifest는 재사용 거부, 새 fence 후 제공 |
| 철회 | 실제 withdrawal 뒤 새 revalidate는 withheld |
| 요청 기밀 | resolver query canary는 공유 events에 없음 |

최종 게시/승인/채택은 각각 block **69/71/72**, 마지막 웹 체크포인트는 block **77**이다.
현재 chaincode는 logical version 0.1.0 / lifecycle sequence **2**이며, 검증을 유지한
타입 정리 후 각 조직 승인으로 package를 갱신했다. package ID:
`kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157`.

`agent-browser`에서 Fabric 테스트 모드 표시·세 명의 가상 사용자·현재 문서 목록을
확인했다. 스크린샷 명령은 응답하지 않아 작업 소유 명령을 종료하고 격리 브라우저를
닫았다. 스크린샷 검증 성공으로 기록하지 않는다.

서버는 `http://127.0.0.1:4318`에서 실제 peer와 연결된 테스트 모드로 실행한다.
프로덕션 SSO/OIDC·KMS·Fabric CA enrollment, 조직별 독립 배포 및 대규모 원장의
성능 검증은 별도 단계다. 당시 요청했던 SSO/KMS 제공자 선택은 이후 개발 기본 구성으로
진행하기로 정리했다. 최신 로그인 검증은 이 문서 위 항목을 참조한다.

## 실제 Fabric 네트워크 — 2026-09-15 17:02 KST

사용자의 네트워크 및 테스트 인증서 생성·사용 승인 후 macOS arm64의 Colima에서
Fabric 2.5.16 **3 peer + 3 Raft orderer**를 실행했다. 실제 chaincode 컨테이너는
shim 2.5.8 / Node 22.12.0, 클라이언트는 Gateway 1.12.1 / Node 24.18.0이다.
서로 독립된 기관이나 호스트를 사용한 운영 검증은 아니다.

| 실제 실행 항목 | 확인 결과 |
| --- | --- |
| lifecycle | 공식 package/install, 세 조직 approve, definition commit, founder Init VALID |
| 인증 | 인증서의 MSP/actor/kind를 공식 shim으로 확인, 세 조직의 실제 MSP 조회 통과 |
| 지식 합의 | 문서 4개의 게시·제안·대표 승인·채택, 원래 명령 receipt 17개를 peer VALID 블록에서 확인 |
| 인가 실패 | Sales identity의 Settlement agreement 철회 endorsement 거부 |
| outbox 복구 | 제출 후 child process 종료 및 새 SDK client로 복구, 제출 응답 유실 주입 후 committed idempotency 복구 |
| 실제 MVCC | 같은 명령을 미리 endorsement한 두 거래 중 하나 VALID, 하나 INVALID code 11; 원래 명령 결과로 조정 |
| 같은 블록의 철회 | **block 46 index 0 fence / index 1 dependency withdrawal**, 모두 VALID; epoch 4→5 |
| resolver | 공유 Markdown 원문 확인, 철회 전 provided → 철회 후 withheld (`DEPENDENCY_INELIGIBLE:NO_ACTIVE_AGREEMENT`) |
| 복제와 재생 | 세 peer height 47 및 tip hash 일치, peer에서 받은 block 0–46을 새 reader로 재생해 같은 hash·결과 확인 |
| 배포 재개 | `npm run fabric:deploy` 재실행 성공, 추가 블록 0개 |

마지막 검증 블록의 Fabric header hash:
`1d5651055fd6b6e0544d954377094ff0e17e9f07edaef93a250ebd0d9603fa8e`.
로컬 근거는 `.data/fabric-smoke/evidence.json`, `replication.json`, `blocks/0.pb`–`46.pb`다.
생성 identities, 원본 블록 및 runtime DB는 Git에 넣지 않았다.

실행 중 발견한 문제를 수정한 뒤 재개했다. 테스트 enrollment 인증서의
`clientAuth` 전용 EKU를 제거해 [공식 cryptogen의 서명 인증서 용도](https://github.com/hyperledger/fabric/blob/v2.5.16/internal/cryptogen/msp/msp.go)에 맞췄다.
배포 재개는 실제 osnadmin/peer 응답으로 기존 channel·definition·package·초기화 상태를 검사한다.
블록 reader는 [Fabric의 InitializedKeyName](https://github.com/hyperledger/fabric/blob/v2.5.16/core/chaincode/chaincode_support.go)을 일반 JSON과 구분하고,
고정 chaincode version과 같은 거래의 pinned bootstrap이 있는 경우만 수용한다.
이 오류는 합성 회귀 테스트에서 먼저 실패를 확인한 뒤 실제 peer 블록으로 재검증했다.

이 단계의 `npm run check`: **70 passed, 0 failed**. `npm run demo`도 통과했다.
TLS는 실제 사용했지만 Fabric CA enrollment, 운영 SSO/KMS, 영속 projector·HTTP
Fabric mode, 독립 조직/호스트의 CFT/BFT 장애 내성·성능, 원격 CI와 정적 타입 검사는
여전히 미검증 또는 미구현이다. 응답 유실은 클라이언트 경계의 주입이며 실제 네트워크
partition 시험으로 해석하지 않는다.

## Fabric 통합 준비 — 2026-09-15

환경: macOS arm64, Node 24.18.0, npm 11.16.0, 실행 중인 Colima Docker.
기존 로그인 셸의 Node 22.20.0은 도구 사전 검사에서 거부하며, 설치된 Node 24를
명시적으로 PATH에 넣어 실행했다.

- `packages/fabric`의 공식 SDK/shim과 전이 의존성을 설치했다. Gateway 1.12.1,
  shim 2.5.8, gRPC 1.14.4, Fabric protos 0.3.7을 고정했다.
- adapter와 chaincode의 lockfile을 생성·검토했다. 양쪽 `npm audit`는 알려진
  취약점 0건을 보고했다. npm 패키지 라이선스는 MIT, Apache-2.0, BSD, ISC,
  Unlicense 계열로 기록됐다. 정적 타입 검사는 아직 실행하지 않았다.
- 공식 Fabric 2.5.16 macOS arm64 도구와 Compose 5.5.1을 다운로드하고
  GitHub release asset SHA-256을 검증했다. peer/orderer/nodeenv 이미지를
  digest로 고정했다. 실제 컨테이너의 peer 버전은 2.5.16, nodeenv는 Node 22.12.0이다.
- `node infra/fabric/build.mjs`, 생성 패키지 `npm ci`, 공식
  `peer lifecycle chaincode package`를 실행했다. `metadata.json`/`code.tar.gz`,
  package lock 포함 및 인증서·node_modules 미포함을 확인했다.
- 공식 shim의 `getArgs()`는 문자열이며 잘못된 UTF-8 바이트를 치환한다.
  원본 `getBufferArgs()`를 사용하도록 수정하고 실제 공식 stub으로 잘못된
  UTF-8 입력 거부를 검증했다.
- 공식 Gateway SDK와 loopback gRPC 서버를 사용해 응답 없는 commit-status
  조회를 재현했다. 제한 시간 추가 후 DEADLINE_EXCEEDED와 재조회 VALID를
  확인했다. 이는 실제 Fabric peer 커밋의 증거는 아니다.
- 세 peer·3-orderer Raft의 공개 설정을 생성하고 Compose 구문과 도구 사전
  검사를 통과했다. 기존 로컬 데모도 `withheld → provided → withheld`를 유지했다.
- 최종 `npm run check`: **69 passed, 0 failed, 0 skipped**. 별도 의존성 없는
  소스 복사본에서는 **56 passed, 0 failed, 13 skipped**로 기존 로컬 검사를 유지했다.
  선택적 공식 SDK/protobuf 검사만 패키지 부재로 건너뛴다.
- full-block reader의 합성 protobuf 검사는 실제 도메인 엔진 write-set으로
  동일 블록 fence·철회 후 withheld, INVALID·미검증 filter, genesis/lifecycle,
  원자적 상태 보존을 확인했다. 헤더 해시는 OpenSSL ASN.1 생성 결과와
  7/128/256/65536/최대 안전 정수 블록 번호에서 비교했다.

### 통합 준비 당시의 승인 경계

사용자가 의존성·도구·이미지 다운로드를 포함한 네트워크 접근을 승인했다.
준비 단계에서는 별도 전역 지침에 따라 테스트 CA/MSP/TLS 인증서 승인을 요청했고,
당시 실제 네트워크는 실행하지 않았다. 이후 승인·실행 결과는 이 문서 맨 위에 기록했다.
시나리오와 도구 pin은 [Fabric 통합 가이드](../infra/fabric/README.md)를 참조한다.

추가 CI job은 공식 의존성 설치 후 Fabric 경계 테스트를 실행하도록 작성했다.
원격 CI·운영 인증·조직별 독립 장애 시험은 미실행이다.

## v0.1 런타임 — 2026-09-15

환경: macOS arm64, Node.js 26.5.0, npm 11.17.0, Python 3.14.7. 로컬 런타임은 새 외부 패키지 없이 실행했다.

```sh
npm run check
npm run demo
node --check apps/web/app.js
node infra/fabric/build.mjs
node --check infra/fabric/dist/entrypoint.mjs
sh -n infra/fabric/package-chaincode.sh
git diff --check
```

**자동 테스트 56개 통과, 실패 0개.**

| 검사 | 수 | 확인 범위 |
|---|---:|---|
| 도메인 엔진 | 18 | 전체 본문 해시, 입력 한계, 대표자/제안/역할 바인딩, old approval 거부, 이의·기권·철회, 재승인, dependency·CAS |
| HTTP/JSON | 11 | 3개 도메인 공존, 비공개 초안 격리, 공개 확인, CSRF/출처, 멱등 원본 receipt, 실제 승인 manifest, 재시작 |
| 로컬 저장소 | 7 | 원자적 실패, 동시 명령 직렬화, 시점 조회, 재생, 알려지지 않은/잘못된 write set 거부, 파생 view 불일치 검출 |
| 계약 호환 | 2 | 기존 계약 예제를 런타임 검사기로 검증, 실제 생성 manifest를 제한된 설계 schema checker로 확인 |
| MVCC 모델 | 3 | activation/object 선후 경합, object 재시도 후 정지, 동일 slot의 경쟁 채택 |
| Fabric 경계/패키지 | 15 | 실제 공통 엔진+주입한 shim, SDK 생명주기, VALID/ACK 구분, 재시작 outbox, 결과 디코딩, 독립 실행 패키지 구조 |

CLI 데모 결과는 `withheld → 두 부서 승인 후 provided → 의존성 철회 후 withheld`다. 전체 본문이 공유 journal에 실제 들어갔는지도 검사한다.

`agent-browser`로 문서 열람, 물류·정산 승인, 채택, resolver 제공, 비공개 초안 저장, 공개 미리보기, 새 개정 게시와 fresh proposal을 조작했다. 마지막 UI 변경 뒤 범위 자동 선택, 새 문서/개정 구분, 역할 변경 시 비공개 편집 화면 초기화, 미승인 문서 withheld를 추가 확인했다. 화면 JavaScript 구문 검사는 통과했다.

캡처 기능은 `agent-browser` daemon 오류 후 별도의 격리된 Chrome/CDP로 확인했다. 데스크톱 1440×1200, 모바일 device viewport 390×844에서 문서 4개가 로딩됐고 모바일 `innerWidth = scrollWidth = 390`이었다. 스크린샷은 로컬 `.artifacts/knowledger-verified-desktop.png`, `.artifacts/knowledger-verified-mobile.png`에 보관하며 Git에는 넣지 않았다. 열람 상태와 fresh fence 기반 실행 권한을 화면 문구에서도 구분했다.

독립 코드 검토에서 발견한 최신 승인 포인터의 representative mismatch, manifest 승인 바인딩, 중복 명령의 원래 checkpoint, projection 불일치, revision ID 참조 문제를 보강했다. 원장 입력 구조뿐 아니라 상태 간 참조를 검사하고, 로컬 browse도 하나의 checkpoint에서 읽는다.

### 실행하지 않은 항목

- 실제 Fabric peer/orderer/CA 네트워크, peer lifecycle 패키징, 실제 MSP 서명·endorsement·네트워크 장애 주입. Go/peer CLI가 없고 Docker 엔진은 정지 상태였다. 의존성 다운로드 승인 요청에 답변이 없어 설치/이미지 다운로드를 진행하지 않았다.
- 공식 SDK/shim npm 패키지 실행, 전이 의존성 lockfile·감사, TypeScript 정적 타입 검사. SDK 인터페이스를 주입한 테스트와 빌드 검증은 실제 SDK 실행의 대체 증거가 아니다.
- Fabric full-block 해독·VALID write-set projector, 동일 블록 안 여러 거래 fence, 독립 3-orderer CFT/4-orderer BFT 시험. 로컬 원장은 블록당 거래 한 개다.
- 실제 SSO, 사용자 개별 서명, 조직별 vault/KMS, 외부 모델/embedding/KB adapter, PostgreSQL/pgvector, 성능 벤치마크.
- GitHub Actions 원격 실행. workflow는 저장소에 준비했지만 원격 저장소에 게시하지 않았다.

따라서 P0–P3의 전체 운영 완료로 표시하지 않는다. [현재 실행 범위](11-RUNTIME.md)와 [Fabric 통합 경로](../infra/fabric/README.md)를 참조한다.

## 초기 설계 검증 기록

검증일: 2026-09-15. 환경: Python 3.14.7, 표준 라이브러리만 사용. 새 패키지를 설치하지 않았다.

## 확인한 범위

첫 설계 커밋 시점에는 문서, JSON payload 계약, 예제 및 검사 도구만 존재했다. 아래는 그 당시 설계 검증의 범위다. 이후 런타임 검증은 위에 별도로 기록했다.

## 실행 결과

프로젝트 루트에서 실행:

```sh
python3 -B tools/validate_design.py
python3 -B tools/check_docs.py
```

- JSON 계약 4종, 예제 14개, 전체 본문을 묶은 revision digest 4개 검사 통과.
- 기대한 오류 예제 6개 거부: 본문 변경 후 옛 digest, 존재하지 않는 revision을 참조하는 결정, proposal_id 없는 결정, 문서 dependency 안 runtime agreement ID, agreement ID 없는 normative reference, agreement ID를 가진 일반 reference.
- 지정 대표 두 명이 같은 proposal/revision/SlotKey/policy를 승인하고 manifest가 그 결정들을 가리키는지 fixture 일관성 확인.
- private source 예제는 비어 있거나 공개가 허용된 불투명 assertion이며 실제 secret은 없다.
- Markdown 로컬 링크와 코드 fence 짝, Python AST 구문 검사 통과. Mermaid 코드 블록 4개.
- 현재 최종 schema/checker에 대해 임시 복사본에서 추가 변형 5개를 적용해 거부 확인: object를 approve처럼 집계, tx index 누락, 다른 조직 actor, normative agreement 누락, JSON 중복 key. 원래 예제는 변경하지 않았다.

## 독립 검토

아키텍처 검토와 별도 correctness/security 문서 검토를 수행했다. 발견된 다음 항목을 수정하고 제한된 재검토에서 미해결 blocker가 없음을 확인했다.

1. 공유 channel의 과거 본문 소급 노출: v1 membership 고정, 새 그룹은 새 channel과 명시적 재공개.
2. active 이후 필수 대표 object/retract: 같은 거래에서 suspend + epoch 증가.
3. 여러 역할 보유자의 집계: role별 한 명의 지정 대표와 불변 binding snapshot.
4. projector 완전성: VALID full transaction write-set replay, unknown input에서 cursor 중단.
5. action 전 전체 재인가: SSO/private source/model egress/tool 권한 + fresh fence.
6. timeout 후 다중 tx: durable command outbox와 committed idempotency state로 집계.
7. context/scope 모호성: SlotKey 다섯 필드와 v1 single-scope revision.
8. 검토 간 승인 replay: immutable proposal_id와 재승인 시 새 proposal.
9. 불변 문서와 runtime agreement ID 분리.
10. manifest normative/reference 구분을 schema oneOf로 강제.

## 보증하지 않는 것

검사기는 이 폴더가 사용하는 JSON Schema keyword와 좁은 JCS 입력 부분집합을 확인한다. 범용 Draft 2020-12 또는 RFC 8785 구현으로 배포할 수 있는 라이브러리가 아니다. 실제 identity·서명·인가·active ledger 상태·합의/분산 장애·서버 최신성·성능은 확인하지 않았다.

Mermaid는 fence 구조만 확인했다. `mmdc`가 설치되어 있지 않아 실제 렌더링은 수행하지 않았다. Mermaid CLI를 사용하는 환경에서는 예를 들어 `mmdc -i README.md -o /tmp/knowledger-readme.md`로 Markdown 내 다이어그램을 렌더링해 확인할 수 있다.

최종 운영 완료 기준은 [구현 계획](07-DELIVERY-PLAN.md)의 P-01–P-17, S-01–S-07, R-01–R-13 및 CFT/BFT·복구 실험이다. 위의 런타임 테스트와 실제 네트워크 시험을 구분한다. 성능 수치는 설계 가설이며 benchmark 결과가 아니다.
