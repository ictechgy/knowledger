# Handoff

_Last updated: 2026-09-15 15:02 KST by Codex_

## Goal
- MIT 오픈소스 **Knowledge Consensus Ledger(KCL)**: 부서/사람별 도메인 해석을 보존하면서 공동 업무에 사용할 지식을 명시적으로 합의한다. KB·LLM 위키 모두 대상이며 도입 편의성이 핵심이다.
- 사용자는 **Hyperledger Fabric 사용을 확정**했다. Microsoft Fabric이 아니며 자체 분산 합의 알고리즘 개발은 범위 밖이다.

## Current Status
- 루트: `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, 브랜치 `main`.
- 인수인계 작성 기준 커밋: `f475b3c`(Fabric 채택 확정). 작업 시작 시 Git 트리는 깨끗했다. 이번 변경은 `AGENTS.md` 정리와 이 인수인계 문서이며 최종 커밋은 `git log -1`로 확인한다.
- **실행 가능한 로컬 개발 알파 + Fabric adapter 소스**다. 실제 Fabric 네트워크·운영 인증·분산 장애 검증은 아직 없다.
- 2026-09-15 15:02 KST에 `http://127.0.0.1:4317/healthz` 정상 응답(`local-simulation`, `kcl-demo`)을 확인했다. 다음 세션에서도 계속 실행 중이라고 가정하지 않는다.
- 로컬 실행 `npm start`, 독립 시나리오 `npm run demo`, 검사 `npm run check`. 기본 데이터 `.data/demo`; 새 체험은 `npm start -- --port 4318 --data .data/new-demo`로 기존 데이터를 보존한다.

## Completed
- 전체 Markdown snapshot과 metadata를 묶은 불변 개정본, 명시적 공개 미리보기, actor별 비공개 초안.
- 정확한 proposal/revision/전체 SlotKey/policy/epoch/대표자에 묶인 승인, CAS 채택, 이의·기권·승인 철회 시 정지, 새 제안으로 재승인, 전이 의존성 검사.
- SQLite journal·시점별 projection 재생, 원자적 명령, 원래 commit 위치를 유지하는 멱등 재시도, 엄격한 상태 구조·참조 검증.
- 검토 UI, 범위별 검색·resolver·manifest 출력·재검증. 초안/manifest는 공유 journal 밖에 둔다.
- 실제 도메인 엔진을 사용하는 Fabric shim/Gateway 경계, 영속 outbox 복구, 독립 chaincode 패키지 빌드. SDK/shim 호출은 주입한 테스트 경계에서 검증했다.

## Key Files & State
- `packages/domain/index.ts`: 공통 엔진, `execute`, `bootstrap`, `resolveAt`, `validateAgreementApprovals`, `keyFor`, canonicalization.
- `packages/storage/`: 로컬 journal·시점 조회, 불변 상태/참조 검증, private records. `apps/api/service.ts`: 공개/명령/resolver 조립.
- `apps/api/demo-config.ts`: 고정된 가상 3조직·3도메인과 교차 규칙. `apps/api/server.ts`: loopback 전용 가상 세션·CSRF/출처 검사.
- `apps/web/`: 전체 SlotKey별 검토 UI, 최신 승인 표시, 공개 snapshot, manifest 출력. 가상 persona 전환은 실제 인증이 아니다.
- `packages/fabric/`: signer 주입·인증된 MSP/actor 확인, VALID commit·멱등 복구. `infra/fabric/`: genesis·entrypoint·빌드·공식 peer 패키징 경로.
- [실행 범위/API](docs/11-RUNTIME.md), [검증 근거](docs/VALIDATION.md), [채택 결정](docs/10-IMPLEMENTATION-DECISIONS.md), [Fabric 통합](infra/fabric/README.md).

## Important Context / Decisions
- Facts: 공유 **문서 본문까지** 원장에 기록하고 참여 노드에 복제한다. 부서 기밀 원문·초안은 부서 vault에 남긴다. API ACL이 channel 운영자에게 평문을 숨겨주지는 않는다.
- Facts: 부서/조직과 bounded context는 별개다. `(channel, document, context, scope, usage_scope)` 단위로 채택하며 서로 다른 해석을 하나의 정의로 덮지 않는다.
- Facts: 사람의 의미 합의와 노드의 거래 합의는 별개다. 옛 승인 재사용·AI 자기 승인·과거 prompt 회수 보장을 허용하지 않는다.
- Facts: 공유 엔진을 유지한다. 로컬 원장은 **블록당 거래 한 개**이며 Fabric의 동일 블록 내 fence/철회 검증을 대체하지 않는다. 조직 가입·정책은 v0.1에서 고정한다.
- Facts: 사용자에게 로컬 수정·검증·커밋과 리서치 검색은 승인받았다. 원격 공개/push는 별도 지시가 필요하다. 시크릿 가능성이 있는 `.env`·인증파일·키스토어 등을 승인 없이 읽거나 수정하지 않는다.
- Assumptions: 운영의 CFT/BFT 신뢰 모델과 실제 조직별 관리 경계는 파일럿에서 확정한다. 초기 참조안은 3-orderer Raft CFT이며 BFT는 독립 4-orderer 별도 단계다.

