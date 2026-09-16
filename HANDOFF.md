# Handoff

_Last updated: 2026-09-16 11:55 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 남은 코드 작업을 중간 재승인 없이 진행하길 원한다.
오픈소스 제품이므로 영업·이행·정산은 선택형 예제이고 제품 조직 구성이 아니다.
**Markdown KB/저장소 adapter, 지식 SDK, guarded generation**까지 구현·검증했다.
최신 요청은 Claude와 성능·보안·구조·사용성 리뷰다. `419a26d`를 검토했고 아래 개선 항목을 발견했다.
이번에는 리뷰 문서만 기록하며 런타임 수정은 하지 않았다.
운영 SSO/KMS 업체 선택을 개발 blocker로 다시 요구하지 않는다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 구현/리뷰 기준은 `419a26d`; 최종 문서 커밋은 `git log -1` 확인.
- **기본 제품 앱 http://127.0.0.1:4317**, Git 제외 `kcl.config.json`, `.data/workspaces/knowledge/local`.
  별도 가상 승인/문서를 만들지 않는2조직 설정이다. 최신 코드 재기동 후 health200/block1.
- 예제 앱도 최신 코드:4318 Fabric 가상 역할,4319 OIDC 통합/IdP4320,
  4321 영업/4322,4331 이행/4332,4341 정산/4342. health200/Fabric block206.
  `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement` 보존.
  재시작으로 개발 로그인 세션은 초기화됐다.
- 실제 네트워크는 Colima `colima`의3 peer·3 Raft orderer. 테스트 인증서 **2026-09-22 만료**.
  chaincode0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지.
  이번에는 chaincode 재배포·네트워크 초기화를 하지 않았다.
- UI 시험은 매번 임시 DB/포트에서 실행·종료한다. 이전4351 테스트 데이터는 `.data/configured-ui-20260916`에 보존.

## Commands

