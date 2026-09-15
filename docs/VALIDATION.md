# 검증 기록

## Fabric 통합 준비 — 2026-09-15

환경: macOS arm64, Node 24.18.0, npm 11.16.0, 실행 중인 Colima Docker.
기존 로그인 셸의 Node 22.20.0은 도구 사전 검사에서 거부하며, 설치된 Node 24를
명시적으로 PATH에 넣어 실행했다.

- `packages/fabric`의 공식 SDK/shim과 전이 의존성을 설치했다. Gateway 1.12.1,
  shim 2.5.8, gRPC 1.14.4, Fabric protos 0.3.7을 고정했다.
- adapter와 chaincode의 lockfile을 생성·검토했다. 양쪽 `npm audit`는 알려진
  취약점 0건을 보고했다. npm 패키지 라이선스는 MIT, Apache-2.0, BSD, ISC,
  Unlicense 계열로 기록됐다. 정적 타입 검사는 아직 실행하지 않았다.
- 공식 Fabric 2.5.16 macOS arm64 도구와 Compose 5.5.1을 다운로드하고
  GitHub release asset SHA-256을 검증했다. peer/orderer/nodeenv 이미지를
  digest로 고정했다. 실제 컨테이너의 peer 버전은 2.5.16, nodeenv는 Node 22.12.0이다.
- `node infra/fabric/build.mjs`, 생성 패키지 `npm ci`, 공식
  `peer lifecycle chaincode package`를 실행했다. `metadata.json`/`code.tar.gz`,
  package lock 포함 및 인증서·node_modules 미포함을 확인했다.
- 공식 shim의 `getArgs()`는 문자열이며 잘못된 UTF-8 바이트를 치환한다.
  원본 `getBufferArgs()`를 사용하도록 수정하고 실제 공식 stub으로 잘못된
  UTF-8 입력 거부를 검증했다.
- 공식 Gateway SDK와 loopback gRPC 서버를 사용해 응답 없는 commit-status
  조회를 재현했다. 제한 시간 추가 후 DEADLINE_EXCEEDED와 재조회 VALID를
  확인했다. 이는 실제 Fabric peer 커밋의 증거는 아니다.
- 세 peer·3-orderer Raft의 공개 설정을 생성하고 Compose 구문과 도구 사전
  검사를 통과했다. 기존 로컬 데모도 `withheld → provided → withheld`를 유지했다.
- 최종 `npm run check`: **69 passed, 0 failed, 0 skipped**. 별도 의존성 없는
  소스 복사본에서는 **56 passed, 0 failed, 13 skipped**로 기존 로컬 검사를 유지했다.
  선택적 공식 SDK/protobuf 검사만 패키지 부재로 건너뛴다.
- full-block reader의 합성 protobuf 검사는 실제 도메인 엔진 write-set으로
  동일 블록 fence·철회 후 withheld, INVALID·미검증 filter, genesis/lifecycle,
  원자적 상태 보존을 확인했다. 헤더 해시는 OpenSSL ASN.1 생성 결과와
  7/128/256/65536/최대 안전 정수 블록 번호에서 비교했다.

### 아직 실행하지 않은 네트워크 단계

사용자가 의존성·도구·이미지 다운로드를 포함한 네트워크 접근을 승인했다.
별도 전역 지침에 따라 새 테스트 CA/MSP/TLS 인증서 생성·사용 승인을 요청한
상태다. 따라서 `npm run fabric:up`과 `npm run fabric:smoke`는 아직 실행하지
않았으며, 실제 endorsement·VALID commit·동일 블록 철회가 검증됐다고 주장하지 않는다.
준비된 시나리오와 도구 pin은 [Fabric 통합 가이드](../infra/fabric/README.md)를 참조한다.

추가 CI job은 공식 의존성 설치 후 Fabric 경계 테스트를 실행하도록 작성했다.
원격 CI·운영 인증·조직별 독립 장애 시험은 미실행이다.

## v0.1 런타임 — 2026-09-15

환경: macOS arm64, Node.js 26.5.0, npm 11.17.0, Python 3.14.7. 로컬 런타임은 새 외부 패키지 없이 실행했다.

