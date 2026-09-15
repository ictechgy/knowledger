# Handoff

_Last updated: 2026-09-16 05:01 KST by Codex_

## Goal

MIT 지식 합의 원장. 사용자는 남은 코드 작업을 자율적으로 진행하고 웹 디자인은 Claude와 상의하라고 했다.
**오픈소스 제품은 영업·이행·정산에 종속되지 않아야 한다.** 세 부서는 선택형 주문 업무 예제다.
이번에는 범용 설정 실행·예제 분리·복원·UI 통합을 완료했다. 운영 SSO/KMS 업체 선택은 개발 blocker가 아니다.

## Current Status

- 저장소 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 작업 기준 `83e1a53`; 최종 커밋은 `git log -1` 확인.
- **기본 제품 앱: http://127.0.0.1:4317**. `npm run config:init`으로 생성한 Git 제외 `kcl.config.json` 사용.
  `demo:false`,2조직, 초기 문서0·제안0. 데이터 `.data/workspaces/knowledge/local`.
- 기존 예제 앱도 최신 코드로 재기동:4318 Fabric 가상 역할,4319 OIDC 통합/IdP4320,
  4321 영업/IdP4322,4331 이행/IdP4332,4341 정산/IdP4342. healthz200·Fabric block183 확인.
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

## Verification

- `npm run check`: **178 passed /0 failed /0 skipped**, 설계/문서 검사 통과. `check:types`, `demo` 통과.
- 별도 source copy(외부 패키지·runtime 없음): **143 passed /0 failed /35 optional skipped**.
  마지막 local snapshot 재기동·legacy channel 검사13개도 해당 copy에서 통과.
- `configured:smoke`: 실제 기존3조직 네트워크에 새 JSON 설정/OIDC/generic signer를 연결.
  VALID 게시159·승인161, 등록되지 않은 subject·브라우저 역할 변경 거부, 다른 조직의 nonexistent 인증서 미열람,
  활성/제공·철회/보류·v3 복원 뒤 private 초안·상태 확인.
  근거 `.data/configured-smoke-IUrZJI/evidence.json`.
- 예제 회귀: `.data/organization-smoke-WZUdAW/organization-evidence.json`의 게시167·별도 앱3개·조직 scope 복원;
  `.data/auth-smoke-2ME3X7/auth-evidence.json`의 게시175·승인177·권한 회수·전송 전 취소·signer 복구·v1 복원.
- 브라우저:2조직 초안→게시→승인→활성→제공, 계정 변경 시 private 목록 제거, 같은 문서의 새 개정이 있어도
  검토함은 정확한 과거 제안 본문 표시.390/600/1440px DOM 가로 넘침 없음·600px 목록1열·navigation focus 확인.
  `.artifacts/configuration/ui-evidence.json`와 `exact-review-check.js`.
- 일부 agent-browser native click이 반영되지 않아 DOM 이벤트로 확인했다. screenshot 명령이 응답하지 않아 종료했다.
  스크린샷 비교나 전체 접근성 인증을 완료했다고 주장하지 않는다.
- 실제 물리적2/4조직 Fabric 네트워크와 운영 SSO/KMS/독립 호스트는 검증하지 않았다. 원격 CI·push도 실행하지 않았다.

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

이번 범용화와 선택형 예제 분리의 코드 작업은 완료했다. 남은 별도 범위는 원격 공개/CI 확인,
외부 KB·모델 통합, 운영 배포와 전체 인프라 복원/장애/성능 검증, 시각적 세부 조정이다.
요청이 없는데 업체 선택이나 운영 인프라 구축을 새로운 blocker로 만들지 않는다.
공개가 요청되면 현재 커밋·README·CI 상태를 확인하고 해당 범위만 진행한다.

## Resume Prompt

이 저장소의 HANDOFF.md와 AGENTS.md를 읽고 이어가. 특정 세 부서는 examples/order-workflow로 분리됐고,
설정 기반 제품은4317에서 빈2조직 workspace로 실행 중이다.178개 검사와 실제 configured/예제 Fabric·복원 검증이 완료됐다.
사용자는 오픈소스 제품을 원하며 승인된 코드를 자율적으로 진행하길 원한다. 완료된 작업을 반복하지 말고
새 요청 범위를 처리해. 기존 원장·키·.serena를 보존하고 원격 push는 명시적 요청이 있어야 한다.
