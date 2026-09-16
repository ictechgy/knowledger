# Handoff

_Last updated: 2026-09-17 06:30 KST by Devin_

## Goal

MIT 지식 합의 원장을 오픈소스로 공개한다. **제품 이름은 Knowledger로 확정**했다(기존 `knowledge-consensus-ledger`/`kcl`에서 리네임).
조직·업무는 설정으로 정하며 영업·이행·정산은 선택형 예제다.
합의한 코드 작업·Claude 리뷰 수정·조회 최적화·테스트 인증서 갱신·제품 리네임은 완료했다. 다음 우선순위는 공개 준비와 원격 CI 확인이다.
이번 요청은 제품 이름 확정과 리네임이다. 상시 규칙은 [AGENTS.md](AGENTS.md), 상세 이력은 [검증 기록](docs/VALIDATION.md)에 둔다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`(로컬 체크아웃 경로는 그대로), 공개 이름은 `knowledger`. branch `main`.
  **공개 완료: https://github.com/ictechgy/knowledger — 리네임 커밋 `ad3693b`, 태그·릴리스 `v0.1.0`.**
  이전 조회 최적화 `5173527`, 실제 Fabric 장애 검증 `de3e953`, 리뷰 수정 `90bdcda`.
  문서 커밋 포함 최신 상태는 `git log -1 --oneline`과 `git status --short`로 확인한다.
- 리네임 전 추적 파일은 clean, 사용자 `.serena/`와 `scorpionfish/`만 untracked. 둘 다 보존·커밋 제외.
- **마지막 실행 검증: 2026-09-16 늦은 밤 KST(실제 장애 시험까지 포함).**
  앱4317/4318/4319/4321/4331/4341을 새 코드로 재시작해 모두 readiness200을 확인했다.
  재시작 중 발견된 두 결함을 수정했다: peer gRPC keepalive(`26e75a8`)와 원장 갱신 상한
  `refreshTimeoutMs`(`f189e80`). 세부는 [검증 기록](docs/VALIDATION.md)의 최신 장애 시험 항목.
- 실제 장애 시험 완료: peer 중단 503→복구(`fabric:http-smoke`), orderer1 중지 중 게시6건 커밋·
  재기동 추월·복구 후 block288, 인증서 적용 중 실제 SIGKILL 후 같은 plan 재개, `.data/fabric-login`
  백업→새 폴더 복원→기동 확인. 최신 원장 tip은 block289 부근이다.
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
- 제품 리네임 `knowledger`: 패키지명·`knowledger.config.json` 기본값·`@knowledger/*` 범위·`Knowledger*` 클래스·
  `X-KNOWLEDGER-CSRF`·OIDC 쿠키/client_id·`KNOWLEDGER_SNAPSHOT_*` env·스키마 `$id`·테스트 접두사·문서 표기.
  실행 중인 배포 계약은 `kcl` 그대로 유지한다 — `kcl:` 원장 state 키, `kcl.actor_*` 인증서 속성,
  `kcl.test-certificate-renewal` plan 스키마, fixture 이름(channel `kcl-demo`, chaincode `kcl`/`kcl_0.1.0`,
  compose `kcl-fabric-smoke`, 도메인 `*.kcl.test`). 경계 규칙은 [AGENTS.md](AGENTS.md)에 있다.

## Key Files & State

- `.github/workflows/ci.yml`: local Node24/26, Fabric/auth/API·타입 검사, Chromium·성능/복구 jobs. 원격 실행 전 대상.
- `infra/fabric/certificates.ts`, `examples/order-workflow/client-certificates.ts`: 갱신 core와 고정 예제 CLI.
  적용 plan: `.data/fabric-smoke/certificate-renewals/renewal-20260916062911-ba83c15935beb018/plan.json`.
- `packages/storage/browse-index.ts`, `apps/api/service.ts`: 조회 인덱스 및 canonical 대조·페이지 계약.
- 보존할 local 설정/데이터: Git 제외 `knowledger.config.json`, `.data/workspaces/knowledge/local`.
  예제 데이터: `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement`.
- 네트워크: `.data/fabric-smoke/compose.json`, 같은 폴더의 `crypto/`·`channel.block`.
  Compose CLI `.tools/docker-compose`; Docker는 `/opt/homebrew/bin/docker`다.

## Verification

리네임 변경의 실행 근거다(2026-09-16 22:1x KST 재실행).

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
3. 선택 도입/확장: 실제 SSO/KMS·모델 공급자/egress, SaaS connector·벡터 검색·파일럿.
   운영 대시보드는 `e69a228`로, 대규모 읽기 최적화는 `f4113a1`+`7e6b46a`로 구현했다.
   더 큰 규모(10만+ 문서)·Fabric 모드 동일 측정·혼합 슬롯 workload는 후속 목표다.
   이 항목들을 오픈소스 알파 공개의 필수 미완료 코드로 취급하지 않는다.
4. 유지보수: 기본14일 경고 창 기준 **2027년1월 초** 인증서를 점검·갱신한다. 자동 예약은 설정하지 않았다.

## Resume Prompt

`/Users/jinhongan/Desktop/knowledge-consensus-ledger`에서 AGENTS.md와 HANDOFF.md를 읽고 작업을 이어가.
공개 저장소는 https://github.com/ictechgy/knowledger, 첫 릴리스 `v0.1.0` 게시·원격 CI 통과 완료.
완료된 코드와 기존 데이터·키·genesis·.serena·scorpionfish를 보존하고, 확인된 미비점만 수정·검증해.
`kcl:` state 키·`kcl.actor_*` 인증서 속성·배포된 fixture 이름(kcl-demo/kcl/kcl_0.1.0/kcl-fabric-smoke/*.kcl.test)은 배포 계약이므로 리네임하지 마.
실제 실행하지 않은 장애 시험을 완료로 표시하지 마.