```sh
npm run check
npm run demo
node --check apps/web/app.js
node infra/fabric/build.mjs
node --check infra/fabric/dist/entrypoint.mjs
sh -n infra/fabric/package-chaincode.sh
git diff --check
```

**자동 테스트 56개 통과, 실패 0개.**

| 검사 | 수 | 확인 범위 |
|---|---:|---|
| 도메인 엔진 | 18 | 전체 본문 해시, 입력 한계, 대표자/제안/역할 바인딩, old approval 거부, 이의·기권·철회, 재승인, dependency·CAS |
| HTTP/JSON | 11 | 3개 도메인 공존, 비공개 초안 격리, 공개 확인, CSRF/출처, 멱등 원본 receipt, 실제 승인 manifest, 재시작 |
| 로컬 저장소 | 7 | 원자적 실패, 동시 명령 직렬화, 시점 조회, 재생, 알려지지 않은/잘못된 write set 거부, 파생 view 불일치 검출 |
| 계약 호환 | 2 | 기존 계약 예제를 런타임 검사기로 검증, 실제 생성 manifest를 제한된 설계 schema checker로 확인 |
| MVCC 모델 | 3 | activation/object 선후 경합, object 재시도 후 정지, 동일 slot의 경쟁 채택 |
| Fabric 경계/패키지 | 15 | 실제 공통 엔진+주입한 shim, SDK 생명주기, VALID/ACK 구분, 재시작 outbox, 결과 디코딩, 독립 실행 패키지 구조 |

CLI 데모 결과는 `withheld → 두 부서 승인 후 provided → 의존성 철회 후 withheld`다. 전체 본문이 공유 journal에 실제 들어갔는지도 검사한다.

`agent-browser`로 문서 열람, 물류·정산 승인, 채택, resolver 제공, 비공개 초안 저장, 공개 미리보기, 새 개정 게시와 fresh proposal을 조작했다. 마지막 UI 변경 뒤 범위 자동 선택, 새 문서/개정 구분, 역할 변경 시 비공개 편집 화면 초기화, 미승인 문서 withheld를 추가 확인했다. 화면 JavaScript 구문 검사는 통과했다.

캡처 기능은 `agent-browser` daemon 오류 후 별도의 격리된 Chrome/CDP로 확인했다. 데스크톱 1440×1200, 모바일 device viewport 390×844에서 문서 4개가 로딩됐고 모바일 `innerWidth = scrollWidth = 390`이었다. 스크린샷은 로컬 `.artifacts/kcl-verified-desktop.png`, `.artifacts/kcl-verified-mobile.png`에 보관하며 Git에는 넣지 않았다. 열람 상태와 fresh fence 기반 실행 권한을 화면 문구에서도 구분했다.

독립 코드 검토에서 발견한 최신 승인 포인터의 representative mismatch, manifest 승인 바인딩, 중복 명령의 원래 checkpoint, projection 불일치, revision ID 참조 문제를 보강했다. 원장 입력 구조뿐 아니라 상태 간 참조를 검사하고, 로컬 browse도 하나의 checkpoint에서 읽는다.

### 실행하지 않은 항목

- 실제 Fabric peer/orderer/CA 네트워크, peer lifecycle 패키징, 실제 MSP 서명·endorsement·네트워크 장애 주입. Go/peer CLI가 없고 Docker 엔진은 정지 상태였다. 의존성 다운로드 승인 요청에 답변이 없어 설치/이미지 다운로드를 진행하지 않았다.
- 공식 SDK/shim npm 패키지 실행, 전이 의존성 lockfile·감사, TypeScript 정적 타입 검사. SDK 인터페이스를 주입한 테스트와 빌드 검증은 실제 SDK 실행의 대체 증거가 아니다.
- Fabric full-block 해독·VALID write-set projector, 동일 블록 안 여러 거래 fence, 독립 3-orderer CFT/4-orderer BFT 시험. 로컬 원장은 블록당 거래 한 개다.
- 실제 SSO, 사용자 개별 서명, 조직별 vault/KMS, 외부 모델/embedding/KB adapter, PostgreSQL/pgvector, 성능 벤치마크.
- GitHub Actions 원격 실행. workflow는 저장소에 준비했지만 원격 저장소에 게시하지 않았다.

