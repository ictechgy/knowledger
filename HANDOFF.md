# Handoff

_Last updated: 2026-09-16 15:41 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 승인된 코드 작업을 중간 재승인 없이 구현·검증하길 원한다.
조직/업무는 설정으로 정하고 영업·이행·정산은 선택형 예제다. 최신 요청인 **테스트 사용자 인증서 갱신**을 완료했다.
기존 키·CA·TLS·genesis·원장은 보존했고 세 사용자 인증서만 갱신했다. 운영 업체 선택을 개발 blocker로 다시 요구하지 않는다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 최신 커밋은 `git log -1` 확인.
  직전 조회 인덱스 `5173527`. 이전 리뷰 구현 `419a26d`, 리뷰 `399f78b`, R1–R6 수정 `90bdcda`, 실제 Fabric 검증 `de3e953`.
- **기본 앱 http://127.0.0.1:4317**. Git 제외 `kcl.config.json`, `.data/workspaces/knowledge/local` 보존.
  2조직 빈 제품 workspace이며 local block1·문서0개다.
- 예제 앱4318/4319/4321/4331/4341도 최신 코드로 graceful restart했다. 개발 로그인 세션은 초기화됐다.
  앱6개 모두 health/probe 후 readiness200, OIDC 앱4개는 익명 overview401.4318은 실제 Fabric block265·최신 슬롯4개.
  readiness는5초보다 오래된 표본에서503 후 비동기 probe로 갱신된다.
- `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement` 보존.
- Colima `colima`:3 peer·3 Raft orderer 모두 running. 사용자 인증서3개 **2026-12-15 15:29:11 KST 만료**. CA·peer/orderer는2036년까지 유효.
  chaincode0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지.
  네트워크 초기화·chaincode 재배포를 하지 않았다.
- 사용자 `.serena/` 보존·커밋 제외. 원격 push/CI는 실행하지 않았다.

## Latest Delivery — 테스트 인증서

- `infra/fabric/certificates.ts` + 예제 CLI: 공개 만료 점검, 기존 키를 이용한90일 갱신 준비/적용.
  actor·SPKI·subject·issuer·CA·MSP/genesis 검증, 전체 preflight, 개별 atomic replace와 실패 롤백,
  변조·경로·유효기간 검사, 만료 후 복구·부분 적용 재개·재실행. 운영 CA/TLS rotation은 범위 밖이다.
- signer는 요청 전/서명 후 유효기간을 확인하고 정확한 만료 경계부터 거부한다.
  신규 테스트 네트워크의 User1 인증서도90일로 발급한다.
- 실제 plan: `.data/fabric-smoke/certificate-renewals/renewal-20260916062911-ba83c15935beb018/plan.json`.
  사용자 cert3개만 변경, 전체 공개키 동일, 대상 외130개 파일 내용·inode·mtime 및 genesis 유지.
  앱4318/4319/4321/4331/4341과 signer 정상 재시작. 기본4317은 그대로다.
- 이전 cert 거래의 outbox를 새 cert로 재제출 없이 복구(VALID247), 각 조직 신규 fence VALID248/249/250.
  이전 cert가 아직 유효한 기간의 실제 복구 시험이며 이미 만료된 cert의 peer 복구 증거는 아니다.
- [사용/복구 절차](docs/27-TEST-CERTIFICATES.md), [검증 기록](docs/VALIDATION.md).
  maintenance는 한 번에 하나만 실행한다. apply 성공 후 changed0이어도 app/signer 재시작 여부를 확인한다.

## Previous Delivery — 조회 인덱스

- `packages/storage/browse-index.ts`: 검증된 journal write에서 key/ID/digest/full slot/최초 CP/정렬 시각만 보관.
  Local/Fabric이 같은 인덱스를 사용한다. SQL 커밋 전 준비, 성공 후 공개. mutable indexed identity 변경은 거부한다.
- 시작/복원에는 generator로 원시 journal을 소비하고 compact 참조 배열을 한 번 정렬한다.
  원문 이력을 배열에 누적하지 않는다. 인덱스용 DB 파일/schema migration은 없다.
