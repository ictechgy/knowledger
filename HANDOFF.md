# Handoff

_Last updated: 2026-09-16 02:35 KST by Codex_

## Goal & Working Style
- MIT Knowledge Consensus Ledger(KCL). Hyperledger Fabric 위에서 부서별 해석과 사람의 명시적 승인을 보존한다. 자체 인프라 합의 알고리즘은 만들지 않는다.
- 사용자는 **남은 코드 작업을 단계마다 재확인하지 말고 계속 진행**하도록 요청했다. 이번에는 비공개 초안 목록·다시 열기·수정 재시도와 로컬 앱 DB 백업·복원을 함께 완료했다.
- 운영 SSO/KMS 업체 이름은 개발 선행 조건이 아니다. 개발 기본값을 에이전트가 선택해 진행하며 예전 업체 질문을 blocker로 되살리지 않는다.

## Current Status
- 루트 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 이번 기준 커밋은 `8c66bbf`; 최종 커밋은 `git log -1` 확인.
- **최신 앱: http://127.0.0.1:4319**, 개발 IdP4320. `npm run start:login`으로 최신 코드를 기동했다. 데이터 `.data/fabric-login`, healthz200 / healthy / block119. 재시작으로 로그인 세션은 초기화했다.
- 기존4318 Fabric 가상 역할 앱과 `.data/fabric-web`은 보존했다. 별도4321 UI 테스트 서버와 격리 브라우저는 종료했다.
- Colima `colima` context의 3 peer·3 Raft orderer를 사용한다. 기본 Docker context는 바꾸지 않았다.
- 로그인 셸 Node22 대신 설치된 Node24를 사용한다:

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run start:login
```

## Authorization & Boundaries
- 네트워크·공식 의존성 다운로드·`.data/fabric-smoke/crypto` 테스트 CA/MSP/TLS 키 생성·서명·사용은 승인받았다. 같은 승인을 다시 묻지 않는다. 개인 인증파일·실제 회사 키는 읽지 않는다.
- 로컬 수정·검증·소유 파일 커밋은 승인 범위다. 원격 push/공개는 명시적 요청이 필요하다.
- 사용자 미추적 `.serena/`는 그대로 보존하고 커밋하지 않는다. 생성 데이터·키·도구·snapshot은 `.data`/`.tools`/`.artifacts`에 두고 Git에서 제외한다.
- IdP는 비밀번호 없는 개발 계정3개·메모리 상태다. 별도 signer는 같은 OS 사용자 아래의 테스트 키 프로세스이며 HSM/클라우드 KMS/독립 기관 격리가 아니다.
- 공유 본문은 channel 운영자에게 보인다. private 원문·query·token·원본 파일 hash를 공유 거래에 자동 첨부하지 않는다. 반환된 본문은 회수할 수 없다.

## Completed
- 불변 전체 본문, 정확한 proposal/revision/slot/policy/epoch/대표자 승인, CAS 채택, 이의·철회·dependency 규칙을 공통 도메인 엔진으로 유지한다.
- 공식 Fabric2.5.16 / shim2.5.8 / Gateway1.12.1의 실제 VALID commit, MVCC INVALID 중복 복구, 응답 유실·재시작을 검증했다.
- SQLite full-block projection의 원자적 raw/state/history/cursor, exact transaction-index fence, 손상 거부·replay, HTTP pending202·실패503을 구현했다.
- OIDC code/PKCE/state/nonce·ID-token 서명/issuer/audience/만료, issuer/subject→human actor 바인딩, 요청 전후·각 write-phase 재인가. 전송 전 권한 회수는 outbox cancelled, 실제 전송 후 상태 불명은 복구한다.
- Markdown import는 UTF-8·256KiB·basename 검증, BOM/CRLF 보존, actor/import_id 멱등성, private provenance를 제공한다. 가져오기·preview는 원장에 쓰지 않는다.
- **내 비공개 초안**: 본인 제목·작성일·출처·개수의 페이지 목록, 다시 열기, 원본을 보존하는 수정본. 문서ID·slot·의존성·공유 parent를 유지한다. edit_id 동시/재시작 재시도는 같은 결과, 변경 요청409다.
- 목록은 expression index와 bounded SQL JSON projection을 사용한다. startup 전체 body 로드/별도 목록 복제/index 재생성을 하지 않는다. 잘못된 저장 revision·author binding·import provenance는503이다.
- UI는 새로고침 후 재개, 저장 후 변경이 없으면 저장 비활성, 편집 시 preview 초기화, 계정 변경/닫기 후 늦은 목록·본문 응답 무시를 제공한다.
- **앱 종료 후 DB 백업/복원**: 정확한 local2개/Fabric5개 DB 프로필, 파일당512MiB 한도, hash/stat·SQLite integrity 검증, 새 대상 독점 확보, 파일/디렉터리 flush,0600/0700. 키·인증서·세션은 복사하지 않는다.

## Key Files
- `packages/storage/private-store.ts`: actor별 metadata page query와 additive expression index. `apps/api/service.ts`, `server.ts`: list/detail/edit API·저장 계약·인가.
- `packages/import/markdown.ts`: UTF-8/base64/파일명 검증. 재조회도 같은 파일명 검증을 사용한다.
- `packages/storage/runtime-snapshot.ts`, `tools/runtime-snapshot.ts`: offline snapshot/restore와 CLI. `npm run data:backup`, `npm run data:restore`.
- `packages/auth/oidc.ts`, `development-issuer.ts`, `apps/api/development-auth-runtime.ts`: 개발 로그인·subject 바인딩.
- `packages/fabric/remote-signer.ts`, `infra/fabric/signing-service.ts`: Unix socket signer.
- `packages/fabric/application-ledger.ts`, `sqlite-projection.ts`, `block-projector.ts`: peer VALID와 원래 receipt/replay 경계.
- `tools/auth-smoke.ts`: import·초안 재개·승인·철회 뒤 앱 종료→백업→새 폴더 복원→재로그인까지 실제 검증.
- [초안 재개](docs/15-PRIVATE-DRAFTS.md), [백업 복원](docs/16-RUNTIME-BACKUP.md), [가져오기](docs/14-MARKDOWN-IMPORT.md), [개발 로그인](docs/13-DEVELOPMENT-LOGIN.md), [검증 기록](docs/VALIDATION.md).

## Evidence & State
- `npm run check`: **140 passed / 0 failed / 0 skipped**, 설계 계약·문서 검사 통과.
- `npm run check:types`: TypeScript7.0.2 strict 통과. `npm run demo`: withheld→provided→dependency 철회 withheld 통과.
- 외부 패키지·runtime 없는 별도 source copy `npm test`: **107 passed / 0 failed / 33 optional skipped**.
- `EXPLAIN QUERY PLAN`: 실제 private page SQL이 `private_draft_actor_order`를 사용하고 임시 정렬 없음. 운영 성능 SLA 측정은 아니다.
- `.data/auth-smoke-LeU5Zr/auth-evidence.json`: 최신 실제 검증. 명시적 게시/승인 VALID block111/113, 권한 회수·취소 outbox·서명 장애 복구·철회 통과.
- `.data/auth-snapshot-8221ca3a`→`.data/auth-restored-8221ca3a`: 앱 DB 복원 뒤 projection checkpoint 일치, 재로그인·원본/수정 초안·edit 재시도·withheld 검증. 네트워크/CA/키 전체 재해 복구의 증거가 아니다.
- `.artifacts/private-drafts/ui-evidence.json`: 브라우저 저장/재개/원본 보존·actor 전환·지연된 이전 목록 차단·키보드 조작,390/1440px 가로 넘침 없음. 스크린샷은 하지 않았다.
- 이전 실제 HTTP peer 정지/재시작 근거는 `.data/fabric-http-smoke-X5cJOF/http-evidence.json`이다.
- `.data/fabric-smoke/`: network/deployment/테스트 인증서/이전 CLI 근거. 인증서는 **2026-09-22 만료**다.
- Chaincode version0.1.0 / sequence2, package `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157`. 이번 앱/storage 변경에는 chaincode 재배포가 필요 없었다.

## Remaining Work
- 이번 초안·앱 데이터 복구 단계에 미완료 구현/검증은 없다. 실제 회사 계정·HTTPS 운영 연결, 조직별 runtime/vault/KMS/Fabric CA, 독립 host/orderer 장애, 전체 인프라 백업·RTO/RPO·규모별 성능, 외부 모델/KB 서비스 연결은 후속 운영·통합 범위다.
- P0–P3의 운영 전체 완료로 표시하지 않는다. 현재 DB snapshot은 앱을 종료한 로컬 복구 도구이며 운영 암호화/원격 백업과 네트워크 자체 복원은 별도다.
- 원격 CI/배포/push는 실행하지 않았다. 사용자 업체 선택이나 개인 auth 파일을 개발 코드의 선행 조건으로 다시 요구하지 않는다.

## Avoid / Resume
- 기존 원장·인증서·genesis를 재생성하지 않는다. 완료된 예전 `fabric:smoke`는 초기 조건이 달라 재실행하지 않는다. `fabric:http-smoke`/`auth:smoke`는 새 fixture를 만들고 합의를 철회한다.
- DB backup 전 앱을 정상 종료한다. WAL/SHM/journal 파일을 삭제해 검사를 우회하지 않는다. restore는 존재하지 않는 새 폴더에만 한다.
- Fabric events limit은 최대1000 blocks다. smoke는 게시 block 한 개를 조회한다. 과거 실패 검사의 미승인 게시본(block102)은 불변 테스트 이력으로 남겼다.
- 종료할 서버는 lsof와 실제 command를 대조해 작업 소유 프로세스만 SIGTERM한다. 개인 브라우저/session 파일을 탐색하지 않는다.
- 검증된 동일 입력의 검사는 반복하지 않는다. 추가 구현은 목표·확인 가능한 완료 기준을 잡아 진행하고 외부 운영 설정은 필요한 시점에만 다룬다.

## Resume Prompt
HANDOFF.md와 AGENTS.md를 읽고 이어가. Fabric 웹·개발 OIDC·Markdown 가져오기·비공개 초안 목록/재개·앱 DB 백업/복원까지140개 테스트와 실제 Fabric 복원 검증을 완료했고 http://127.0.0.1:4319 에 최신 앱을 띄웠다. 이미 완료된 단계를 되풀이하지 말고 다음 운영/통합 범위의 구체적인 코드 작업을 정해 계속해. 기존 네트워크·테스트 키 승인을 재사용하고 SSO/KMS 업체 선택을 개발 선행 조건으로 다시 묻지 마. 기존 원장/인증서·사용자 .serena 변경을 보존하고 운영 전체 완료로 과장하지 마.