## Verification
- 기존 근거 재사용: Node 26.5.0 / Python 3.14.7에서 `npm run check` **56 passed, 0 failed**; `npm run demo`는 `withheld → provided → dependency 철회 후 withheld` 통과. 이후 `7403954..f475b3c` 변경은 README/결정 문서뿐이었다.
- 기존 근거: `node infra/fabric/build.mjs`, 생성 entrypoint 구문/모듈 로딩, 공식 peer 패키징 shell 구문 검사 통과. 실제 `peer` 패키징·설치·커밋은 미실행.
- 기존 UI 근거: agent-browser로 승인·개정·공개·조회 흐름 확인, Chrome/CDP로 1440px/390px 캡처 확인. 로컬 `.artifacts/kcl-verified-*.png`는 Git에 없는 보조 자료다.
- 이번 문서 작업: bundled AGENTS audit 전후 비교, 원래 8개 규칙 보존 확인, 로컬 링크·marker·문서 구문 검사. 런타임 코드는 변경하지 않는다.

## Blockers & Open Questions
- 공개 npm/Go/GitHub/Docker Hub/GHCR 의존성 다운로드에 대한 이전 질문은 명시적 답변 기록이 없다. Fabric 기술 선택은 확정되었다. 네트워크 작업 전 기존 승인 범위와 필요한 다운로드를 구분하고, 승인된 범위를 다시 묻지 않는다.
- 현재 Node 26.5.0, Docker client 29.5.3 사용 가능. `peer` 없음, Docker daemon 정지. `/opt/homebrew/bin/colima`는 **설치되어 있으나 정지** 상태다. 이전 검사에서 Go도 없었다.
- `fabric-shim@2.5.8`, `@hyperledger/fabric-gateway@1.12.1`은 manifest 고정만 했고 다운로드/실행/전이 의존성 lockfile 검증은 하지 않았다. 실제 SDK 실행·정적 타입 검사·원격 CI도 미실행이다.
- TLS/CA/MSP, 실제 네트워크, full-block VALID write-set projector, SSO/KMS, 외부 KB/embedding/model 연결 및 성능 검증이 남아 있다. `.data`/`.artifacts`의 생성 데이터나 키를 커밋하지 않는다.

## What Worked
- 공통 도메인 엔진 재사용, 실패 경로를 먼저 재현하는 테스트, 작은 커밋, 별도 검토로 승인 포인터·manifest·원래 receipt·projection 참조 오류를 찾고 보강했다.

## What Did Not Work / Avoid
- 주입한 SDK 테스트와 모의 MVCC만으로 실제 Fabric 연동 완료를 주장하지 않는다. raw tar를 Fabric lifecycle package로 취급하지 말고 공식 `peer lifecycle chaincode package`를 사용한다.
- agent-browser 캡처는 daemon `os error 35`로 실패했다. DOM 조작은 가능했고 캡처는 격리된 Chrome/CDP로 대체했다. 개인 Chrome 프로필·쿠키를 읽지 않는다.
- 기록된 SQL/계약을 임의로 약화하거나, 사용자 채택 결정을 다시 열어 자체 합의 알고리즘 구현부터 시작하지 않는다.

## Next Steps
1. Git 상태·현재 승인 범위·설치 도구를 확인하고 **실제 Fabric 통합**을 준비한다. 버전·image digest·genesis/MSP/인증서 actor 속성의 일치를 먼저 확인한다.
2. 허용된 의존성을 설치하고 lockfile/라이선스를 검토한다. `node infra/fabric/build.mjs` 후 공식 peer CLI로 package/install/approve/commit한다. 기존 개인 인증파일 대신 검토한 테스트 환경을 사용한다.
3. 실제 peer에서 원문 게시 → 조직별 승인 → 채택 → 조회 → 철회와 outbox 재시작/응답 유실/중복 INVALID 복구를 검증한다. ACK와 VALID를 구분한다.
4. Fabric full-block projector·동일 블록 fence·운영 권한 경계를 연결한다. 문서/도구 설치 상태만으로 P0–P3 운영 완료를 표시하지 않는다. 단계별 검증 결과와 커밋을 기록한다.

## Resume Prompt
`/Users/jinhongan/Desktop/knowledge-consensus-ledger`에서 `HANDOFF.md`와 적용되는 `AGENTS.md`를 읽고 Git 상태를 확인해. Hyperledger Fabric 채택 결정을 유지하며, 실제 Fabric 네트워크 통합의 도구·버전·기존 승인 범위를 먼저 확인하고 승인된 준비 작업부터 이어가. 실제 peer의 VALID 커밋 검증과 로컬 모의 원장 검증을 구분하고, 검증된 단위로 커밋해.