- `apps/api/service.ts`: 페이지 후보를 인덱스에서 고르고 선택된 canonical 값의 key/ID/slot/정렬 필드를 대조한다.
  config/slot 판정은 요청 안에서 재사용. `queryBrowse` 미지원 어댑터는 검증 scan 호환 경로를 사용한다.
- metadata 결과 캐시: exact snapshot/모드/필터별8개, 총16,384 refs, 추정512KiB.
  검색 캐시: actor/조건/snapshot별8개, 총20,000 digest IDs, UTF-8 key/ID bytes2MiB.
  원문·private source·eligibility를 캐시하지 않는다. 새 substring 검색은 후보 원문을 읽고 JS lower/includes 의미를 유지한다.
- cursor는 기존 HMAC actor/조건/checkpoint 결속을 유지. 새 게시 후에도 과거 페이지는 당시 상태를 보인다.
  최신 지식 사용 여부는 계속 fresh 권한/원장/fence/domain resolver가 판단한다.
- 동일1,000개1KiB·5회·전 페이지 p95: 목록 **1,071.24→176.56ms**, 검색 **995.32→209.72ms**.
  게시 **1.43→1.58ms**, replay **248.99→268.17ms**로 유지 비용도 기록했다. 운영 SLA가 아니다.
- [설계/측정/상한](docs/26-BROWSE-INDEX.md), [검증 기록](docs/VALIDATION.md).

## Verification

- `npm run check`: **274 passed /0 failed /1 GC 전용 skipped**. `check:types`, `demo` 통과.
- 인증서/signing 집중19개 통과: 키·genesis 유지, 정확한 raw attrs, 잘못된 actor/CA/key,
  만료 경계·늦은 갱신, 변조·stale·symlink, rename/fsync rollback, partial resume/idempotency.
- 공개 인증서81개를 optional 패키지/개인키 없는 source copy에서 점검해 exit0 확인.
- `.artifacts/certificates/`: check/types/targeted/demo, before/after 공개 메타데이터,
  restart.json, fabric-evidence.json, runtime-health.json, no-optional.json, configured-smoke.log.
- 실제 configured smoke 게시251·승인253·활성254·철회262, 최종265.
  OIDC/SDK/반환 직전 철회 차단/v3 복원 후 source·초안·원래 receipt 유지.
  `.data/configured-smoke-LACMrn/evidence.json`; 시험 합의는 기존4318에서 withdrawn 재확인.
- 이전 조회 인덱스의 GC14개·Chromium18개·no-optional221개, benchmark 및 peer 장애 증거는
  해당 코드가 같아 재사용했다. 기록은 docs/VALIDATION.md와 `.artifacts/browse-index/`에 있다.
- 실제 프로세스 SIGKILL을 끼워 넣지는 않았다. 여러 cert 중 일부만 적용된 상태와
  rename 성공 뒤 fsync 실패는 합성 테스트로 검증했다. 원격 push/CI는 실행하지 않았다.

## Commands

