# Handoff

_Last updated: 2026-09-16 09:48 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 남은 코드 작업을 자율적으로 진행하고 웹 디자인은 Claude와 상의하라고 했다.
**오픈소스 제품은 영업·이행·정산에 종속되지 않아야 한다.** 세 부서는 선택형 주문 업무 예제다.
범용 설정 다음으로 요청 추적·개정 비교·브라우저 회귀·성능/장애 시험 자동화를 완료했다. 운영 SSO/KMS 업체 선택은 개발 blocker가 아니다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 작업 기준 `7d00d47`; 최종 커밋은 `git log -1` 확인.
- **기본 제품 앱: http://127.0.0.1:4317**. `npm run config:init`으로 생성한 Git 제외 `kcl.config.json` 사용.
  `demo:false`,2조직, 초기 문서0·제안0. 데이터 `.data/workspaces/knowledge/local`.
- 기존 예제 앱도 최신 코드로 재기동:4318 Fabric 가상 역할,4319 OIDC 통합/IdP4320,
  4321 영업/IdP4322,4331 이행/IdP4332,4341 정산/IdP4342. healthz200·Fabric block191 확인. 새 revision-diff.js도 모두200 확인.
  각각 `.data/fabric-web`, `.data/fabric-login`, `.data/fabric-sales`, `.data/fabric-fulfillment`, `.data/fabric-settlement` 보존.
  재시작으로 로그인 세션은 초기화됐다.
- UI 시험용4351 서버·격리 브라우저는 종료했다. `.data/configured-ui-20260916`은 시험 데이터로 보존.
- Colima `colima`의3 peer·3 Raft orderer. 인증서는 **2026-09-22 만료**.
  chaincode logical0.1.0/sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157` 유지. 재배포하지 않았다.

## Commands

Node24를 명시적으로 사용한다. 로그인 셸의 Node22는 프로젝트 실행용이 아니다.

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm start
npm start -- --config examples/config/four-organizations.json --data .data/research --port 4361
npm run demo:web
npm run demo:login
npm run check
npm run check:types
npm run demo
```

- `config:init`은 기존 파일을 덮어쓰지 않는다. `--organization` 반복, `--workspace`, `--output`을 지원한다.
- `npm start`는 `--config FILE` 또는 현재 폴더의 `kcl.config.json`이 필요하다. 암묵적 demo seed 없음.
- `demo:web`, `demo:fabric`, `demo:login`은 명시적인 주문 예제다. 기존 `start:fabric`/`start:login` 명령과 옵션은 유지한다.
- Fabric 설정 실행은 `--organization ORG_ID` 필수. local-development는 단일 개발 프로세스와 계정 전환이며 독립 조직 운영이 아니다.
- `node infra/fabric/build.mjs --config FILE --output DIR` 또는 `--demo`로 패키징한다.
- signer는 `node infra/fabric/signing-service.ts --config KEY_REFS_JSON --socket ABSOLUTE_PATH`; 앱에는 개인키가 없다.

## Completed & Key Files

- `packages/config/{types,project,template}.ts`: workspace·org·identity·역할·정책·OIDC·Fabric 참조의 엄격한 JSON 검증,
  외부 파일 경로의 상대 해석, authority digest,2/4조직 템플릿. 연결 참조를 해석할 뿐 validator가 파일을 읽지는 않는다.
- `apps/api/{configured-runtime,configured-fabric-runtime,main,server,service}.ts`: 명시적 초기 구성,
  workspace별 API 경로, org+actor 계정 선택, 선택 조직 subject/cert/peer/signer/outbox만 사용,
  HTTPS public origin 뒤 loopback listener의 Host/Origin 검증. forwarded headers를 신뢰하지 않는다.
- `examples/order-workflow`: 기존 seed·genesis·founder·조직 descriptor·키 선택·계정·실행·네트워크 예제.
  core apps/packages에는 고정 세 조직명이나 kcl-demo 채널이 남아 있지 않다.
