# Handoff

_Last updated: 2026-09-20 KST (Fabric 파일럿 측정 지원 v0.4.0 후보 — PR·원격 CI·게시 진행)_

## Goal

MIT 지식 합의 원장을 오픈소스로 공개한다. **제품 이름은 Knowledger로 확정**했다(기존 `knowledge-consensus-ledger`/`kcl`에서 리네임).
조직·업무는 설정으로 정하며 영업·이행·정산은 선택형 예제다.
합의한 코드 작업·Claude 리뷰 수정·조회 최적화·테스트 인증서 갱신·제품 리네임·공개 게시·
대규모 확장성 수정·성능 도구 개선은 완료했다. 다음 방향은 **오픈소스 성장**으로 합의했고
첫 작업으로 **v0.2.0 릴리스를 게시했다**(CHANGELOG.md·ROADMAP.md 신규, PR #5 `16c06f6`).
확장 계획은 [로드맵](ROADMAP.md)의 4개 트랙에 기록했다.
상시 규칙은 [AGENTS.md](AGENTS.md), 상세 이력은 [검증 기록](docs/VALIDATION.md)에 둔다.

## Current Status

- **v0.4.0 릴리스 후보**: `release/v0.4.0`에서 Fabric 파일럿 측정 기능
  `d491d81`을 원격 PR·CI·릴리스로 반영한다. 제품 패키지·lockfile·README·changelog를
  0.4.0으로 맞추고 배포된 chaincode0.1.0·기존 키·genesis는 유지한다.
- **Fabric 파일럿 측정 지원 로컬 완료**: `pilot:metrics --mode fabric`으로 정지된
  projection의 원시 full block을 읽기 전용·단일 스냅샷에서 재검증하고 VALID 거래만
  집계한다. channel/chaincode/version/public genesis를 명시하며, source 전체 tip·
  원시 저널 digest·정확한 VALID 거래 checkpoint를 출력한다. 기존 로컬 schema1과
  무설치 경로를 유지했다. 테스트504개 중503 통과·1 GC 생략, 타입·데모·선택
  의존성 없는 로컬 측정11개 통과. 기존 실제 Fabric 스냅샷 사본에서도331블록·
  VALID332/INVALID2를 측정했고 원본·사본 DB 해시를 보존했다. 해당 기능을 v0.4.0으로
  게시 준비 중이다. 사용법은 [파일럿 안내](docs/28-ADOPTION-PILOT.md).
- **[v0.3.0 릴리스 게시 완료](https://github.com/ictechgy/knowledger/releases/tag/v0.3.0)**:
  [PR #14](https://github.com/ictechgy/knowledger/pull/14)를 main에 merge commit
  `bdb55fb`로 반영하고 같은 커밋에 태그·GitHub Latest 릴리스를 게시했다.
  제품 패키지와
  README·changelog를 0.3.0으로 갱신하고, 설정형 smoke의 조직 서명·감사 로그·
  모델 egress 설정을 현재 계약에 맞췄다. 실제 `fabric:http-smoke`와
  `configured:smoke`가 통과했다. head `87c06ad`의 원격 CI8개와 Chromium18개가
  통과했다([PR CI](https://github.com/ictechgy/knowledger/actions/runs/35486928102)).
- **잔여 로드맵 main 반영 완료(2026-09-20, PR #14)**: B8 대형 캐시를 일반/대형 풀별
  최대8개 LRU로 확장했다. 대형 풀 합산 예산은 기존 브라우즈 추정16MiB·검색
  UTF-8 64MiB를 유지한다. Fabric durable ingest는 `prepareBlock`의 검증된
  쓰기 delta를 SQL 성공 뒤 커밋해 블록마다 전체 상태 Map을 복사하지 않는다.
  Track D는 [릴리스·의존성 정책](docs/29-PROJECT-OPERATIONS.md)으로 구체화했고,
  실제 파일럿의 계획/결과·빈 관찰 로그 템플릿을 추가했다. 공개 인증서81개가
  모두 정상이다. 실제 파일럿·독립 물리 호스트 장애 시험은 수행하지 않았다.
  대상 조직·환경·사람 검토자가 정해져야 실제 파일럿을 시작한다.
- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`(로컬 체크아웃 경로는 그대로), 공개 이름은 `knowledger`.
  **공개 완료: https://github.com/ictechgy/knowledger — 리네임 커밋 `ad3693b`, 태그·릴리스 `v0.1.0`·`v0.2.0`·`v0.3.0`.**
  이전 조회 최적화 `5173527`, 실제 Fabric 장애 검증 `de3e953`, 리뷰 수정 `90bdcda`.
  **PR #2 머지 완료(squash `1249f1e`)**: 10만 문서 확장성 — 브라우즈/검색 페이지네이션과
  블록 인제스트의 O(N²) 제거, `tools/performance-fabric.ts` 합성 Fabric 어댑터 벤치마크.
  문서 커밋 포함 최신 상태는 `git log -1 --oneline`과 `git status --short`로 확인한다.
- `f3fd4a2` — **PR #6 조직 signing gateway 머지 완료(rebase, 27커밋)**.
  원격 서명 서비스(Unix 소켓·조직 바인딩 키·attestation 영수증·JSONL 감사 로그)와
  게이트웨이 측 소비형 attestation 슬롯·직렬화·builder 출력 검증을 도입했다.
  20라운드 독립 리뷰(claude·codex·grok·agy)의 유효 findings를 모두 해소했고,
  잔여 반복 지적은 문서화된 설계 경계다(caller-asserted 증거·동일 UID 신뢰 경계·
  close drain 계약 — `infra/fabric/README.md` 참조).
  성능 도구 개선 PR #3(`b073c81`)·정리 PR #4(`e636166`)·v0.2.0 릴리스 PR #5(`16c06f6`)도 포함됐다.
  `infra/fabric`의 `knowledger-chaincode` 0.1.0은 배포된 `kcl_0.1.0` 계약이라 범프하지 않았다.
  사용자 `.serena/`와 `scorpionfish/`는 보존·커밋 제외.
- **로드맵 PR 스택 진행**: PR #7 `feature/sso-adapter`(A2 SSO 어댑터 경계)·
  PR #8 `feature/vector-search`(A3 벡터 검색 read model)·PR #9 `feature/model-egress`
  (A4 `modelEgress` 서버 정책 게이트)는 **머지 완료**. **PR #12 `fix/graceful-close`→main도
  머지 완료(squash `d39a9b1`)** — 공유 HTTP 종료 상태 기계(`packages/http/graceful-close.ts`):
  유휴 keep-alive 즉시·주기 스윕, 마감 후 강제 해제, close 콜백 미도착 시 bounded 마감,
  강제·마감·늦은 도착의 인과 순서 진단, 총 대기 `deadlineMs+settleMs+REMAINING_LOOKUP_MS`
  상한, 귀결 시 모든 타이머 해제, app.close 단계별 독립 해제(단일 실패는 stage를 단
  원오류, 복수는 stages를 단 AggregateError), 기동 시 합산 검증. 약 30라운드 독립
  리뷰로 수렴했다. **PR #10 `feature/ops-drills`→main도 머지 완료(squash `e42122e`)** —
  Track B 운영 드릴 CI: `test:backup`은 오프라인 스냅샷·복원 동등성과 가드레일
  (WAL 거부는 일회용 사본에서 검증, `overlapping_paths`·`destination_exists`)을,
  `test:drill:multi-host`는 태그별 in-flight 프로토콜(begin/commit/failed)로 실제
  쓰기 중 SIGKILL을 입증하고 메인 DB 단독 통제군으로 WAL 리플레이를 증명한다.
  peer 격리·복원 비교는 전체 페이지네이션 저널·초안 레코드 다이제스트다.
  5라운드 독립 리뷰(codex×2 APPROVE)로 수렴했다. **PR #13
  `feature/track-c-v2`→main도 머지 완료(squash `4aad9ea`)** — CLOSED된 PR #11의
  Track C 커밋 `919eaff`를 새 main에 cherry-pick해 재생성한 PR이다. Track C:
  `readGitSource` 고정 커밋 Git 커넥터(SHA-1/SHA-256 저장소, heads/tags·전체
  object ID만 허용하는 비모호 ref 해석, 환경 격리·리터럴 pathspec·엄격
  `ls-tree -z` 파싱, 스냅샷+재검증 ref 변경 탐지), `adoption-metrics` 파일럿
  측정(read-only 저널 검증, 디스크립터 기반 관찰 입력, 엄격 RFC 3339 타임스탬프,
  window/evidence 신원 필드), 공유 `tools/artifact.ts` 원자 아티팩트 쓰기
  (inode 고정 디렉터리, bigint 신원 비교, 게시 전후 재검증, 자기 inode만 정리).
  22라운드 독립 리뷰(codex×2, 최종 APPROVE×2)로 수렴했다.
  리뷰 프로바이더 상태: claude 주간 쿼터 소진(9/21 12:00 KST 리셋), codex 정상,
  agy 미로그인, grok은 장문 diff 리뷰에서 오독 사례가 있어 보조 트랙으로만 신뢰한다.
- **마지막 실제 네트워크 실행 검증: 2026-09-20 KST.** 중지돼 있던 기존 Colima VM·
  컨테이너를 재가동하고 격리 앱에서 HTTP·configured smoke를 순서대로 통과시켰다.
  peer 중단503→복구, VALID 게시·승인·철회, 원래 receipt·OIDC·attestation 감사·
  모델 egress 허용/거절·v3 snapshot 복원을 확인했다. 기존4317/4318/4319/4321/
  4331/4341 앱은 시작 시 모두 중지 상태였으며 이번에 상시 앱을 기동하지 않았다.
  상세 [검증 기록](docs/VALIDATION.md).
- 실제 장애 시험 완료: peer 중단 503→복구(`fabric:http-smoke`), orderer1 중지 중 게시6건 커밋·
  재기동 추월·복구 후 block288, 인증서 적용 중 실제 SIGKILL 후 같은 plan 재개, `.data/fabric-login`
  백업→새 폴더 복원→기동 확인. 2026-09-20 검증 후 세 peer의 원장 tip은
  모두 block331(height332)이며 시험 합의는 철회됐다.
- Colima context `colima`, Compose project `kcl-fabric-smoke`:3 peer·3 Raft orderer running.
  chaincode0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지.
- User1 인증서3개는 2026-09-16에 재갱신해 **2027-01-14T14:41:57Z 만료**다(plan
  `certificate-renewals/renewal-20260916144157-3acf8bfc46847974`). CA·peer/orderer 인증서는2036년까지 유효하다.

## Completed

- 설정 기반 제품/예제 분리, 결정적 공통 엔진, Fabric VALID full-block projection·outbox,
  OIDC 현재 인가·별도 signer·조직별 격리, Markdown private source, SDK/생성 결과 반환 전 재검증, v3 snapshot 복원.
- Claude 디자인·성능/보안/구조/사용성 리뷰와 R1–R6 수정 완료: [리뷰](docs/25-CLAUDE-REVIEW.md).
  요약 페이지, health 요청 제한, 원장 대기와 private 작업 분리, 과거 snapshot/블록 캐시 상한을 적용했다.
- [조회 인덱스](docs/26-BROWSE-INDEX.md): 검증된 compact 참조로 페이지를 고르고 선택된 canonical 값만 읽는다.
  1,000개1KiB·5회 전체 페이지 p95 목록1,071→177ms, 검색995→210ms. workload별 측정이며 운영 SLA가 아니다.
- [인증서 유지보수](docs/27-TEST-CERTIFICATES.md): 공개 점검/기존 키 기반90일 갱신 준비·적용,
  전체 사전 검증·원자적 파일 교체·롤백·부분 재개. signer는 요청 전과 반환 전 만료를 검사한다.
  실제 cert3개만 교체, 모든 공개키 및 대상 외130개 파일·genesis 보존. 관련 앱5개와 signer를 재시작했다.
- 운영 상태 대시보드(`e69a228`): `GET /v1/workspaces/:id/operations`가 검증된 체크포인트,
  readiness 표본, peer tip 대비 projection 지연, 처리 중 명령, 복구 대기 outbox, 최근 원장
  이벤트 메타데이터를 반환한다. 장애 중에도 부분 스냅샷을 반환한다. 웹 UI에 운영 상태 탭 추가.
- 대규모 읽기 최적화(`f4113a1`, `7e6b46a`): `ApplicationLedger.readMany` 배치 읽기와
  요청 범위 체크포인트 캐시·단계별 prefetch로 페이지/검색 스캔의 키당 이중 SQL 왕복을 제거.
  LocalLedger는 준비된 문장·중복 저널 검증 제거·불변 키 대조 한정으로 재생을 줄였다.
  10,000개1KiB 전체 순회 기준 검색2,307→628ms, 목록1,951→716ms, 재생3,318→1,885ms.
  무결성 교차 검증·체크포인트 단언·JS substring 의미는 유지한다. 측정 근거는
  [검증 기록](docs/VALIDATION.md) 최신 항목.
- 10만 문서 확장성(PR #2, squash `1249f1e`): 100k 측정에서 발견한 O(N²) 세 곳을 수정했다.
  브라우즈 개정본 캐시·검색 매치 캐시는 상한 초과 결과를 하드 바이트 상한(16MiB/64MiB) 아래
  단일 대형 항목으로 유지해 오프셋 페이지네이션의 전체 재필터/재스캔을 없앴고,
  `VerifiedBrowseIndex`는 쓰기 델타 커밋으로 커밋당 비용을 평탄화했으며, 블록 프로젝터의
  `fork()`는 얕은 복사다. 결과 local 100k overview 9.2s·search 11.4s·재생21.3s,
  fabric-adapter 합성 재생 search 11.0s·overview 12.6s. 비순차 커밋 강등·캐시 무효화·
  대형 상한은 회귀 테스트로 고정했다. 상세 수치와 알려진 한계는 [검증 기록](docs/VALIDATION.md).
- `tools/performance-fabric.ts`: 로컬 저널 이벤트를 실제 해시 체인의 합성 블록으로 변환해
  `SqliteFabricProjection.applyBlock`→`FabricApplicationLedger`로 동일 읽기 workload를 측정한다.
  `--journal`은 단일 읽기 트랜잭션 스냅샷에서 검증·재생한다. 네트워크 커밋 증명이 아니다.
- 제품 리네임 `knowledger`: 패키지명·`knowledger.config.json` 기본값·`@knowledger/*` 범위·`Knowledger*` 클래스·
  `X-KNOWLEDGER-CSRF`·OIDC 쿠키/client_id·`KNOWLEDGER_SNAPSHOT_*` env·스키마 `$id`·테스트 접두사·문서 표기.
  실행 중인 배포 계약은 `kcl` 그대로 유지한다 — `kcl:` 원장 state 키, `kcl.actor_*` 인증서 속성,
  `kcl.test-certificate-renewal` plan 스키마, fixture 이름(channel `kcl-demo`, chaincode `kcl`/`kcl_0.1.0`,
  compose `kcl-fabric-smoke`, 도메인 `*.kcl.test`). 경계 규칙은 [AGENTS.md](AGENTS.md)에 있다.

## Key Files & State

- `.github/workflows/ci.yml`: local Node24/26, Fabric/auth/API·타입 검사, Chromium·성능/복구 jobs. 원격 실행 전 대상.
- `infra/fabric/certificates.ts`, `examples/order-workflow/client-certificates.ts`: 갱신 core와 고정 예제 CLI.
  최신 적용 plan: `.data/fabric-smoke/certificate-renewals/renewal-20260916144157-3acf8bfc46847974/plan.json`.
- `packages/storage/browse-index.ts`, `apps/api/service.ts`: 조회 인덱스 및 canonical 대조·페이지 계약.
  `apps/api/search-matches.ts`는 검색 매치 스냅샷 캐시(일반/대형 풀별 최대8개,
  합산 바이트 예산, 상한 생성자 주입 가능).
- `docs/29-PROJECT-OPERATIONS.md`: Track D 릴리스·의존성 운영 기준.
  `examples/pilot/PLAN.template.md`·`observations.template.json`: 실제 파일럿 준비 입력.
- `tools/adoption-metrics.ts`, `packages/measurement/fabric-adoption.ts`: 로컬/Fabric
  파일럿 측정 CLI와 Fabric 읽기 전용 경로. `packages/fabric/journal-verification.ts`는
  durable replay·측정이 공유하는 바인딩/블록 대조다. `test/fabric/adoption.test.ts`에 회귀 검사.
- `tools/performance-smoke.ts`(로컬 workload, `--slot-groups`·100k 상한)와
  `tools/performance-fabric.ts`(합성 블록→실제 projector·adapter 재생, `--journal` 재사용)가
  성능 측정 도구다. 결과는 `.artifacts/`에 JSON으로 남는다.
- 보존할 local 설정/데이터: Git 제외 `knowledger.config.json`, `.data/workspaces/knowledge/local`.
  예제 데이터: `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement`.
- 네트워크: `.data/fabric-smoke/compose.json`, 같은 폴더의 `crypto/`·`channel.block`.
  Compose CLI `.tools/docker-compose`; Docker는 `/opt/homebrew/bin/docker`다.

## Verification

2026-09-20 Fabric 파일럿 측정 후속 변경(로컬 검증):

- `npm run check` **504 tests / 503 passed / 0 failed / 1 GC skipped**.
  `npm run check:types`, `npm run demo` 통과. Fabric 집중10개, 무선택 의존성 로컬11개 통과.
- 기존 오프라인 snapshot 사본:331블록·VALID332/INVALID2, 합의 시간30표본.
  원본·측정 사본의 DB SHA-256 불변. 지표는 이전 가상 검증 이력의 측정값이며 실제 도입 결과가 아니다.
- 근거 `.artifacts/fabric-pilot-20260920/`. 원격 CI·새 네트워크 검증은 실행하지 않았다.
  검증 범위·명령·세부 지표는 [검증 기록](docs/VALIDATION.md)에 있다.

2026-09-20 v0.3.0 릴리스 검증:

- 실제 HTTP smoke 게시290·승인292·활성293·철회297·최종299 통과.
- 실제 configured smoke 게시316·승인318·활성319·철회328·최종331 통과.
  미증명 서명 거절, attestation 감사463개, 미승인 모델 generate0회,
  OIDC 권한 회수·SDK 철회 차단·v3 복원 확인. 첫 실행의 감사 phase 단언 오류는
  수정 후 재실행했다. 두 실행 모두 시험 합의 철회 완료.
- `npm run check` 493개 중492 통과·1 GC 생략. 타입·demo·demo:kb·백업/장애 드릴 통과.
  로컬 Chromium 바이너리는 없으며, 정확한 PR head의 원격 CI에서 Chromium18개
  통과를 확인했다. push/PR의 Node24·26, Fabric 경계, browser/experiments 전부 성공.
- genesis digest와 crypto132개 파일의 크기·mtime·inode 보존. 근거는
  `.artifacts/release-v0.3.0/`, `.data/fabric-http-smoke-6yDcmN/http-evidence.json`,
  `.data/configured-smoke-XaPSPf/evidence.json`.

2026-09-20 잔여 로드맵의 최초 로컬 변경 시점 검증(이후 릴리스 검증은 위 항목):

- `npm run check`: **493 tests / 492 passed / 0 failed / 1 GC 전용 skipped**.
  `npm run check:types`, `npm run demo` 통과.
- 대형 캐시 LRU·합산 바이트/개수 예산·교대 체크포인트·무효화, 블록 준비/폐기·
  결과 변조 격리·중복/stale commit 거절, SQL 실패 후 재시도·재시작을 검사했다.
- 기준 `76e71d4`와 수정본의 순차 합성 Fabric 측정(2,000문서·128B·1tx/block·
  1표본): 2,015블록 ingest 1,153.65→848.47ms. 생성·조회·검색·재시작 후
  개수 전부 일치. 실제 Fabric 네트워크나 운영 SLA 검증이 아니다.
- 공개 인증서81개 `ok`, User1 세 개 만료 `2027-01-14T14:41:57Z` 재확인.
  파일럿 관찰 템플릿 2개를 실제 파서로 검증했다.
- 근거 `.artifacts/remaining-roadmap-20260920/`, 상세 [검증 기록](docs/VALIDATION.md).
  이번 코드의 원격 CI·실망 smoke·브라우저 검사는 실행하지 않았다.

2026-09-20 Track C(PR #13, squash `4aad9ea`) 머지 시점 검증 근거:

- `npm run check`: **489 tests / 488 passed / 0 failed / 1 GC 전용 skipped**. `npm run check:types` 통과.
- 집중 테스트: `test/connectors/git-repository.test.ts`·`test/measurement/adoption.test.ts` 전부 통과.
- 드릴 재검증: `tools/backup-rehearsal.ts` `rehearsal_pass: true`, `tools/multi-host-drill.ts` `drill_pass: true`.
- `tools/adoption-metrics.ts` e2e: 시드 저널+예제 관찰 로그로 `--out` 아티팩트(mode 0600)·측정 필드 확인.
- `python3 -B tools/check_docs.py` 오류 없음(markdown 80·링크 373·mermaid 11).
- PR #13 원격 CI 전 통과(head `d5ec1c8`): local-runtime Node24·26, fabric-boundaries, browser-and-experiments.
- 리뷰 루프 총 22라운드(codex×2 — claude 주간 쿼터 소진 기간)로 수렴, 최종 라운드 APPROVE×2·빈 findings.

2026-09-18 성능 도구 개선 — 리뷰·보완 후 재검증 근거(`feature/perf-baseline-compare` 브랜치):

- 1차 자체 리뷰에서 확인한 초안 결함과 수정:
  - `search_cold`가 samples>1에서 실제로 cold가 아니었다 — 매치 캐시는 서비스 인스턴스별이라
    샘플 1만 cache-miss였다. 샘플마다 새 `KnowledgerService`를 만들도록 수정했다
    (열린 원장 재사용, `initialize()`는 tail 확인뿐이라 저널 재생 없음).
  - `assertSearchQueryMatches`의 미사용 `documents` 파라미터를 제거하고 `measureSearchQueryMatches`로
    이름을 바로잡았다. `cold_search_matches`는 tautology 대신 실측 마지막 건수를 기록한다.
  - 두 도구에 중복돼 있던 `compareWithBaseline`을 `perf-compare.ts`의 `compareMetrics`로 합쳤다.
  - baseline 호환성·검증 오류를 `ComparisonInputError`로 바꿔 CLI가 부적절한 일반 안내를 붙이지 않게 했다.
  - `parseThresholds`가 도구별 측정 메트릭 목록을 받아 미측정 메트릭·중복 키를 거절한다.
    `--threshold` 단독 사용은 `--baseline` 요구 오류로 거절한다. baseline=0이면 `+Infinity%` 대신
    명시 문구를 출력한다.
  - dead export `RegressionThresholds`·`validateThreshold`를 제거했다.
- 커밋·푸시 후 ultra-review 1라운드(claude 트랙 2/2 유효, codex·grok·대부분의 agy 샤드는
  러너 권한/타임아웃으로 무효)에서 추가로 확인한 결함과 수정:
  - **HIGH**: `measureSearchQueryMatches`가 10개 질의를 상한 있는 매치 캐시에 채워 marker
    엔트리를 축출한 뒤 `search_warm` 루프가 시작돼, 첫 warm 샘플이 실제로는 cache-miss였다.
    warm 루프를 복수 검색어 측정보다 앞으로 옮겨 모든 샘플이 cache-hit를 타게 했다.
  - baseline 로드·스키마·environment 검증이 전체 측정 뒤에 실행되던 것을
    `loadValidatedBaseline`로 측정 전 fail-fast로 옮기고, `reportCliResult` 공유 헬퍼가
    비교 오류 시에도 측정 결과를 --out/stdout에 먼저 보존한 뒤 오류를 보고한다.
  - CLI 비교 글루가 두 도구에 중복돼 있던 것을 `reportCliResult`로 통합하고, 임계값
    `--baseline` 요구 검사를 `parseThresholds` 앞으로 옮겨 실제 원인이 먼저 보고되게 했다.
  - baseline=0일 때 `entries[].ratio`가 `Infinity`로 JSON에 null이 되던 것을 명시적
    `number|null`로 기록하고, `search= ` 같은 빈 비율을 거절하며, environment 필드를
    타입별로 검증한다. 결과 스키마 버전을 2로 올려 구 baseline을 명확히 거절한다.
  - 회귀·비회귀 CLI 테스트가 실제 타이밍에 의존하던 것을 baseline 메트릭 덮어쓰기로
    결정적으로 만들고, 단언과 반대였던 테스트 이름을 바로잡았다. cold probe는 첫 cold
    서비스에 합쳐 서비스 인스턴스 수를 줄였다.
- ultra-review 2라운드(claude×2 APPROVE, codex×2·grok×1 CHANGES_REQUESTED, agy 유효
  샤드 5개 APPROVE)에서 추가로 확인한 항목과 수정:
  - fabric 비교 dataset 필드에 `journal_transactions`·`fabric_blocks`가 빠져 다른
    `--journal` workload의 baseline이 comparable로 통과할 수 있었다 — 두 필드를 비교
    대상에 추가했다.
  - 부동소수점 경계(110/100-1 > 0.1)로 정확한 경계값이 회귀로 오판될 수 있었다 —
    임계값 비교에 허용 오차를 뒀다.
  - baseline 메트릭 키와 옵션 파생 dataset 필드도 측정 전에 검증한다
    (`loadValidatedBaseline`에 메트릭 목록 전달 + `assertDatasetComparable` 계획 비교).
  - `search_matches`도 요청값 대신 실측 마지막 건수를 기록하고, warm 루프의 불필요한
    추가 overview 순회를 제거했다. `metricMs`는 키 누락을 "missing"으로 보고하고,
    `loadBaselineJson` 안내는 도구별 예시 대신 일반 문구로 바꿨다.
  - `assertComparable`이 단독 호출에도 mode·dataset 섹션을 스스로 검증하고,
    `loadBaselineJson`이 비객체 JSON을 거절한다.
  - `compareMetrics`·`reportCliResult` 단위 테스트와 fabric CLI 조건부 비교 테스트를
    추가했다(선택적 Fabric 의존성이 없는 환경에서는 skip). `--baseline` 단독 사용은
    회귀 판정 없이 비교 수치만 기록하는 annotation 모드다.
- ultra-review 3라운드(claude×2 APPROVE, codex CHANGES_REQUESTED, agy 유효 샤드 4개
  APPROVE; codex-2 quota 소진·grok 타임아웃으로 무효 처리)에서 확인한 항목과 수정:
  - fabric 비교가 저널 트랜잭션·블록 개수만 봐 내용이 다른 동일 개수 저널이 통과될 수
    있었다 — `journal_source`(generated/external)와 `journal_digest`를 비교 필드에
    추가했다. 외부 저널은 레코드 내용 SHA-256, 자체 생성 저널은 타임스탬프와 무관한
    생성 스펙 다이제스트를 쓴다.
  - `currentEnvironment`가 Node·플랫폼·코어 수만 같으면 다른 머신도 통과했다 —
    `cpu_model`을 비교 대상에 추가하고 스키마 버전을 3으로 올렸다.
  - `--out`이 `--baseline`과 같은 파일(심볼릭·하드링크 포함)이면 결과가 baseline을
    덮어써 회귀 기준을 파괴했다 — `assertDistinctOutputPath`로 측정 전에 거절한다.
  - `assertComparable`의 3중 검증을 `assertDatasetComparable` 위임으로 정리하고,
    두 CLI의 baseline/threshold 글루를 `prepareCliComparison`으로 합쳤다.
    environment 섹션 누락은 TypeError 대신 ComparisonInputError다.
  - cold 샘플 0만 타이밍 전에 probe를 돌려 이질적이던 것을 타이밍 뒤로 옮겼다.
    쓰기 실패가 선행 비교 오류를 가리지 않게 원인을 함께 보고한다.
- ultra-review 4라운드(claude×2 APPROVE, agy 유효 샤드 6개 중 APPROVE 4·CHANGES_REQUESTED 2;
  codex quota 소진·grok 타임아웃으로 무효 처리)에서 확인한 항목과 수정:
  - HANDOFF Resume Prompt의 "대기 중인 성능 브랜치는 없다"와 PR #3 오픈 문장의 모순을 정리했다.
  - `reportCliResult`가 파일 쓰기·경로 검사 전에 stdout으로 결과를 먼저 출력해 어떤
    실패 경로에서도 측정 결과가 남게 하고, 쓰기 실패는 항상 ComparisonInputError로
    래핑해 부적절한 측정 안내가 붙지 않게 했다.
  - 공유 모듈을 `performance-compare.ts`로 리네임(무축약 규칙), 두 도구의 옵션 정규화
    함수를 `normalizeOptions`로 통일하고 dead export를 없앴다. 실행은 정규화된 옵션으로
    돌려 계획·측정이 같은 값을 쓰게 했고, smoke의 planned에서 비교 대상이 아닌
    marker를 뺐다.
  - mode·섹션 검사 메시지를 `assertModeMatches`·`requireSection`으로 공유하고,
    `metricMs` 누락 안내는 baseline 쪽에만 재생성 문구를 붙인다.
  - 기각한 리뷰 주장: smoke의 dataset에 `journal_transactions`는 존재하지 않는
    필드이고(외부 저널 입력이 없음), `search_matches` 중복 프로퍼티 주장은 오탐
    (tsc 통과), cold 서비스는 이벤트 리스너를 등록하지 않는다.
- ultra-review 5라운드(claude×2 APPROVE, agy 유효 샤드 3개 중 APPROVE 2·CHANGES_REQUESTED 1;
  codex quota 소진·grok 타임아웃으로 무효 처리)에서 확인한 항목과 수정:
  - `search_query_matches`가 숫자 검색어에 매치되는 seedDemo 문서까지 셀 수 있었다 —
    `isPerformanceDocument`로 필터해 합성 workload 증거만 기록한다.
  - `COMPARABLE_DATASET_FIELDS`·`COMPARABLE_METRICS`를 `satisfies`로 결과 인터페이스의
    키에 컴파일 타임 바인딩해 필드 오타·누락을 런타임이 아닌 tsc가 잡게 했다.
  - 비교 실패는 결과 JSON에 `comparison.error`로 기록해 "--baseline 미지정"과 구별하고,
    `reportCliResult`의 경로 충돌·쓰기 실패가 모두 선행 비교 오류를 병합한다.
    빈 `--baseline` 경로와 normalizeOptions 비대칭(fabric은 dataDir·journalPath까지
    정규화)도 정리했다. `journalSourceOf`로 계획·측정의 journal_source 판정을 공유한다.
  - `parseThresholds` 단위 테스트를 추가하고 CLI spawn 보일러플레이트를 헬퍼로 정리했다.
  - 기각한 리뷰 주장: `isPerformanceDocument` 미사용·검색 결과 top-level document_id
    주장은 오탐(4곳에서 사용, `describeRevision`은 `{payload}` 반환),
    `generatedJournalDigest`의 marker는 모듈 상수.
- Node24 경로를 적용해 `npm run check`: **309 tests / 308 passed / 0 failed / 1 기존 GC 전용 skipped**.
  포함된 설계·문서 검사 통과. `npm run check:types` 통과.
- `node --test test/automation/experiments.test.ts`: 14/14 통과(신규 거절 경로·결정적 비교·
  parseThresholds 단위·reportCliResult 보존·경로 충돌·fabric 조건부 비교 단언 추가).
- `node tools/performance-fabric.ts --documents 2 --samples 1 --body-bytes 1`로 baseline 생성 및
  `--baseline` + `--threshold` 비교 실행 각각 exit0(합성 어댑터 기능 확인일 뿐 성능 개선·
  실제 Fabric 커밋 증명이 아니다).
- ultra-review 최종 6라운드(대상 `bf17153`): claude×2 APPROVE(LOW 유지보수성 항목만),
  agy 유효 샤드 27개 중 7개 CHANGES_REQUESTED였으나 HIGH/MEDIUM 주장 전부 실제 코드와
  대조해 오탐으로 판정했다(파일명·schema 버전·smoke 저널 필드는 stale diff 조각 기반).
  codex quota 소진·grok 타임아웃은 3라운드 연속이라 무효 처리했다. 유효 블로커가 없어
  PR #3을 squash `b073c81`로 머지했다(MERGEABLE/CLEAN, 전 job 통과 확인 후).
  남은 LOW는 **PR #4(`e636166`)로 정리 완료** — 미사용 export 제거, `CliResultIo` io 주입,
  `ComparisonReport` 타입, 테스트 import·spawn 통일, CLI 안내 문구 보강, `journalPath`
  센티널 제거. fabric-boundaries 잡이 `experiments.test.ts`를 실행해 fabric 비교 테스트의
  CI 공백도 메웠다(로그에서 skip 없이 실행 확인).
- 이번 변경으로 `npm run demo`, 브라우저 검사, 대규모 벤치마크, 운영 네트워크 시험은 실행하지 않았다.
- PR #3 원격 CI 통과: local-runtime Node24·26, fabric-boundaries, browser-and-experiments
  (커밋별 push+pull_request run 전부 success — 브라우저 job 안의 `test:performance`가
  새 multi-query/cold 경로를 CI에서 실행했다).

PR #2까지 포함한 이전 실행 근거다(2026-09-17 재실행).

- `npm run check`: **300 tests / 299 passed / 0 failed / 1 GC 전용 skipped**. `npm run check:types` 통과.
- PR #2 원격 CI 8/8 통과: local-runtime Node24·26, fabric-boundaries, browser-and-experiments.
- 리뷰 루프(claude×2·codex×2·grok 게이트, 3라운드) — 최종 라운드의 MEDIUM·LOW 지적 전부 수정 후 머지.
- performance-fabric e2e: `--documents 20` 생성 경로와 `--journal` 재사용 경로 모두 기능 단언 통과.

이전(리네임 시점, 2026-09-16 22:1x KST) 근거:

- `npm run check`: **274 passed /0 failed /1 GC 전용 skipped** — 리네임 후 동일. `npm run check:types`, `npm run demo` 통과.
- `npm run config:init -- --output /tmp/...`으로 새 기본 설정 파일명 동작 확인. `kcl.config` 추적 파일 참조 0.
- **원격 CI(run 35100485521, push `ad3693b`) 첫 실행 전 잡 통과**: local-runtime Node24·26, fabric-boundaries, browser-and-experiments.
- 이전 런타임 `e1e9850` 근거(문서·이름만 달라진 동일 코드):

- `npm run check`: **274 passed /0 failed /1 GC 전용 skipped**. `npm run check:types`, `npm run demo` 통과.
- 인증서/signer 집중19개 통과. 키/CA/actor mismatch, 만료 경계·늦은 갱신, tamper·stale plan,
  symlink, rename/fsync 실패 롤백, 부분 적용 재개·재실행을 검증했다.
- optional 패키지와 개인키 없는 source copy에서 공개 인증서81개 점검 exit0.
  이전 GC14개·Chromium18개·no-optional221개 및 benchmark는 해당 코드가 같아 재사용했다.
- 실제 Fabric: 이전 cert의 대기 거래를 새 cert로 재제출 없이 복구(VALID247), 조직별 별도 signer의 새 거래 VALID248/249/250.
  이전 cert가 아직 유효한 기간의 시험이다. 만료된 이전 cert의 실제 peer 복구는 검증하지 않았다.
- configured smoke: 게시251·승인253·활성254·철회262, 최종265. OIDC/SDK/반환 직전 철회 차단,
  v3 복원 뒤 private source·초안·원래 receipt 유지. 시험 합의는 기존4318에서도 withdrawn 재확인.
- 근거: `.artifacts/certificates/`의 `check.log`, `targeted.log`, `types.log`, `demo.log`, `before.json`, `after.json`,
  `restart.json`, `fabric-evidence.json`, `runtime-health.json`, `no-optional.json`;
  `.data/configured-smoke-LACMrn/evidence.json`. 이전 측정은 `.artifacts/browse-index/`와 docs/VALIDATION.md 참조.
- 이번 문서 갱신: `python3 -B tools/check_docs.py`, AGENTS audit, 기존11개 지침 보존·링크·marker 검사 모두 통과.

## Important Context / Decisions

- 확정: 사용자는 승인된 작업을 구현·검증까지 이어가길 원한다. 같은 범위의 승인을 반복 질문하지 않는다.
  기존 네트워크·공식 의존성·`.data/fabric-smoke/crypto` 테스트 키 생성/서명/사용 및 기존 키 보존 갱신 승인은 유효하다.
  개인 auth/.env/회사 키는 승인 범위에 없다. 원격 게시·릴리스는 명시적 요청 이후 진행한다.
- 검증은 합성 입력·격리 DB/포트/브라우저로 수행했다. 개인 브라우저 세션이나 인증파일은 탐색하지 않는다.
- 공개 준비는 다음 우선순위에 대한 권고다. 공개 저장소 대상·첫 릴리스 버전은 원격 작업 시 확인한다.
  실제 기관 SSO/KMS/모델 업체 선택을 기존 코드 완료의 blocker로 요구하지 않는다.

## Commands & Avoid

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
git status --short
npm start
npm run check
npm run check:types
npm run demo
npm run fabric:certs:check
python3 -B tools/check_docs.py
```

- 기본 셸 Node22를 사용하지 않는다. `npm start`는 프로젝트 설정을 읽고 configured Fabric은 `--organization ORG_ID`가 필요하다.
  예제는 `demo:web`, `demo:fabric`, `demo:login`. 기존 `start:fabric`/`start:login` 별칭도 유지한다.
- 실제 합의 재검증이 필요하면 `fabric:http-smoke` 후 `configured:smoke`를 순서대로 실행한다.
  두 명령은 합성 원장 이력을 남기고 시험 합의를 철회한다. 완료된 fixture의 최초 `fabric:smoke`를 재실행하지 않는다.
- 동일 입력의 통과 검사를 반복하지 않는다. benchmark는 다른 테스트 부하와 분리한다.
  캐시/SQL 자기 대조를 독립 증명으로 삼거나 모든 읽기의 전체 journal 재생·시작 시 원문 누적으로 되돌리지 않는다.

## Next Steps / Open Work

1. 공개 준비·게시·첫 릴리스 `v0.1.0` 완료. 이후 원격 CI는 push/PR마다 자동 실행된다.
2. 선택 검증(로컬 다중 컨테이너 수준) 완료: peer·orderer 중단, 인증서 적용 중 실제 SIGKILL,
   런타임 스냅샷 복원. 독립 물리 호스트 간 장애·재해 복구는 여전히 미검증이다.
3. 선택 도입/확장: 실제 SSO/KMS·모델 공급자/egress 연동과 실제 파일럿 실행.
   벡터 검색 read model(PR #8)·Git 소스 커넥터·채택 측정(PR #13) 코드는 main 반영 완료.
   운영 대시보드(`e69a228`)·대규모 읽기 최적화(`f4113a1`+`7e6b46a`)·10만 문서
   확장성(PR #2 `1249f1e`)은 모두 main에 머지됐다.
   B8의 단일 대형 캐시·블록당 Map 복사는 PR #14·v0.3.0에 반영 완료.
   풀별 예산을 넘는 교차 질의 재계산·cold 검색/이력 재생 비용은 남는다.
   파일럿 측정 CLI의 LocalLedger와 Fabric projection 지원은 로컬 구현·검증 완료.
   Fabric은 인증된 peer 경로에서 보존한 스냅샷을 오프라인 재검증하며, 현재 네트워크
   신선도나 입력의 외부 서명 인증은 수행하지 않는다. 새 변경은 원격 반영 전이다.
4. 성능 도구 개선(baseline 비교·검색 시나리오·CLI 진단): **PR #3 머지 완료(squash `b073c81`)**.
   6라운드 리뷰 루프에서 유효 블로커를 모두 해소했고, 남은 LOW 항목은
   **PR #4(`e636166`)로 정리 완료** — 성능 도구 잔여 과제는 없다.
5. **v0.2.0 릴리스 게시 완료(2026-09-18)** — CHANGELOG.md·ROADMAP.md 신규(PR #5 `16c06f6`),
   태그+GitHub 릴리스 발행. 다음 방향은 오픈소스 성장으로 합의; 로드맵 4개 트랙은
   프로토콜 완성도(A)·운영 성숙(B)·채택/확장(C)·프로젝트 운영(D)이다.
6. **PR #6 조직 signing gateway 머지 완료(2026-09-18, rebase `f3fd4a2`)** — ROADMAP
   트랙A 첫 항목. 조직 바인딩 서명 키·일회성 attestation·암호 검증 영수증·
   필수 감사 로그·qscc 전용 슬롯을 갖춘 원격 서명 경계를 도입했다.
   `feature/org-signing-gateway` 브랜치는 머지 완료.
7. **Track A·B·C 머지 완료(PR #7–#10·#12·#13)** — Track C는 PR #13(squash
   `4aad9ea`)으로 main 반영. 이후 B8 수정·Track D 정책·파일럿 준비도 PR #14로
   main에 반영하고 v0.3.0으로 게시했다.
   실제 파일럿, 독립 물리 호스트/Fabric 채널 장애 검증, 실제 외부 공급자 연동은 남는다.
   이후 릴리스는 [운영 정책](docs/29-PROJECT-OPERATIONS.md)에 따라 진행한다.
8. 유지보수: 공개 인증서 점검은 2026-09-20 완료. 기본14일 경고 창은
   2026-12-31 23:41:57 KST부터이며 다음 수동 점검일은 **2027-01-01 KST**다.
   그때 필요하면 갱신한다. 자동 예약은 설정하지 않았다.

## Resume Prompt

`/Users/jinhongan/Desktop/knowledge-consensus-ledger`에서 AGENTS.md와 HANDOFF.md를 읽고 작업을 이어가.
공개 저장소는 https://github.com/ictechgy/knowledger, 최신 릴리스 `v0.3.0` 게시·원격 CI 통과 완료.
10만 문서 확장성 수정은 PR #2(`1249f1e`), 성능 도구 개선은 PR #3(`b073c81`)·#4(`e636166`),
조직 signing gateway는 PR #6(rebase `f3fd4a2`)로 main에 머지됐다.
Track A(PR #7·#8·#9)·B(PR #10 squash `e42122e`)·graceful-close(PR #12 `d39a9b1`)·
Track C(PR #13 squash `4aad9ea` — Git 커넥터·채택 측정·원자 아티팩트)는 리뷰 수렴 후
main에 머지됐다. 이후 B8 대형 캐시 LRU·Fabric 쓰기 delta 커밋과 Track D 운영 정책,
파일럿 계획/관찰 템플릿을 PR #14(merge `bdb55fb`)로 main에 반영하고 v0.3.0으로
게시했다(493개 중492 통과·1 GC 생략). 실제 Fabric HTTP/configured smoke와
백업·장애 드릴, 원격 Node24·26/Fabric/Chromium18개 CI까지 통과했다.
공개 인증서81개는 정상이고, 세 peer tip은 block331(height332)이다.
남은 작업은 2027-01-01 수동 인증서 점검, 대상 조직·환경이 필요한 실제 파일럿,
독립 물리 호스트/Fabric 채널 장애 검증이다. 후속 작업으로 파일럿 CLI의
`--mode fabric` 원시 블록 재검증·VALID 집계를 로컬 구현·검증했다(504개 중503 통과·
1 GC 생략). source 전체 tip·저널 digest와 정확한 거래 checkpoint를 출력하며
기존 로컬 모드도 유지한다. 현재 `release/v0.4.0`에서 이 후속 변경의 PR·CI·게시를
진행한다. 기존 로컬 검증은 재사용하고 정확한 후보 head의 원격 CI를 확인한다.
완료된 코드와 기존 데이터·키·genesis·.serena·scorpionfish를 보존하고, 확인된 미비점만 수정·검증해.
`kcl:` state 키·`kcl.actor_*` 인증서 속성·배포된 fixture 이름(kcl-demo/kcl/kcl_0.1.0/kcl-fabric-smoke/*.kcl.test)은 배포 계약이므로 리네임하지 마.
실제 실행하지 않은 장애 시험을 완료로 표시하지 마.
