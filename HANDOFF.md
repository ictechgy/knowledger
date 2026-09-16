# Handoff

_Last updated: 2026-09-16 13:23 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 남은 코드 작업을 중간 재승인 없이 진행하길 원한다.
오픈소스 제품이므로 영업·이행·정산은 선택형 예제이며 제품의 필수 조직 구성이 아니다.
Claude 리뷰의 R1–R6 수정은 `90bdcda`에서 완료했다. 최신 요청인 **실제 Fabric 쓰기·동시 요청·장애 복구 검증**도
HTTP와 설정 기반 OIDC/SDK/백업 복원 경로까지 완료했다. 아래 제한은 유지한다.
운영 SSO/KMS/모델 업체 선택을 코드 작업 blocker로 다시 요구하지 않는다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`.
  리뷰 대상 구현은 `419a26d`, 리뷰 문서는 `399f78b`, 런타임 수정은 `90bdcda`.
  최신 검증 스크립트/문서 커밋은 `git log -1`로 확인한다.
- **기본 앱 http://127.0.0.1:4317**, Git 제외 `kcl.config.json`, `.data/workspaces/knowledge/local`.
  초기 문서 없는2조직 제품 설정을 보존했다. 최신 앱 health/readiness200, local block1·문서0개.
- 예제 앱도 최신 코드로 graceful restart:4318 Fabric 개발 계정,4319 OIDC 통합/IdP4320,
  4321 영업/4322,4331 이행/4332,4341 정산/4342. 전부 health/readiness200.
  4318의 실제 Fabric block231·최신 슬롯4개. OIDC 앱4개는 익명 overview401.
  최신 검증에서는 기존 앱을 재시작하지 않았다. 앞선 런타임 수정 직후 재시작한 상태를 유지한다.
- `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement` 보존.
- 네트워크는 Colima `colima`의3 peer·3 Raft orderer. 테스트 인증서 **2026-09-22 만료**.
  chaincode0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지.
  최신 검증은206→231의 합성 게시/승인/활성/철회와 Fulfillment peer 일시 중단·복구를 수행했다.
  시험 합의2건 모두 withdrawn. 네트워크 초기화·chaincode 재배포는 하지 않았다.
- 사용자 `.serena/`는 보존하고 커밋에서 제외했다. 원격 push는 하지 않았다.

## Latest Delivery

### 실제 Fabric 통합 검증

- HTTP: 게시207·승인209·활성210·철회214. 동일 게시3건은 VALID1건·같은 receipt,
  private import2건은 초안1개. overview8건, health/readiness 각각16건 병행 성공.
  이 실행에서 private import 약111.5ms, 게시 receipt 약1,174.1ms로 private 작업이 먼저 끝났다.
- Fulfillment peer 중단 동안 readiness/resolve503, liveness200. peer 복구 뒤 provided,
  앱 재시작 뒤 원래 승인 receipt, 오래된 run 거부, 철회 뒤 재검증/새 resolve withheld.
- 설정 기반: 게시217·승인219·활성220·철회228. OIDC 인가/회수, 별도 signer, SDK exact revision,
  모델 결과 반환 직전 철회 차단, version3 복원 후 source/초안/명령 보존 확인. 최종 block231.
- `infra/fabric/http-smoke.ts`: 시작 checkpoint 이후 이벤트 검사·동시 요청·liveness/readiness 분리·실패 정리 추가.
  `tools/configured-smoke.ts`: `active_agreement` 계약 반영, 실패 evidence/생성 합의 정리 보완.
  제품 런타임 코드는 바꾸지 않았다. 두 smoke는 같은 슬롯을 사용하므로 동시에 실행하지 않는다.

### R1–R6 수정 (`90bdcda`)

- **R1:** overview는 full slot별 최신 게시본 요약과 별도 제안 페이지다. 검색/이력도 기본20·최대50.
  본문/누적 history를 목록에 반복하지 않는다. 정확한 원문 SDK 계약은 유지한다.
  `GET /revisions/{digest}/view`, `/history`, `GET /agreement-proposals/{id}`로 정확한 상세를 조회한다.
  `GET /documents/{id}`도 요약 페이지로 바뀌었다. 외부 browse 호출자는 [API 변경](docs/11-RUNTIME.md)을 따른다.
- cursor는 actor·조회조건·원장 snapshot에 HMAC 결속, 새 게시에도 페이지가 밀리지 않는다.
  계정/조건 변경·변조·서버 재시작에는400 `INVALID_CURSOR`, 첫 페이지부터 재조회한다.
  원장 최신 사용 가능 여부는 계속 strict resolver/fence가 판단한다.
- **R2:** `/healthz`는 원장 RPC 없는 liveness. `/readyz`는 단일 비동기 probe·1초 간격·5초 최대 샘플 나이.
  첫 확인/실패/정체에는503. 준비 상태 캐시는 지식의 최신성 근거가 아니다.
- **R3:** private 쓰기는 fresh 인가 뒤 동기적인 CAS/SQLite 구간에서 처리해 public transport를 기다리지 않는다.
  service 원장 대기32개, Fabric 명령 대기 기본64개. 혼잡은 retryable503/429이며 영구 rejected로 기록하지 않는다.
  Fabric은 projection 순서를 보존하고 외부 transport 대기 중 refresh를 허용한다.
  동시 refresh를 합치되 제출 완료 뒤에는 이전 세대 refresh를 사용하지 않는다.
- **R4:** raw journal 순차 replay, 현재 상태 유지, 과거 snapshot/검증 block 결과 각각8개 LRU.
  현재 key당 최초 VALID 쓰기의 checkpoint·값/거래/raw digest를 독립 anchor로 유지한다.
  SQL은 파생값/locator일 뿐이며 최초 쓰기·원래 receipt를 검증한다. cold replay는 현재 상태와
  검증 당시 원시 journal 누적 digest까지 대조한다. durable 이력을 삭제하지 않는다.
- **R5/R6:** manifest 선택 직후 이전 상태와 늦은 응답을 무효화. source 목록 더 보기/개수 표시.
  문서·제안·이력 페이지를 연결했고, 페이지 밖 부모·정확한 과거 제안·기존 활성 합의 ID를 보존한다.
  새 상세 상태를 옛 목록으로 덮지 않고, 늦은 이력 응답으로 입력한 승인 근거가 지워지지 않는다.
- [리뷰/수정 근거](docs/25-CLAUDE-REVIEW.md), [실행 API](docs/11-RUNTIME.md), [검증 기록](docs/VALIDATION.md).

## Commands

Node24를 사용한다. 기본 로그인 셸의 Node22는 프로젝트 실행용이 아니다.

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm start
npm run check
npm run check:types
npm run test:browser
npm run test:history-performance
node --expose-gc --test test/fabric/sqlite-projection.test.ts
npm run demo
npm run demo:kb
```

