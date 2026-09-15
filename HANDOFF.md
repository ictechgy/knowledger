# Handoff

_Last updated: 2026-09-15 17:09 KST by Codex_

## Goal
- MIT 오픈소스 Knowledge Consensus Ledger(KCL). 도메인별 해석을 보존하면서 공동 업무에 사용할 지식을 명시적으로 합의한다.
- Hyperledger Fabric 채택은 확정이다. 자체 분산 합의 알고리즘 개발은 범위 밖이다.
- 현재 작업은 실제 Fabric 통합·peer VALID commit 검증을 완료한 상태다. 운영 연결은 후속 단계다.

## Current Status
- 루트 `/Users/jinhongan/Desktop/knowledge-consensus-ledger`, `main`. 이번 실행 작업 시작 커밋은 `2c2ba4f`; 최종 커밋은 `git log -1`로 확인한다.
- 기존 미추적 `.serena/`는 사용자 변경으로 보존했다. 커밋 대상이 아니다.
- **실제 3 peer + 3 Raft orderer + 3 chaincode 컨테이너가 실행 중이다.** 네트워크와 테스트 인증서 생성·사용은 모두 승인받았다. 실제 smoke는 2026-09-15 17:02 KST에 통과했다.
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
- 공식 Fabric 2.5.16/Compose 5.5.1 도구·이미지 검증. 공식 package/install/approve/commit 및 founder Init VALID 완료.
- 세 조직 실제 MSP 인증, 문서 4개·원래 command receipt 17개 VALID 확인. 재시작/응답 유실 복구와 실제 MVCC INVALID 중복 조정 통과.
- peer full-block 0–46 재생, 세 peer height 47·tip hash 일치. block 46 index 0 fence / index 1 dependency withdrawal 모두 VALID, epoch 4→5, resolver provided→withheld. 운영 영속 cursor/복구 supervisor는 별도 단계다.

## Key Files & State
- `packages/domain/index.ts`: 로컬/Fabric 공통 합의 엔진.
- `packages/fabric/`: 인증된 MSP·actor, raw argument bytes, VALID/ACK 구분, RPC deadline, outbox, full-block projector.
- `infra/fabric/test-network.py`: 공개 설정 prepare, 새 테스트 인증서 생성·배포 up, 배포 재개 deploy, 데이터 보존 정지 stop.
- `infra/fabric/smoke.ts`: 실제 publish/approve/activate/withdraw, process 종료 후 outbox 복구, 응답 유실 주입, MVCC INVALID 중복, 동일 블록 fence/철회 시나리오. **실제 실행 통과**. 완료 fixture는 철회 이후이므로 fresh smoke를 재실행하지 않는다.
- `.data/fabric-smoke/`: 생성된 테스트 `crypto/`, ledger/outbox, `evidence.json`, `replication.json`, 검증된 `blocks/0.pb`–`46.pb`. 모두 Git 제외. 테스트 서명 인증서 유효 기간은 7일(2026-09-22 만료)이다.
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
- Facts: 사용자가 `.data/fabric-smoke/crypto`의 테스트 CA/MSP/TLS 키 생성·서명·사용을 승인했다. 같은 범위 승인을 다시 묻지 않는다. 기존 개인 인증파일은 사용하지 않는다.
- Facts: 로컬 수정·검증·커밋은 기존 승인 범위다. 원격 push/공개는 명시적 요청이 필요하다.
- Assumption: 같은 Docker 호스트의 세 조직/3-orderer는 통합 fixture다. 조직별 독립 관리와 운영 CFT/BFT 내성을 입증하지 않는다.

