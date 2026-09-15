# Handoff

_Last updated: 2026-09-16 01:35 KST by Codex_

## Goal
- MIT 오픈소스 Knowledge Consensus Ledger(KCL). Hyperledger Fabric 위에서 부서별 해석과 사람의 명시적 지식 승인을 보존한다. 자체 인프라 합의 알고리즘은 만들지 않는다.
- 사용자는 남은 구현을 계속 진행하도록 요청했다. 영속 Fabric 웹 연결 다음으로 **개발 OIDC 로그인·권한 회수·별도 서명 프로세스**를 구현하고 실제 네트워크에서 검증했다.

## Current Status
- 루트 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 이번 변경의 기준 커밋은 `d49ff22`; 최종 로컬 커밋은 `git log -1` 확인.
- **최신 로그인 앱: http://127.0.0.1:4319**, IdP `http://127.0.0.1:4320`. `npm run start:login`으로 기동했고 데이터는 `.data/fabric-login`이다. 최신 healthz 200 / healthy / block 101, 익명 session은 actor null·personas 빈 목록이다.
- 기존 4318 Fabric 가상 역할 테스트 앱과 `.data/fabric-web`은 보존했다.
- Colima `colima` context의 3 peer·3 Raft orderer와 chaincode를 사용한다. 기본 Docker context는 바꾸지 않았다.
- 로그인 셸 Node 22 대신 설치된 Node 24.18.0을 사용한다:

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run start:login
```

## Authorization & Decisions
- 네트워크·공식 의존성 다운로드·`.data/fabric-smoke/crypto`의 테스트 CA/MSP/TLS 키 생성·서명·사용은 승인받았다. 같은 승인을 다시 묻지 않는다. 개인 인증파일·실제 회사 키는 읽지 않는다.
- **SSO/KMS 업체 이름을 사용자가 지금 정할 필요는 없다.** 개발 기본값을 에이전트가 정해 진행한다. 예전 제공자 질문을 미해결 blocker로 되살리지 않는다.
- 현재 IdP는 비밀번호 없는 고정 개발 계정 세 개이며 상태·로그인 키·토큰을 메모리에 둔다. 실제 회사 인증으로 표현하지 않는다.
- 별도 서명 프로세스는 승인된 테스트 키만 읽는다. API는 공개 인증서와 digest만 전달한다. 같은 OS 사용자 아래의 Unix socket 0700/0600은 HSM·클라우드 KMS·독립 조직 강제 격리의 대체가 아니다.
- 로컬 수정·검증·소유 파일 커밋은 승인 범위다. 원격 push/공개는 명시적 요청이 필요하다. 사용자 미추적 `.serena/`는 그대로 보존하고 커밋하지 않는다.

## Completed
- 불변 본문·정확한 proposal/revision/slot/policy/epoch/대표자 승인, CAS 채택, 이의·철회·dependency 규칙을 공유 도메인 엔진으로 유지한다.
- 공식 Fabric 2.5.16 / shim 2.5.8 / Gateway 1.12.1의 실제 VALID commit, MVCC INVALID 중복 복구, 응답 유실·재시작을 검증했다.
- SQLite full-block projection은 raw journal·상태·이력·cursor를 원자적으로 저장한다. 정확한 transaction-index fence, 손상 거부, 재시작 replay, HTTP pending202·신선도/연결503을 검증했다.
- OIDC code + S256 PKCE, 브라우저 결속 일회용 state·nonce와 ID-token 서명/issuer/audience/만료를 검사한다. opaque session cookie와 서버 메모리 토큰을 사용한다.
- 서버의 issuer/subject 바인딩만 human actor를 정한다. 요청 전후·Gateway proposal/endorse/submit 직전 계정·버전·세션·바인딩을 재검사한다. UI/API 가상 역할 전환은 로그인 모드에서 거부한다.
- 전송 전 권한 회수는 outbox `cancelled`로 끝내고 복구 조회에서 제외한다. 전송 후 상태 불명은 계속 복구한다. 로그아웃이 이미 커밋된 거래를 소급 취소하지 않는다.
- UserInfo 일시 오류/429는 세션을 유지하며503, 최종 인증까지30초를 넘긴 엄격 조회는503이다. 빈 인증 옵션은 시작 실패한다.
- 별도 서명 서비스는 고정된 세 User1 키의 인증서 쌍을 확인하고 SDK의 prehashed digest를 그대로 서명한다. framing·입력·연결 수·timeout을 제한한다.
- 로그인/로그아웃 UI와 익명 화면 초기화, 전역 HTML hidden 동작을 수정했다. 기본 로컬 시뮬레이션은 외부 패키지 없이 실행할 수 있다.

## Key Files & State
- `packages/auth/oidc.ts`, `types.ts`: 로그인 검증·세션/actor 계약. `development-issuer.ts`: 메모리 개발 IdP. 의존성은 해당 package/lockfile에 선택적으로 고정했다.
- `packages/fabric/remote-signer.ts`, `infra/fabric/signing-service.ts`: Unix socket signer client와 별도 프로세스.
- `apps/api/development-auth-runtime.ts`, `fabric-test-runtime.ts`: subject→actor→signer 연결과 write-phase 인가.
- `apps/api/server.ts`, `main.ts`, `apps/web/`: 인증 모드·CSRF·익명 상태·설정 검증.
- `tools/development-auth.ts`: 앱+개발 IdP 및 별도 signer child 기동/종료. `tools/auth-smoke.ts`: 실제 OIDC/Fabric 검증. `tools/oidc-test-browser.ts`: 토큰·cookie를 출력하지 않는 로컬 테스트 브라우저 helper.
- `packages/fabric/application-ledger.ts`, `sqlite-projection.ts`, `block-projector.ts`: 실제 VALID 명령·영속 full-block·원래 receipt 경계.
- `.data/auth-smoke-TLo2ny/auth-evidence.json`: 최신 로그인 실제 검증(게시94/승인96). 이전 HTTP 장애/재시작 근거는 `.data/fabric-http-smoke-X5cJOF/http-evidence.json`이다.
- `.data/fabric-smoke/`: 네트워크·deployment·테스트 인증서·기존 CLI 근거. 인증서는 2026-09-22 만료다. 생성 데이터·키·도구는 Git 제외다.
- Chaincode logical version0.1.0 / lifecycle sequence **2**, package ID `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157`. 이번 변경은 인증/Gateway 경계라 chaincode를 재배포하지 않았다.
- [개발 로그인](docs/13-DEVELOPMENT-LOGIN.md), [Fabric 웹](docs/12-FABRIC-WEB.md), [검증 기록](docs/VALIDATION.md), [구현 결정](docs/10-IMPLEMENTATION-DECISIONS.md).

## Verification
- `npm run check`: **112 passed / 0 failed / 0 skipped**, 설계 계약·문서 검사 통과.
- `npm run check:types`: TypeScript7.0.2 strict 통과. `erasableSyntaxOnly`로 Node native 실행 가능 구문을 유지한다.
- `npm run demo`: withheld → 두 승인 후 provided → dependency 철회 후 withheld 통과.
- 의존성·runtime 데이터 없는 별도 source copy의 `npm test`: **79 passed / 0 failed / 33 optional skipped**. issuer 테스트의 정적 import 문제를 수정하고 설치 환경의 해당5개도 재검증했다.
- `npm run auth:smoke`: 실제 로그인·subject 바인딩·비공개 초안·권한 회수, endorsement 뒤 로그아웃→submit 차단(추가 블록0), 취소 outbox 종료, signer 정지503→복구provided, 철회withheld 통과.
- auth 패키지 `npm audit`: 알려진 취약점0건. 원격 CI는 미실행이다.
- 브라우저 익명 accessibility snapshot: 로그인 링크 표시, 가상 역할·로그아웃·보호된 편집 영역 숨김 확인. UI JavaScript 구문 검사 통과. 이번 단계에 스크린샷 성공 주장은 하지 않는다.
- 독립 auth/signing 코드 검토에서 발견한 일시 오류 세션 처리와 취소 outbox를 수정하고 회귀·실제 네트워크에서 검증했다.

## Remaining Work
- 현재 개발 로그인 단계를 막는 사용자 결정은 없다. 실제 회사 계정·HTTPS 배포·조직별 vault/KMS·Fabric CA enrollment는 운영 연결 단계다.
- 다음 독립적인 개발 작업은 기존 repo/KB에서 **비공개 초안으로 가져오는 adapter 1개**다. 로컬 Markdown 입력부터 시작하면 외부 제공자나 비밀키 없이 공개 preview·사람 승인 경계를 이어갈 수 있다. 이 작업은 아직 구현하지 않았다.
- 조직별 runtime/vault 격리, backup restore/full replay 복구 목표, 독립 orderer/host 장애와 성능 측정, 외부 모델·embedding 연결도 남아 있다. P0–P3 운영 전체 완료로 표시하지 않는다.

## Avoid
- 공유 본문은 channel 운영자에게 보인다. private 원문·query·token을 원장/로그에 기록하지 않는다. returned 본문은 회수할 수 없다.
- 기존 원장·인증서·genesis를 재생성하지 않는다. 완료된 기존 `fabric:smoke`는 초기 조건이 달라 재실행하지 않는다. `fabric:http-smoke`와 `auth:smoke`는 새 fixture를 만들고 끝에 합의를 철회한다.
- chaincode 소스 변경 시에만 명시적 `fabric:upgrade`를 사용한다. SDK에는 정확한 getter 대소문자(`getCurrentblockhash_asU8`)를 사용한다.
- 테스트 키는 signer/test에서만 승인 경로로 읽고 개인 auth/.env 파일을 탐색하지 않는다. 브라우저 callback URL·cookie·bearer token을 출력하지 않는다.
- 성공한 검사는 입력이 바뀌거나 미해결 위험이 생기지 않으면 반복하지 않는다.

## Next Steps
1. Git 상태와 실행 필요 여부만 확인한다. 웹 상태는 `curl http://127.0.0.1:4319/healthz`로 점검한다. 로그인 세션은 프로세스 재시작 시 초기화된다.
2. 추가 계속 요청 시 개발 완료 근거를 재사용하고, 로컬 Markdown→비공개 초안 import adapter를 구체화·구현·검증한다. 자동 공개/자동 사람 승인은 넣지 않는다.
3. 운영 인증 연결을 진행할 때 실제 계정/제공자 설정과 적용 권한을 해당 범위에서 확인한다. 업체 미선택을 현재 개발 blocker로 되살리지 않는다.
4. 관련 필수 검증 후 소유 파일만 로컬 커밋한다. 원격 공개는 요청이 있을 때만 한다.

## Resume Prompt
이 저장소의 HANDOFF.md와 AGENTS.md를 읽고 남은 작업을 이어가. 실제 Fabric 영속 웹 API와 개발 OIDC 로그인·별도 서명·권한 회수 검증이 완료됐고 http://127.0.0.1:4319 에 로그인 앱을 띄웠다. 기존 네트워크·테스트 키 승인을 재사용하고 SSO/KMS 업체 선택을 다시 개발 선행 조건으로 묻지 마. 다음은 로컬 Markdown을 비공개 초안으로 가져오는 KB adapter부터 진행해. 기존 원장/인증서와 사용자 .serena 변경을 보존하고 실제 회사 인증이나 HSM 완료로 표현하지 마.