- `packages/fabric/chaincode.ts`, `infra/fabric/build.mjs`: 허용 조직을 pinned registry에서 도출하고 설정의 genesis/founder만 패키징.
- `packages/storage/configuration-scope.ts`: `project-binding.json`에 workspace/channel/authority/선택 조직/정확한 DB 목록을 고정.
  기존 DB 자동 채택·설정 변경·다른 조직·demo downgrade 거부. 라벨과 연결 참조는 별도 교체 가능.
- `packages/storage/runtime-snapshot.ts`: configured-local/configured-fabric의 version3 백업·복원. 기존v1/v2 유지.
  복원 manifest.json을 scope 검사에 허용하되 authority는 binding에만 둔다.
- `apps/web`: 설정 라벨, 정책 기반 작성 범위, 검토함/문서·초안/컨텍스트 내비게이션, 정확한 proposal revision 선택,
  기술 증거 접기, 작은 작업 제목,760px 이하 세로 목록. 기존 private draft·pending·CSRF 경계 보존.
- [범용 설정 가이드](docs/19-PROJECT-CONFIGURATION.md), [구현 결정](docs/10-IMPLEMENTATION-DECISIONS.md), [검증 기록](docs/VALIDATION.md).
- 기존 불변 본문·승인 binding·이의/철회·CAS·dependency·fresh fence·outbox·full-block projection·Markdown import·초안 재개 기능 유지.

## Latest Delivery

- `apps/api/service.ts`, `server.ts`: `GET /commands`, `GET /commands/{id}`, `POST /commands/{id}/retry`.
  actor별 private 명령 목록·상태·원래 ID/본문/시각을 보존한 명시적 재시도. 모든 기존 인가·CSRF 유지.
- `PrivateStore.commandPage`와 additive index. 기존 private DB 자동 호환, 별도 DB 파일 추가 없음.
- `FabricGatewayTransport.observeCommand`는 bounded outbox 시도/peer 상태를 확인하며 ledger에 제출하지 않는다.
  관측 상태를 로컬 SQLite에 캐시할 수 있다. SDK VALID·ACK만으로 성공하지 않으며
  `FabricApplicationLedger`의 검증된 원래 idempotency receipt가 완료 판단을 결정한다.
- `apps/web`: 내 요청·5–30초 bounded polling·정확한 ID 재시도·중복 클릭/이전 계정 응답 보호.
  `revision-diff.js`: 같은 slot의 부모/이전 개정, 제목·본문·줄바꿈 bytes·dependency 조건 비교,
  20,000 LCS cells 초과 시 안전한 두 원문 표시. 모든 Markdown은 textContent.
- `packages/browser-tests`: 선택형 Playwright1.63.0 + Chromium7개. 새 임시 DB/포트만 사용.
  `npm ci --prefix packages/browser-tests --ignore-scripts --no-fund`,
  `node packages/browser-tests/node_modules/playwright/cli.js install chromium`, `npm run test:browser`.
- `tools/performance-smoke.ts`, `resilience-smoke.ts`, `tools/testing/resilience-worker.ts`:
  독립 임시 local-simulation 측정·강제 종료/복원·fixture peer503 자동화. 기존 폴더 보호.
  `npm run test:performance -- --documents 1000 --samples 5 --body-bytes 1024`, `npm run test:resilience`.
- [요청 추적](docs/20-REQUEST-TRACKING.md), [개정 비교·브라우저](docs/21-BROWSER-AND-REVISION-TESTS.md),
  [성능·장애 실험](docs/22-AUTOMATED-EXPERIMENTS.md). CI job 추가, 원격 실행은 별도.

## Verification

- `npm run check`: **197 passed /0 failed /0 skipped**, `check:types`·`demo` 통과.
- 별도 source copy: **162 passed /0 failed /35 optional skipped**.
- `npm run test:browser`: **Chromium7개 통과**. native 클릭·입력, 계정 격리, exact revision,
  390/600/1440px 넘침·focus, pending 재시작, 지연/503, stale401, 중복 클릭, 응답 유실 확인.
  이전 agent-browser native click 한계와 달리 이번 Playwright 검사는 실제 입력 API로 통과했다.