## Verification
- Node 24.18.0 / npm 11.16.0 / Python 3.14.7.
- 최종 npm run check: 70 passed, 0 failed, 0 skipped. 이전 준비 단계의 의존성 없는 복사본 검사(56 passed, 13 optional skipped)는 별도 기존 근거다.
- adapter 및 chaincode npm audit: 알려진 취약점 0건. 의존성 라이선스 목록과 lockfile integrity 확인.
- 최종 chaincode 빌드·entrypoint 구문·공식 peer 패키징 통과. raw-buffer 수정·lockfile 포함, credential/node_modules 제외 확인.
- Docker에서 peer 2.5.16과 nodeenv Node 22.12.0 직접 실행해 버전 확인.
- npm run demo: withheld → provided → dependency 철회 후 withheld, 공유 journal 원문 검사 통과.
- fabric:prepare, Compose config, tool preflight 통과. Node 22에서는 credentials 생성 전에 거부한다.
- npm run fabric:smoke 실제 통과. fabric:deploy 재실행 통과·블록 증가 0. 같은 블록 철회는 실제 peer 블록으로 확인했다. TypeScript 정적 검사, 원격 CI, 독립 호스트 partition 시험은 미실행이다.

## Blockers & Open Questions
- 현재 승인 blocker는 없다. 실행 결과는 한 Docker 호스트의 실제 Fabric 통합 검증이며 운영 다기관 검증과 구분한다.
- 영속 Fabric projector, HTTP Fabric mode, 운영 SSO/KMS/Fabric CA enrollment, 외부 KB·모델·embedding, 독립 분산 장애/성능 검증은 남아 있다.

## What Worked / Avoid
- 공식 SDK/shim과 직접 비교해 mock이 숨겼던 argument/timeout 문제를 확인했다.
- getArgs 재인코딩은 잘못된 UTF-8을 치환하므로 raw getBufferArgs를 사용한다.
- Fabric block header hash는 protobuf 직렬화가 아닌 공식 ASN.1 DER 형식의 SHA-256이다.
- 기본 Docker context를 바꾸거나 개인 인증서를 찾지 않는다. fabric:up으로 기존 test identities를 덮어쓰지 않는다. 자동 volume 삭제는 없다. fabric:deploy는 실제 channel/definition/package/Init 상태를 조회하고 일치할 때 재개한다.

## 실증에서 찾은 호환성 문제
- enrollment 인증서에 clientAuth 전용 EKU를 넣으면 MSP가 거부한다. 공식 cryptogen과 같은 digitalSignature 용도로 발급하고 actor 속성을 유지한다.
- Fabric은 KCL namespace에 reserved InitializedKeyName을 자동 기록한다. reader는 정확한 key·고정 version·같은 거래의 pinned bootstrap만 수용한다.
- Init 후 프로세스가 중단돼도 deployment.json을 성공 근거로 삼지 않는다. 실제 peer query와 org별 승인/package를 검사한다.

## Next Steps
1. 실제 네트워크 상태가 필요하면 Node 24 PATH, colima status, docker --context colima ps를 확인한다. 완료된 smoke를 그대로 반복하면 초기 조건이 달라 실패하므로 저장된 evidence/blocks를 먼저 읽는다.
2. 다음 구현 후보는 영속 Fabric projector의 state/cursor 원자적 저장·재시작과 HTTP Fabric adapter 연결이다. 별도 서명/인증 경계와 도메인 규칙을 유지한다.
3. 운영 SSO/KMS·Fabric CA enrollment, 독립 조직/호스트 장애·성능, v3/BFT는 별도 단계다. 지금의 성공으로 P0–P3 전체 운영 완료를 표시하지 않는다.
4. 소유 파일만 로컬 커밋하고 원격 push는 명시적 지시가 있을 때 한다. 네트워크 정지가 필요하면 npm run fabric:stop으로 데이터를 보존한다.

## Resume Prompt
HANDOFF.md와 AGENTS.md, docs/VALIDATION.md를 읽고 Git 상태를 확인해. 실제 Fabric 3 peer/3-orderer 통합과 block 46 동일 블록 철회는 검증 완료다. 기존 네트워크·테스트 인증서 승인을 재사용하고 저장된 evidence/blocks와 실행 상태를 확인해. 성공한 smoke를 불필요하게 반복하거나 원장을 지우지 말고, 다음 범위인 영속 projector·HTTP Fabric 연결을 저장소에 근거해 진행해. 운영 인증·독립 호스트 검증은 아직 별도 단계임을 유지해.
