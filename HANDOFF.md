# Handoff

_Last updated: 2026-09-15 16:40 KST by Codex_

## Goal
- MIT 오픈소스 Knowledge Consensus Ledger(KCL). 도메인별 해석을 보존하면서 공동 업무에 사용할 지식을 명시적으로 합의한다.
- Hyperledger Fabric 채택은 확정이다. 자체 분산 합의 알고리즘 개발은 범위 밖이다.
- 현재 작업은 실제 Fabric 통합 준비와 peer VALID commit 검증 경로다.

## Current Status
- 루트 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 이번 작업 시작 커밋은 `b86a4c0`; 최종 커밋은 `git log -1`로 확인한다.
- 기존 미추적 `.serena/`는 사용자 변경으로 보존했다. 커밋 대상이 아니다.
- **Fabric 노드는 아직 기동하지 않았다. 테스트 인증서 생성·사용 승인이 대기 중이다.** 네트워크 접근은 명시적으로 승인받았다.
- Colima 기본 VM/Docker는 기동했다. 기본 Docker context를 전환하지 않았으며 명령은 `--context colima`를 사용한다.
- 현재 로그인 셸은 Node 22.20.0이다. 이미 설치된 Node 24.18.0을 사용한다:

```sh
export PATH="/Users/jinhongan/.nvm/versions/node/v24.18.0/bin:$PATH"
```

## Completed
- 기존: 전체 Markdown 불변 개정본, 비공개 초안, proposal/revision/전체 SlotKey/정책/epoch/대표자에 묶인 승인, CAS 채택, 이의·철회 시 정지, dependency resolver, SQLite journal/outbox.
- 공식 shim 2.5.8, Gateway 1.12.1, gRPC 1.14.4, protos 0.3.7 설치 및 두 package lockfile.
- shim 문자열 인자 가정 오류 수정. 공식 `getBufferArgs()`로 UTF-8 원본을 유지하고 잘못된 인코딩을 거부한다.
- Gateway RPC별 제한 시간: evaluate 5초, endorse/submit 각 15초, commit-status 30초. 실제 SDK + 응답 없는 loopback gRPC 서버 회귀 검사.
- 공식 Fabric 2.5.16 도구, Compose 5.5.1 및 peer/orderer/nodeenv 이미지 다운로드·해시 검증. 공식 peer lifecycle 패키징 수행.
- 세 조직 peer와 3-orderer Raft 공개 설정 생성, loopback 포트·Compose 파싱·도구 사전 검사.
- peer full-block VALID write-set을 읽는 in-memory projector. 운영 영속 cursor/복구 supervisor는 별도 단계다.

## Key Files & State
- `packages/domain/index.ts`: 로컬/Fabric 공통 합의 엔진.
- `packages/fabric/`: 인증된 MSP·actor, raw argument bytes, VALID/ACK 구분, RPC deadline, outbox, full-block projector.
- `infra/fabric/test-network.py`: 공개 설정 prepare, 새 테스트 인증서 생성·배포 up, 배포 재개 deploy, 데이터 보존 정지 stop.
- `infra/fabric/smoke.ts`: 실제 publish/approve/activate/withdraw, process 종료 후 outbox 복구, 응답 유실 주입, MVCC INVALID 중복, 동일 블록 fence/철회 시나리오. **미실행**.
- `.data/fabric-smoke/`: 공개 configtx/cryptogen/Compose 설정만 준비. `crypto/`는 생성하지 않았다.
- `.tools/fabric-2.5.16/bin/`: peer, cryptogen, configtxgen, osnadmin 등 공식 도구. Go 설치 없이 사용한다.
- `.tools/docker-compose`: macOS arm64 standalone binary. 전역 docker compose plugin은 없다.
- `.artifacts/kcl-fabric-reviewed.tar.gz`: 현재 소스의 공식 lifecycle 패키지. 생성물이라 Git 제외.
- [Fabric 실행 경로](infra/fabric/README.md), [검증 기록](docs/VALIDATION.md), [구현 결정](docs/10-IMPLEMENTATION-DECISIONS.md).