- `npm start`는 명시적 `--config FILE` 또는 `kcl.config.json` 필요. Fabric은 `--organization ORG_ID` 필수.
- 예제 실행은 `demo:web`, `demo:fabric`, `demo:login`; `start:fabric`/`start:login` 호환 별칭 유지.
- optional 브라우저 패키지: `npm ci --prefix packages/browser-tests --ignore-scripts --no-fund`,
  `node packages/browser-tests/node_modules/playwright/cli.js install chromium`.
- `test:performance -- --documents 1000 --samples 5 --body-bytes 1024`는 모든 요약 페이지 순회 시간이다.
- `test:resilience`는 격리 로컬 복구 실험. 기존 네트워크에 최초 `fabric:smoke`를 반복하지 않는다.
- 실제 후속 검증은 `npm run fabric:http-smoke` 후 `npm run configured:smoke`. 새 합성 이력을 남기고 합의를 철회한다.

## Verification

- 최신 `fabric:http-smoke`, `configured:smoke`, `check:types` 통과.
  `.data/fabric-http-smoke-Z7z3wH/http-evidence.json`, `.data/configured-smoke-1R4sjZ/evidence.json`.
  `.artifacts/fabric-verification/`의 실행/type 로그와 `final-state.json`.
  최종3 peer·3 orderer running, 개발 앱6개 health/readiness200, 시험 합의2건 withdrawn을 재확인했다.
- 아래249개/Chromium18개/성능 측정은 변경되지 않은 제품 런타임의 이전 검증이며 이번에 반복하지 않았다.

- `npm run check`: **249 passed /0 failed /1 GC 전용 skipped**.
- 별도 `--expose-gc` projection 검사 **12 passed /0 skipped**, `check:types`·`demo`·`demo:kb` 통과.
- `test:browser`: **Chromium18개 통과**. 새 페이지 계약과 actor/늦은 응답/원문·합의 선택까지 포함한다.
- 외부 패키지 없는 source copy: **208 passed /0 failed /42 skipped**. 기본 로컬 실행에 새 외부 의존성 없음.
- 동일 슬롯200개 개정 overview JSON **16,811,761→2,820 bytes**, 새5회 계산 약7.33–9.70ms.
  이력20개 페이지22,176 bytes, 원문/총200개 이력 보존. 로컬 측정이며 Fabric SLA가 아니다.