따라서 P0–P3의 전체 운영 완료로 표시하지 않는다. [현재 실행 범위](11-RUNTIME.md)와 [Fabric 통합 경로](../infra/fabric/README.md)를 참조한다.

## 초기 설계 검증 기록

검증일: 2026-09-15. 환경: Python 3.14.7, 표준 라이브러리만 사용. 새 패키지를 설치하지 않았다.

## 확인한 범위

첫 설계 커밋 시점에는 문서, JSON payload 계약, 예제 및 검사 도구만 존재했다. 아래는 그 당시 설계 검증의 범위다. 이후 런타임 검증은 위에 별도로 기록했다.

## 실행 결과

프로젝트 루트에서 실행:

```sh
python3 -B tools/validate_design.py
python3 -B tools/check_docs.py
```

- JSON 계약 4종, 예제 14개, 전체 본문을 묶은 revision digest 4개 검사 통과.
- 기대한 오류 예제 6개 거부: 본문 변경 후 옛 digest, 존재하지 않는 revision을 참조하는 결정, proposal_id 없는 결정, 문서 dependency 안 runtime agreement ID, agreement ID 없는 normative reference, agreement ID를 가진 일반 reference.
- 지정 대표 두 명이 같은 proposal/revision/SlotKey/policy를 승인하고 manifest가 그 결정들을 가리키는지 fixture 일관성 확인.
- private source 예제는 비어 있거나 공개가 허용된 불투명 assertion이며 실제 secret은 없다.
- Markdown 로컬 링크와 코드 fence 짝, Python AST 구문 검사 통과. Mermaid 코드 블록 4개.
- 현재 최종 schema/checker에 대해 임시 복사본에서 추가 변형 5개를 적용해 거부 확인: object를 approve처럼 집계, tx index 누락, 다른 조직 actor, normative agreement 누락, JSON 중복 key. 원래 예제는 변경하지 않았다.

## 독립 검토

아키텍처 검토와 별도 correctness/security 문서 검토를 수행했다. 발견된 다음 항목을 수정하고 제한된 재검토에서 미해결 blocker가 없음을 확인했다.

1. 공유 channel의 과거 본문 소급 노출: v1 membership 고정, 새 그룹은 새 channel과 명시적 재공개.
2. active 이후 필수 대표 object/retract: 같은 거래에서 suspend + epoch 증가.
3. 여러 역할 보유자의 집계: role별 한 명의 지정 대표와 불변 binding snapshot.
4. projector 완전성: VALID full transaction write-set replay, unknown input에서 cursor 중단.
5. action 전 전체 재인가: SSO/private source/model egress/tool 권한 + fresh fence.
6. timeout 후 다중 tx: durable command outbox와 committed idempotency state로 집계.
7. context/scope 모호성: SlotKey 다섯 필드와 v1 single-scope revision.
8. 검토 간 승인 replay: immutable proposal_id와 재승인 시 새 proposal.
9. 불변 문서와 runtime agreement ID 분리.
10. manifest normative/reference 구분을 schema oneOf로 강제.

## 보증하지 않는 것

검사기는 이 폴더가 사용하는 JSON Schema keyword와 좁은 JCS 입력 부분집합을 확인한다. 범용 Draft 2020-12 또는 RFC 8785 구현으로 배포할 수 있는 라이브러리가 아니다. 실제 identity·서명·인가·active ledger 상태·합의/분산 장애·서버 최신성·성능은 확인하지 않았다.

Mermaid는 fence 구조만 확인했다. `mmdc`가 설치되어 있지 않아 실제 렌더링은 수행하지 않았다. Mermaid CLI를 사용하는 환경에서는 예를 들어 `mmdc -i README.md -o /tmp/kcl-readme.md`로 Markdown 내 다이어그램을 렌더링해 확인할 수 있다.

최종 운영 완료 기준은 [구현 계획](07-DELIVERY-PLAN.md)의 P-01–P-17, S-01–S-07, R-01–R-13 및 CFT/BFT·복구 실험이다. 위의 런타임 테스트와 실제 네트워크 시험을 구분한다. 성능 수치는 설계 가설이며 benchmark 결과가 아니다.