Node24를 사용한다. 기본 로그인 셸의 Node22는 프로젝트 실행용이 아니다.

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm start
npm run demo:kb
npm run kb:sync -- --server http://127.0.0.1:4317 --workspace knowledge --org OrgOneMSP --actor maintainer --root examples/markdown-kb --manifest examples/markdown-kb/manifest.json
npm run check
npm run check:types
npm run test:browser
```

- `config:init`은 새 설정 파일 생성, `npm start`는 `--config FILE` 또는 `kcl.config.json` 필요.
- 명시적인 예제는 `demo:web`, `demo:fabric`, `demo:login`; 기존 `start:fabric`/`start:login` 옵션 호환.
- configured Fabric 실행은 `--organization ORG_ID` 필수. 앱 개인키 없음, 외부 Unix signer 참조 사용.
- optional 브라우저 패키지 설치: `npm ci --prefix packages/browser-tests --ignore-scripts --no-fund` 후
  `node packages/browser-tests/node_modules/playwright/cli.js install chromium`.
- `test:performance -- --documents 1000 --samples 5 --body-bytes 1024`, `test:resilience`로 독립 로컬 실험.

## Latest Delivery

- `packages/connectors/source-contract.ts`, `filesystem-markdown.ts`: strict allowlist manifest,
  명시된 Markdown만 읽기. 링크/특수 파일/상위 경로/파일 교체·크기·UTF-8 검사.
  원본 내용을 정규화하지 않고 BOM·CRLF를 보존한다. 악의적인 동일 OS 프로세스의 완전한 sandbox를 뜻하지 않는다.
- `source-store.ts`, `PrivateStore`: actor별 source state, global version CAS, stable operation receipt,
  draft/state/receipt의 SQLite atomic write. present100개/합계16MiB, 파일256KiB, metadata 총200개 상한.
  원본 누락은 private 상태만 바꾸고 shared agreement를 철회하지 않는다.
- `apps/api/service.ts`, `server.ts`: manifest validation, sources list/detail/import/reconcile,
  shared `GET /revisions/{digest}`. 원본 path/hash는 private record에만 남고 게시 payload에는 넣지 않는다.
- `sync-markdown.ts`, `development-client.ts`, `tools/kb-sync.ts`: handshake 이후 파일 읽기,
  전체 snapshot 검사→누락 원본 표시→순차 변경 import→최종 reconcile. CLI는 counts만 출력.
  각 요청은 원자적이고 batch 전체 rollback은 아니다. 실패/CAS 충돌 때 자동 재시도하지 않는다.
- CLI handshake는 local-simulation만 허용한다. OIDC에는 로그인한 브라우저 업로드 또는 caller-owned
  authenticated transport를 사용한다. 개인 auth 파일·환경 토큰을 탐색하지 않는다.
- `packages/client/knowledge-client.ts`: Node24 client. origin/workspace 고정, 호출 측의 cookie/CSRF transport,
  strict JSON·2MiB·10초 기본 요청 한도·30초 신선도. full revision/digest/slot/manifest 확인.
- `guarded-generation.ts`: generate/release authorization 필수, 두 단계 직전 fresh revalidation,
  권한 거부·철회·변경·timeout이면 output 미반환. 기본120초/최대600초. 외부 모델/도구를 자동 호출하지 않는다.
  이미 모델에 전달된 본문을 회수하거나 callback의 외부 부작용을 취소하는 기능이 아니다.
- `tools/kb-demo.ts`, `examples/markdown-kb/`: 임시 로컬2조직 + 실제 HTTP + 허구의 담당자 승인 + callback stub 예제.
- `apps/web`: manifest/폴더 미리보기, allowlist 파일만 private sync, source 상세→초안 재개,
  업로드 전 형식 검사와 계정 변경/늦은 응답 차단. 현재 표시는 마지막 동기화 기준이다.
- [KB 가이드](docs/23-KB-SOURCE-CONNECTOR.md), [Node 클라이언트](docs/24-KNOWLEDGE-CLIENT.md), [검증 기록](docs/VALIDATION.md).

## Established Foundation

- 공통 결정적 엔진의 불변 본문·정확한 proposal/revision/slot/policy/epoch 승인·CAS·이의/철회·dependency·fence.
- Fabric VALID full-block projection·명령 outbox, OIDC 현재 인가·별도 signer·조직별 runtime scope.
- 설정 기반2/4조직 제품과 `examples/order-workflow` 분리, explicit seed, source/actor metadata.
- Markdown 단일 import·비공개 초안 재개·offline snapshot v1/v2/v3. 기존 DB에 source records를 추가했으며 파일 프로필 변경 없음.
- 내 요청 상태/polling/정확한 ID 재시도, exact revision 비교, 브라우저·성능·복원력 자동 검사.
- Claude Sonnet5 실제 디자인 검토는 완료된 상태다. [논의](docs/18-DESIGN-REVIEW.md), [DESIGN.md](DESIGN.md).
  전용키가 없을 때 scrubbed packet을 기존 구독 CLI에 전달했고 개인 인증파일·전역 설정을 건드리지 않았다.
  이 논의를 미완료로 되돌리거나 전용키를 다시 요구하지 않는다.

## Verification

- `npm run check`: **227 passed /0 failed /0 skipped**, `check:types`·`demo`·`demo:kb` 통과.
- 별도 source copy: **192 passed /0 failed /35 optional skipped**. 최종 SDK12개도 해당 copy에서 통과.
- `test:browser`: **Chromium9개 통과**. 기존 계정/원문/복구7개 + source allowlist/반복/변경/계정 전환 검사.
- `.data/configured-smoke-zv1THX/evidence.json`: 실제 VALID 게시192·승인194, source 상태·SDK exact revision,
  release authorization 중 철회 후 output 차단, v3 restore 뒤 source/draft/명령 보존.
- `.artifacts/kb-integration/{final-check,browser,no-optional-check}.log`, `demo.json.log`가 이번 근거.
- 이전 `.artifacts/experiments/performance-1000.json`:1KiB×1,000문서, search/overview p95 약247.59/249.07ms,
  replay 약262.15ms. 현재 장비의 로컬 측정이며 SLA가 아니다.
- 이전 `.artifacts/experiments/resilience.json`: 자식 process SIGKILL 복원/멱등성, snapshot, fixture503 회복.
- 실제 회사 source/SSO·모델 공급자·독립 호스트 장애/재해 복구·원격 CI는 검증하지 않았다.
  SDK의 binding 검증은 독립적인 Fabric quorum proof가 아니다.

## Authorization & Avoid

- 네트워크·공식 의존성·`.data/fabric-smoke/crypto` 테스트 키 생성/서명/사용 승인 재사용.
  개인 auth/.env/회사 키를 읽지 않는다. KB 테스트는 생성한 합성 파일과 저장소의 공개 예제만 사용했다.
- 사용자 `.serena/` 보존·커밋 제외. 원격 push/공개에는 명시적 요청 필요.
- 원장·인증서·genesis 재생성 금지. 최초 `fabric:smoke` 반복 금지. 후속 smoke는 새 합의 이력을 남기고 철회한다.
- DB backup은 앱 종료 후, restore는 새 폴더. WAL/SHM을 삭제해 검사를 우회하지 않는다.
- 서버 종료 전 PID와 실제 command를 대조한다. 개인 브라우저/세션을 탐색하지 않는다.

## Remaining / Resume

기능 구현 뒤 [Claude 공동 리뷰](docs/25-CLAUDE-REVIEW.md)에서 실제 코드 개선 항목을 확인했다.
**남은 일이 운영 설정뿐이라는 이전 요약은 더 이상 맞지 않는다.** 아직 고치지 않은 순서는 다음과 같다.

1. **R1/P1:** overview/search의 개정별 전체 history 중복·페이지 제한 없음. 같은 슬롯 200개 개정에서
   history 40,000개·JSON 16,811,761 bytes를 로컬 service로 재현했다. 요약/페이지/상세 분리가 필요하다.
2. **R2/P2:** 인증 전 healthz가 매번 Fabric refresh 큐를 사용. 모의 peer 40ms에서 익명 동시 8건이
   peer RPC 8회·순차 339ms였다. 외부 노출 시 제한, liveness/readiness 분리가 필요하다.
3. **R5/R6/P2:** 큰 manifest 선택 시 이전 선택으로 import 가능, source 21개부터 목록의 다음 페이지 접근 불가.
   실제 격리 Chromium에서 재현했다. 상태 무효화 순서와 source cursor UI가 필요하다.
4. **R3/P2:** service 명령 큐가 private sync도 기다리게 하고 Fabric은 별도 전역 큐를 사용.
   지연된 게시 뒤 private import 대기를 재현했다. CAS·멱등성·블록 순서를 지키며 잠금 범위를 줄여야 한다.
5. **R4/P2:** raw blocks/results/history를 전체 메모리 보관. 구조는 확인, 장기 heap/OOM은 미측정.
   이력/무결성 검사를 삭제하지 말고 순차 replay·디스크 검증 조회·제한된 캐시를 검토한다.

Claude의 requestTimeout 15초/handler 충돌, committed retry 재제출 주장은 오탐으로 제외했다.
Node24 국소 실험과 멱등성/재시작 테스트 2개 재실행 통과. `.artifacts/claude-review-419a26d/`에
정리된 패킷·실제 Claude 응답·probe·실행 JSON을 보관한다. 리뷰는 전체 침투 시험이나 운영 성능 인증이 아니다.

별도 도입 단계는 실제 기관의 인증 transport·모델 egress 정책/공급자 설정, 파일럿 운영과
독립 인프라 검증, 원격 공개/CI 확인이다.
SaaS별 KB connector·벡터 검색·운영 대시보드는 별도 확장 기능이며 이번 완료 주장에 포함하지 않는다.

재개: AGENTS.md/HANDOFF.md와 리뷰 문서를 읽고 요청한 수정 범위를 진행해.
KB/source/guarded-generation의 이전227개 검사·Chromium9개·실제Fabric 검증은 완료됐지만 위 리뷰 항목은 미수정이다.
기존 키·원장·.serena를 보존하고 운영 공급자 선택을 개발 blocker로 다시 요구하지 마. 원격 push는 명시적 요청이 있어야 한다.
