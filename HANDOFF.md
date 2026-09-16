# Handoff

_Last updated: 2026-09-16 14:27 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 승인된 코드 작업을 중간 재승인 없이 구현·검증하길 원한다.
조직/업무는 설정으로 정하고 영업·이행·정산은 선택형 예제다. 최신 요청인 **조회 참조 인덱스 최적화**를 완료했다.
목록/검색 HTTP, cursor, SDK 원문, strict resolver 계약은 유지한다. 운영 업체 선택을 개발 blocker로 다시 요구하지 않는다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 최신 커밋은 `git log -1` 확인.
  이전 리뷰 구현 `419a26d`, 리뷰 `399f78b`, R1–R6 수정 `90bdcda`, 실제 Fabric 검증 `de3e953`.
- **기본 앱 http://127.0.0.1:4317**. Git 제외 `kcl.config.json`, `.data/workspaces/knowledge/local` 보존.
  2조직 빈 제품 workspace이며 local block1·문서0개다.
- 예제 앱4318/4319/4321/4331/4341도 최신 코드로 graceful restart했다. 개발 로그인 세션은 초기화됐다.
  앱6개 모두 health/readiness200, OIDC 앱4개는 익명 overview401.4318은 실제 Fabric block246·최신 슬롯4개.
- `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement` 보존.
- Colima `colima`:3 peer·3 Raft orderer 모두 running. 테스트 인증서 **2026-09-22 만료**.
  chaincode0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지.
  네트워크 초기화·chaincode 재배포를 하지 않았다.
- 사용자 `.serena/` 보존·커밋 제외. 원격 push/CI는 실행하지 않았다.

## Latest Delivery — 조회 인덱스

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

- `npm run check`: **264 passed /0 failed /1 GC 전용 skipped**.
- `node --expose-gc --test test/fabric/sqlite-projection.test.ts`: **14 passed /0 skipped**.
- `check:types`, `demo`, `demo:kb`, `test:history-performance` 통과. Chromium **18개 통과**.
- 외부 패키지 없는 source copy: **221 passed /0 failed /44 skipped**. 새 외부 의존성을 추가하지 않았다.
- 페이지의 전체 prefix scan 제거/읽는 row 수, scan 호환 응답 동일성, full slot·과거 cursor,
  검색 scope/Unicode/cache eviction, rollback·replay·SQL 변조·INVALID/다중 거래/빈 블록을 검사했다.
- 10,000개 문서도 전체 목록/검색/재시작 후 개수 일치. 단일 전 페이지 순회 목록1.71초·검색2.05초, replay2.69초.
  이1회 표본을 p95/SLA로 주장하지 않는다.
- `.artifacts/browse-index/`: 비교 JSON, check/types/browser/memory/no-optional 로그,
  query-plan.json, history.log, runtime-health.json, configured-smoke.log.
- 실제 설정 기반 Fabric 재검증: VALID 게시232·승인234·활성235·철회243, 최종 block246.
  OIDC/SDK/결과 반환 직전 철회 차단/v3 복원 뒤 index·source·초안·원래 receipt 유지.
  `.data/configured-smoke-X8z08j/evidence.json`; 시험 합의는 withdrawn으로 재확인했다.
- 이번에는 peer 중단을 반복하지 않았다. 이전 `de3e953` 검증에서206→231 동안
  동시 게시3건→VALID1건, private2건→초안1개, peer 중단/복구, 앱 재시작, 시험 합의2건 철회를 확인했다.
  `.data/fabric-http-smoke-Z7z3wH/http-evidence.json`, `.data/configured-smoke-1R4sjZ/evidence.json`.

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

- 기존 네트워크·공식 의존성·`.data/fabric-smoke/crypto` 테스트 키 생성/서명/사용 승인 재사용.
  개인 auth/.env/회사 키는 읽지 않는다. 검증은 합성 입력·격리 DB/포트/브라우저를 사용한다.
- `.serena/`, 기존 키·원장·genesis 보존. 원격 공개에는 명시적 요청이 필요하다.
- DB backup은 앱 종료 후, restore는 새 폴더. WAL/SHM 삭제로 검사를 우회하지 않는다.
- 앱 종료 전 PID/command/cwd를 대조하고 graceful shutdown한다. 개인 브라우저·로그인 세션을 탐색하지 않는다.
- SQL 파생 테이블의 자기 대조를 독립 증명으로 삼거나, 모든 read마다 전체 원장을 재생하거나,
  startup에 전체 원문 write를 모으는 방식으로 되돌리지 않는다.

## Remaining / Resume

리뷰6건, 실제 Fabric 통합 검증, 조회 인덱스 최적화는 완료했다. 운영 업체 선택을 코드 blocker로 다시 요구하지 않는다.
남는 비용은 cache miss의 metadata 순회, 새 substring 검색의 후보 원문 읽기, 새 ref의 COW 쓰기,
key 수에 비례하는 상태/anchor/ref, 최대8개 과거 snapshot과 cold/시작 replay다. 더 큰 workload 최적화는 별도 목표다.

테스트 인증서9월22일 만료 대응, 원격 공개/CI 실행은 남아 있다. 실제 기관 SSO·모델 egress/공급자 연결,
파일럿·독립 호스트 장애/재해 복구, SaaS connector·벡터 검색·운영 대시보드는 별도 도입/확장 범위다.

재개: 이 저장소의 AGENTS.md/HANDOFF.md와 docs/26-BROWSE-INDEX.md를 읽고 새 요청 범위부터 진행해.
기존 데이터·키·.serena를 보존하고 완료 항목을 미수정으로 되돌리지 마. 원격 push에는 명시적 요청이 있어야 한다.
