# Handoff

_Last updated: 2026-09-15 18:12 KST by Codex_

## Goal
- MIT 오픈소스 Knowledge Consensus Ledger(KCL). Hyperledger Fabric을 사용하며, 도메인별 해석과 사람의 명시적 지식 승인을 보존한다. 자체 분산 합의 알고리즘은 범위 밖이다.
- 실제 Fabric 네트워크, 영속 projection, 웹 API 연결과 재시작·실패 경로 검증까지 완료했다. 운영 제공자 연결은 다음 단계다.

## Current Status
- 루트 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 이번 작업 시작 커밋은 `3f1f7cb`; 최종 커밋은 `git log -1` 확인.
- **웹 앱 실행 중: http://127.0.0.1:4318** — 실제 Fabric에 연결된 `fabric-test-network` 가상 사용자 모드. 데이터는 `.data/fabric-web`.
- Colima `colima` context의 3 peer·3 Raft orderer와 chaincode가 실행 중이다. 기본 Docker context는 바꾸지 않았다.
- 네트워크·공식 의존성 다운로드·`.data/fabric-smoke/crypto` 테스트 CA/MSP/TLS 키 생성·서명·사용은 모두 승인받았다. 같은 승인을 다시 묻지 않는다.
- 기존 미추적 `.serena/`는 사용자 변경으로 보존했고 커밋하지 않는다.
- 로그인 셸 Node 22 대신 설치된 Node 24.18.0을 사용한다:

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
npm run start:fabric
```

## Completed
- 전체 Markdown 불변 개정본, actor별 비공개 초안/preview, proposal/revision/SlotKey/policy/epoch/대표자에 묶인 승인과 CAS 채택, 이의·철회·dependency resolver 규칙 유지.
- 공식 Fabric 2.5.16 / shim 2.5.8 / Gateway 1.12.1. 3 MSP의 실제 인증 및 VALID commit, 재시작·응답 유실·MVCC INVALID 중복 복구를 검증했다.
- `SqliteFabricProjection`: raw block·거래 이력·상태·cursor 원자적 저장, incremental append, restart replay, 정확한 transaction-index 조회, 캐시/cursor 손상 및 raw VALID 필터 변조 거부.
- `ApplicationLedger`로 서비스 분리. 실제 Gateway 명령 뒤 peer full-block과 원래 idempotency 거래가 반영되어야 HTTP committed를 반환한다. pending은 202, 신선도/연결 실패는 503.
- 테스트 웹 프로필: 인증서 actor/kind 및 개인키 쌍 확인, 세 가상 human만 세션 전환 허용, CSRF/loopback/공개 확인 유지. 앱 시작 때 seed/Init/사람 승인을 자동 실행하지 않는다.
- `fabric:http-smoke`: 비공개 초안, 공개 확인, 비대표 승인 거부, 승인·채택·본문 제공, 실제 peer 정지→503→복구, API 프로세스 재시작과 동일 receipt, 이전 run 거부, 철회 후 withheld 통과.
- TypeScript 7.0.2 strict 검사를 추가했다. domain 검증 후 typed object를 구성하도록 정리했으며 canonicalization과 승인 규칙을 보존했다.

## Key Files & State
- `packages/domain/index.ts`: 공통 도메인 엔진과 검증기.
- `packages/storage/ledger-port.ts`: ApplicationLedger, committed/pending 계약. `local-ledger.ts`는 기존 시뮬레이션 구현.
- `packages/fabric/block-projector.ts`: 검증된 full-block decode, candidate fork, VALID write-set·timestamp 제공.
- `packages/fabric/sqlite-projection.ts`: SQLite raw journal·temporal state·cursor. single writer/data directory.
- `packages/fabric/application-ledger.ts`: 인증된 actor→signer route, 도메인 preflight, peer tip/full block 동기화, 원래 receipt 조회, outbox recovery.
- `apps/api/fabric-test-runtime.ts`: 승인된 테스트 키만 읽는 loopback connector. 개인 인증파일/환경변수 키를 탐색하지 않는다.
- `apps/api/service.ts`, `server.ts`, `main.ts`: mode 주입, pending/503, exact fence·epoch gate, `--ledger fabric-test-network`.
- `.data/fabric-web/`: 실행 중인 웹 앱의 영속 projection/private records/outboxes. Git 제외.
- `.data/fabric-http-smoke-X5cJOF/http-evidence.json`: 최종 실제 HTTP 검증 근거. 이전 두 실행 근거도 각 별도 fixture 디렉터리에 있다.
- `.data/fabric-smoke/`: 원래 네트워크·인증서·deployment.json·CLI smoke evidence·blocks/0.pb–46.pb. 인증서는 7일 유효(2026-09-22 만료).
- 테스트 chaincode logical version 0.1.0 / lifecycle sequence **2**. 현재 source package ID는 `kcl_0.1.0:319e44ab23841645ed9c46f8f33448c9beb43807780b97518ab9f4792bea4157`.
- `.tools/fabric-2.5.16/bin/`, `.tools/docker-compose`: 공식 다운로드 도구. root devDependencies는 TypeScript 7.0.2와 Node 24 타입, lockfile 포함.
- [Fabric 웹 가이드](docs/12-FABRIC-WEB.md), [검증 기록](docs/VALIDATION.md), [구현 결정](docs/10-IMPLEMENTATION-DECISIONS.md).

## Important Context / Decisions
- 공유 문서 본문은 channel 노드에 복제된다. 부서 기밀 원문·초안은 vault에 남긴다. API ACL은 운영자에게 평문을 숨기지 않는다.
- 테스트 모드의 세 조직 키는 한 로컬 프로세스에 있다. 이는 실제 SSO·조직별 vault/KMS 분리나 독립 기관 배포가 아니다. UI에도 가상 사용자로 표시한다.
- manifest는 정확한 VALID fence 거래 시점을 가리킨다. 응답 전에 더 최신 epoch를 이미 관측했으면 추가로 FENCE_SUPERSEDED로 보류한다. 이 보수적인 제공 정책은 결정 문서에 기록했다.
- 동기화는 시작/요청 시 bounded catch-up으로 수행한다. 상시 background worker, 큰 원장의 운영 SLA, 독립 host 장애 내성을 입증하지 않는다.
- root 개발 의존성과 Fabric 의존성은 선택적으로 설치하며, 로컬 시뮬레이션 런타임은 설치 없이 계속 실행 가능하다.
- 로컬 수정·검증·커밋은 승인 범위. 원격 push/공개는 별도 명시적 요청이 필요하다. 개인 인증파일은 새 승인 없이 읽지 않는다.

## Verification
- `npm run check`: **87 passed, 0 failed, 0 skipped**.
- `npm run check:types`: TypeScript 7.0.2 strict, API/packages/Fabric CLI/tools 모두 통과.
- `npm run demo`: withheld → provided → dependency 철회 후 withheld 통과.
- Fabric 의존성이 없는 별도 source copy: **67 passed, 0 failed, 20 optional skipped**.
- 현재 source로 `npm run fabric:upgrade` 후 `npm run fabric:http-smoke` 재검증 통과. 최종 공개/승인/채택은 block 69/71/72, 웹 healthz는 block 77에서 healthy.
- 이전 CLI smoke: block 46 index 0 fence / index 1 withdrawal 둘 다 VALID, epoch 4→5. 47개 peer 블록 replay와 세 peer tip hash 일치 확인.
- 브라우저에서 Fabric 모드·세 사용자·현재 문서 목록 확인. agent-browser 스크린샷 명령은 응답하지 않아 해당 명령을 종료하고 격리 브라우저를 닫았다. 스크린샷 성공 주장은 하지 않는다.
- 원격 CI, 실제 SSO/KMS/Fabric CA enrollment, 독립 조직/host CFT/BFT 및 성능 검증은 미실행이다.

## Blockers & Open Questions
- 운영용 SSO/OIDC 제공자와 KMS 서비스 이름을 async 질문으로 요청했다. 아직 응답 정보가 없다. 실제 서비스 연결에 이 정보가 필요하다. 네트워크/테스트 키 승인은 이미 있으므로 다시 묻지 않는다.
- 외부 KB·모델·embedding 연결, 운영 조직별 배포와 백업·복구/성능 목표도 남아 있다.

## What Worked / Avoid
- 실제 SDK/API는 대소문자까지 확인한다. BlockchainInfo getter는 `getCurrentblockhash_asU8()`다.
- enrollment cert에 clientAuth 전용 EKU를 넣지 않는다. cryptogen의 서명용 digitalSignature 설정과 actor 속성을 사용한다.
- Fabric의 reserved Init marker는 정확한 key/version/pinned bootstrap일 때만 수용한다. block header hash는 ASN.1 DER 방식이며 raw metadata는 별도 전체-byte digest로 검사한다.
- projection은 SQL COMMIT 전 메모리/cursor를 바꾸지 않는다. 과거 entries도 transaction-index 조건을 적용한다.
- 기본 `fabric:deploy`는 다른 package를 대체하지 않는다. 현재 소스를 반영하려면 `fabric:upgrade`로 명시적으로 다음 sequence를 승인·커밋한다. genesis/Init 상태를 재생성하거나 원장을 삭제하지 않는다.
- 완료된 기존 `fabric:smoke`는 초기 조건이 달라 재실행하면 안 된다. `fabric:http-smoke`는 새로운 fixture를 만들고 끝에 그 합의를 철회한다.

## Next Steps
1. Git·실행 상태·현재 사용자 응답을 확인한다. 필요 시 Node 24 PATH와 `curl http://127.0.0.1:4318/healthz`로 웹 상태만 점검한다.
2. 운영 SSO/OIDC·KMS 제공자 정보가 오면 해당 인증 및 signer adapter를 구현하고, actor↔인증 subject/MSP 바인딩·권한 철회 검증을 추가한다. 가상 persona 전환을 운영 인증으로 취급하지 않는다.
3. 실제 조직별 runtime/vault 분리·Fabric CA enrollment 및 독립 host 장애·성능을 범위별로 진행한다. 검증된 현재 기능을 불필요하게 반복하지 않는다.
4. 소유 파일만 로컬 커밋하고 원격 공개는 명시적 요청이 있을 때 한다.

## Resume Prompt
HANDOFF.md와 AGENTS.md, docs/12-FABRIC-WEB.md 및 docs/VALIDATION.md를 읽고 이어가. 영속 Fabric projection과 웹 API, strict 타입 검사는 완료됐고 http://127.0.0.1:4318 에 테스트 모드가 실행 중이다. 기존 네트워크·테스트 키 승인을 재사용해. 운영 SSO/OIDC·KMS 제공자 질문의 사용자 응답을 확인하고, 명확해진 운영 연결부터 진행해. 가상 테스트 신원과 운영 인증을 구분하고 기존 원장/인증서·사용자 .serena 변경을 보존해.