Node24를 사용한다. 기본 로그인 셸의 Node22는 프로젝트 실행용이 아니다.

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm start
npm run check
npm run check:types
npm run test:browser
npm run test:performance -- --documents 1000 --samples 5 --body-bytes 1024
npm run test:history-performance
node --expose-gc --test test/fabric/sqlite-projection.test.ts
npm run demo
npm run demo:kb
npm run fabric:certs:check
# 필요 시 prepare → 앱/signer 종료 → apply → 같은 설정으로 재시작
npm run fabric:certs:prepare -- --days 90 --renew-before-days 14
```

- 비교 benchmark는 테스트/브라우저 부하와 동시에 실행하지 않는다.
- `npm start`: 명시적 `--config FILE` 또는 `kcl.config.json`. configured Fabric은 `--organization ORG_ID` 필수.
- 예제는 `demo:web`, `demo:fabric`, `demo:login`. `start:fabric`/`start:login` 호환 별칭 유지.
- optional browser: `npm ci --prefix packages/browser-tests --ignore-scripts --no-fund` 후
  `node packages/browser-tests/node_modules/playwright/cli.js install chromium`.
- 실제 후속 검증은 `npm run fabric:http-smoke` 후 `npm run configured:smoke`를 순서대로 실행한다.
  같은 예제 슬롯을 사용하며 합성 이력을 남기고 시험 합의를 철회한다. 최초 `fabric:smoke`를 반복하지 않는다.

## Established Foundation

- 공통 결정적 엔진: 불변 본문, exact proposal/revision/full slot/policy/epoch 승인, AI 승인 거부, CAS·이의·철회·dependency·fence.
- Fabric VALID full-block projection, outbox, OIDC 현재 인가, 별도 signer, 조직별 runtime scope.
- R1–R6: bounded summary/detail pages, metadata-free liveness와 제한된 readiness,
  private 쓰기/public 대기 분리, 명령 대기32/64개, 과거 snapshot/검증 block 각각8개 LRU,
  원시 journal 누적 digest/최초 쓰기 anchor, manifest 상태 무효화와 source 페이지 이동.
- 설정 기반2/4조직 제품과 order-workflow 예제 분리. offline snapshot v1/v2/v3 유지.
- Markdown source: actor-private path/hash, 명시적 allowlist, global version CAS,
  파일256KiB·present100개/16MiB·metadata200개. 원본 누락이 shared agreement를 자동 철회하지 않는다.
- Node SDK: exact revision/strict manifest, 생성·반환 전 권한/신선도 재검증. 외부 callback 부작용 취소,
  이미 모델에 전달한 본문 회수, 독립 Fabric quorum proof를 보장하지 않는다.
- Claude Sonnet5 디자인/4관점 리뷰 완료. scrubbed packet·구독 CLI를 사용했고 개인 인증파일/전역 설정을 바꾸지 않았다.
  [리뷰](docs/25-CLAUDE-REVIEW.md), 원본 Git 제외 `.artifacts/claude-review-419a26d/`.

## Authorization & Avoid

- 기존 네트워크·공식 의존성·`.data/fabric-smoke/crypto` 테스트 키 생성/서명/사용 및 기존 키를 보존하는 인증서 갱신 승인 재사용.
  개인 auth/.env/회사 키는 읽지 않는다. 검증은 합성 입력·격리 DB/포트/브라우저를 사용한다.
- `.serena/`, 기존 키·원장·genesis 보존. 원격 공개에는 명시적 요청이 필요하다.
- DB backup은 앱 종료 후, restore는 새 폴더. WAL/SHM 삭제로 검사를 우회하지 않는다.
- 앱 종료 전 PID/command/cwd를 대조하고 graceful shutdown한다. 개인 브라우저·로그인 세션을 탐색하지 않는다.
- SQL 파생 테이블의 자기 대조를 독립 증명으로 삼거나, 모든 read마다 전체 원장을 재생하거나,
  startup에 전체 원문 write를 모으는 방식으로 되돌리지 않는다.

## Remaining / Resume

리뷰6건, 실제 Fabric 통합 검증, 조회 인덱스 최적화, 테스트 인증서 갱신은 완료했다. 운영 업체 선택을 코드 blocker로 다시 요구하지 않는다.
남는 비용은 cache miss의 metadata 순회, 새 substring 검색의 후보 원문 읽기, 새 ref의 COW 쓰기,
key 수에 비례하는 상태/anchor/ref, 최대8개 과거 snapshot과 cold/시작 replay다. 더 큰 workload 최적화는 별도 목표다.

기본14일 경고 창 기준 다음 사용자 인증서 점검/갱신 시점은12월1일 이후다. 원격 공개/CI 실행은 남아 있다. 실제 기관 SSO·모델 egress/공급자 연결,
파일럿·독립 호스트 장애/재해 복구, SaaS connector·벡터 검색·운영 대시보드는 별도 도입/확장 범위다.

재개: 이 저장소의 AGENTS.md/HANDOFF.md와 docs/27-TEST-CERTIFICATES.md를 읽고 새 요청 범위부터 진행해.
기존 데이터·키·.serena를 보존하고 완료 항목을 미수정으로 되돌리지 마. 원격 push에는 명시적 요청이 있어야 한다.