## Important Context / Decisions
- Facts: 공유 문서 본문까지 원장에 복제된다. 부서 기밀 원문·초안은 vault에 남긴다. API ACL은 channel 운영자에게 평문을 숨기지 못한다.
- Facts: 사람의 의미 합의와 노드 거래 합의는 별개다. AI의 사람 승인, 옛 approval 재사용, 로컬/ACK/event를 VALID 근거로 사용하는 것을 허용하지 않는다.
- Facts: v0.1 정책·조직은 고정. 로컬 SQLite는 블록당 거래 한 개이며 실제 동일 블록 검증의 대체물이 아니다.
- Facts: 첫 통합 프로필은 Fabric 2.5.16 + shim 2.5.8 + Gateway 1.12.1. v3 참조와 BFT는 별도 검증 단계로 기록했다. nodeenv 2.5.8의 실제 Node는 22.12.0이다.
- Facts: 이번 대화에서 사용자가 네트워크 접근을 승인했다. 공식 문서·GitHub releases·npm·Docker Hub 다운로드를 수행했다. 같은 범위 승인을 다시 묻지 않는다.
- Facts: 대기 중인 인증서 질문은 `.data/fabric-smoke/crypto`의 새 CA/MSP/TLS 키 생성·서명·사용만 대상으로 한다. 기존 개인 인증파일은 사용하지 않는다. 응답이 오면 이 기록보다 최신 사용자 응답을 우선한다.
- Facts: 로컬 수정·검증·커밋은 기존 승인 범위다. 원격 push/공개는 명시적 요청이 필요하다.
- Assumption: 같은 Docker 호스트의 세 조직/3-orderer는 통합 fixture다. 조직별 독립 관리와 운영 CFT/BFT 내성을 입증하지 않는다.

## Verification
- Node 24.18.0 / npm 11.16.0 / Python 3.14.7.
- 최종 npm run check: 69 passed, 0 failed, 0 skipped. 별도 Fabric 의존성 없는 복사본: 56 passed, 0 failed, 선택적 SDK/protobuf 13 skipped.
- adapter 및 chaincode npm audit: 알려진 취약점 0건. 의존성 라이선스 목록과 lockfile integrity 확인.
- 최종 chaincode 빌드·entrypoint 구문·공식 peer 패키징 통과. raw-buffer 수정·lockfile 포함, credential/node_modules 제외 확인.
- Docker에서 peer 2.5.16과 nodeenv Node 22.12.0 직접 실행해 버전 확인.
- npm run demo: withheld → provided → dependency 철회 후 withheld, 공유 journal 원문 검사 통과.
- fabric:prepare, Compose config, tool preflight 통과. Node 22에서는 credentials 생성 전에 거부한다.
- 실제 network deployment/smoke, TypeScript 정적 검사, 원격 CI는 미실행. SDK/합성 protobuf 테스트를 실제 네트워크 증거로 보고하지 않는다.

## Blockers & Open Questions
- 테스트 전용 인증서 생성·사용 승인 대기. 전역 AGENTS의 인증파일/키스토어 사전 승인 규칙 때문이다.
- 새 네트워크 스크립트는 구문·공개 설정만 확인했다. 승인 후 실제 lifecycle에서 발견되는 문제는 재현·수정해야 한다.
- 영속 Fabric projector, HTTP Fabric mode, 운영 SSO/KMS/Fabric CA enrollment, 외부 KB·모델·embedding, 독립 분산 장애/성능 검증은 남아 있다.

## What Worked / Avoid
- 공식 SDK/shim과 직접 비교해 mock이 숨겼던 argument/timeout 문제를 확인했다.
- getArgs 재인코딩은 잘못된 UTF-8을 치환하므로 raw getBufferArgs를 사용한다.
- Fabric block header hash는 protobuf 직렬화가 아닌 공식 ASN.1 DER 형식의 SHA-256이다.
- 기본 Docker context를 바꾸거나 개인 인증서를 찾지 않는다. 기존 test identities를 덮어쓰지 않는다. 자동 volume 삭제는 없다.

## Next Steps
1. 인증서 승인 응답을 확인한다. 승인됐다면 Node 24 PATH와 colima status 확인 후 npm run fabric:up 실행.
2. 실패 시 키 내용이 출력되지 않도록 주의하며 고친다. identities가 이미 생성됐다면 fabric:deploy로 이어가되, 이미 커밋된 lifecycle definition 상태를 먼저 확인한다.
3. npm run fabric:smoke 실행. 실제 peer VALID/INVALID, outbox 복구, full-block 원문, 같은 블록 fence/withdrawal을 검증한다. 모든 assertion 통과 후에만 .data/fabric-smoke/evidence.json이 생성된다.
4. 필요한 검사·문서 갱신 후 소유 파일만 로컬 커밋. 원격 push 금지. 운영 영속 projector·권한 경계는 후속 단계로 유지한다.

## Resume Prompt
HANDOFF.md와 AGENTS.md를 읽고 Git 상태를 확인해. 네트워크 승인은 재사용하고 이번 대화의 테스트 인증서 승인 응답을 확인해. 승인됐다면 Node 24 PATH와 Colima를 확인한 뒤 npm run fabric:up, npm run fabric:smoke를 실제 실행·수정·검증해. 합성 테스트와 peer VALID 증거를 구분하고 검증된 변경만 로컬 커밋해.