- 64→512블록 고정 key 실험: raw29,527,920 bytes 추가, GC 뒤 ArrayBuffer 증가9 bytes.
  growing key 집합의 전체 메모리가 일정하다는 뜻은 아니다.
- 1,000개 문서 전 페이지 순회/재시작 전후 총개수 일치. 이전 단일 전체 응답과 latency를 직접 비교하지 않는다.
- `.artifacts/review-fixes/`: 최종 check/types/browser/no-optional/projection-memory 로그,
  history-after/performance-1000 JSON, runtime-health/live-fabric-browse JSON.
- 앞선 읽기 검증은 block206에서 summary와 정확한 revision view/history200을 확인했다.
  이후 실제 쓰기/장애 검증까지 위 기록으로 완료했다.
- 이전 `.data/configured-smoke-zv1THX/evidence.json`의 실제 VALID 게시192·승인194, source/SDK/release 철회 차단,
  v3 restore 검증은 이전 구현 근거로 유지한다. 이번에 같은 네트워크 쓰기를 반복했다고 주장하지 않는다.

## Established Foundation

- 공통 결정적 엔진: 불변 본문, 정확한 proposal/revision/slot/policy/epoch 승인, CAS·이의·철회·dependency·fence.
- Fabric VALID full-block projection, outbox, OIDC 현재 인가, 별도 signer, 조직별 runtime scope.
- 설정 기반2/4조직 제품과 order-workflow 예제 분리, private 초안/Markdown import, offline snapshot v1/v2/v3.
- Markdown source connector: 명시적 allowlist, actor-private path/hash, global version CAS,
  파일256KiB·present100개/16MiB·metadata200개. 원본 누락은 shared agreement를 자동 철회하지 않는다.
- Node 지식 SDK: 정확한 revision·strict manifest 검증, 생성/반환 전 권한과 freshness 재검증.
  callback의 외부 부작용 취소나 이미 모델에 전달한 본문 회수를 보장하지 않는다.
- Claude Sonnet5 실제 디자인/4관점 리뷰는 완료했다. 전용키 없이 scrubbed packet을 구독 CLI에 전달했고
  개인 인증파일·전역 설정을 건드리지 않았다. 원본은 Git 제외 `.artifacts/claude-review-419a26d/`에 있다.

## Authorization & Avoid

- 기존 네트워크·공식 의존성·`.data/fabric-smoke/crypto` 테스트 키 생성/서명/사용 승인 재사용.
  개인 auth/.env/회사 키는 읽지 않는다. 테스트는 합성 입력·격리 DB/포트/브라우저를 사용한다.
- `.serena/`, 기존 키·원장·genesis를 보존. 강제 Git 명령/원격 공개는 별도 명시적 요청 없이 하지 않는다.
- DB backup은 앱 종료 후, restore는 새 폴더. WAL/SHM 삭제로 검사를 우회하지 않는다.
- 서버 종료 전 PID/command/cwd를 확인하고 graceful shutdown한다. 개인 브라우저·로그인 세션을 탐색하지 않는다.
- R4의 단순 LRU+SQL 자기 대조, 모든 read마다 full replay 방식은 채택하지 않는다.
  불변식과 현재 읽기 성능을 함께 검사해야 한다.

## Remaining / Resume

요청한 R1–R6 코드 수정과 실제 Fabric 쓰기/동시 요청/peer 장애/복원 검증은 완료했다.
범위를 임의로 확장하거나 운영 업체 결정을 다시 blocker로 삼지 않는다.
남는 명시적 한계는 페이지당 O(N) browse 계산, 현재 key 수에 비례하는 상태/anchor,
최대8개 과거 snapshot과 cold replay/시작 replay 비용이다. 운영 부하/독립 인프라 검증은 별도 목표다.

테스트 인증서9월22일 만료 대응, 추가 조회 인덱스/대규모 replay 최적화, 원격 공개/CI 실행은 남아 있다.
실제 기관 SSO·모델 egress 정책/공급자 설정, 파일럿 운영, 독립 호스트 장애/재해 복구는 별도 도입 단계다.
SaaS별 connector·벡터 검색·운영 대시보드는 별도 확장 기능이다.

재개: 이 저장소의 AGENTS.md/HANDOFF.md와 docs/25-CLAUDE-REVIEW.md 후속 수정을 읽고 새 요청 범위부터 진행해.
기존 데이터·키·.serena를 보존하고, 리뷰의6개 항목을 미수정으로 되돌리지 마. 원격 push에는 명시적 요청이 필요하다.