- `.data/configured-smoke-911QRl/evidence.json`: 실제 Fabric VALID 게시184·승인186,
  command history·원래 receipt 재시도·철회·v3 restore 후 이력/초안 보존.
- `.artifacts/experiments/performance-1000.json`:1KiB 문서1,000개·read5회,
  search/overview p95 약247.59/249.07ms, replay 약262.15ms. 로컬 측정이며 SLA가 아니다.
- `.artifacts/experiments/resilience.json`: 새 자식 process SIGKILL 후 복원/멱등성,
  offline snapshot/restore, fixture peer503/복구200 통과. 기존 network를 정지하지 않았다.
- `.artifacts/delivery/check.log`, `browser.log`, `no-optional-check.log`에 이번 실행 근거.
- 이전 실제 예제 회귀 근거는 `.data/organization-smoke-WZUdAW/organization-evidence.json`,
  `.data/auth-smoke-2ME3X7/auth-evidence.json`. 이번 실제 변경 경로는 configured smoke로 검증했다.
- 물리적2/4조직 Fabric, 운영 SSO/KMS, 독립 호스트 장애/복원, 원격 CI는 미검증.

## Claude Consultation

실제 Claude Sonnet5 검토는 이전 세션에서 완료했다. 화면3파일만 정리한90,917-byte 패킷,
SHA256 `39a5d4d123caa175b043ceb349f0652a5696a26176b3a0998f3f22a8f587053d`.
전용 packet-ask Claude 키가 없어 기존 구독 CLI에 scrubbed paste 패킷만 도구/MCP/세션 저장 없이 전달했다.
개인 인증파일이나 전역 설정을 바꾸지 않았다. [논의 기록](docs/18-DESIGN-REVIEW.md)과 [DESIGN.md](DESIGN.md)에 반영 범위를 기록했다.
다시 업체/전용 키를 요구하거나 Claude 논의를 미완료로 되돌리지 않는다.

## Authorization & Avoid

- 네트워크·공식 의존성 다운로드·`.data/fabric-smoke/crypto`의 테스트 CA/MSP/TLS 키 생성/서명/사용 승인 재사용.
  개인 인증파일·실제 회사 키는 읽지 않는다. 생성 데이터·키·도구는 Git 제외.
- 사용자 `.serena/` 보존·커밋 제외. 원격 게시에는 명시적 요청 필요.
- 기존 원장·인증서·genesis를 재생성하지 않는다. 최초 `fabric:smoke`를 반복하지 않는다.
  후속 smoke는 새 개정을 공유 이력에 남긴 뒤 합의를 철회한다.
- 앱 DB backup은 종료 후, restore는 새 폴더에만. sidecar를 삭제해 검사를 우회하지 않는다.
- 서버 종료 전 PID와 command를 대조한다. 개인 브라우저/세션을 탐색하지 않는다.

## Remaining / Next Steps

사용자가 승인한 다음4개는 코드와 검증까지 완료했다: 미확정 거래 추적, 개정 비교,
브라우저 자동 테스트, 성능·장애 실험 자동화. 전체 프로젝트의 모든 가능한 개발이 끝났다는 뜻은 아니다.
후속 확장은 외부 KB/저장소·모델 adapter이며, 운영 범위는 실제 배포·독립 호스트 장애/복원·성능 기준 확정이다.
원격 공개/CI 확인도 아직 하지 않았다. 불필요한 업체 선택을 개발 blocker로 만들지 않는다.

## Resume Prompt

HANDOFF.md와 AGENTS.md를 읽고 이어가. 범용2조직 제품은4317, 기존 Fabric 예제도 최신 앱 코드로 실행 중이다.
사용자가 요청한4개 코드 항목(요청 추적·개정 비교·브라우저·성능/장애 자동화)은197개 단위/통합 검사,
Chromium7개와 실제Fabric command 조회/재시도로 확인했다. 남은 확장과 운영 검증을 구분하고
완료된 작업을 반복하지 마. 키·원장·.serena를 보존하며 원격 push는 명시적 요청이 있어야 한다.
