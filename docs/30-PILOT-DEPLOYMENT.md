# 실환경 파일럿·연동·장애 시험 준비

현재 코드와 가상 리허설을 실제 조직 환경에 적용하기 위한 실행 순서다. 실제 대상 조직,
호스트, SSO/KMS/모델 공급자가 아직 지정되지 않았다. 이 문서 작성은 실환경 시험 완료가 아니다.
비밀키·토큰·쿠키를 이 문서나 공개 저장소에 기록하지 않는다.

## 착수 입력과 결과물

| 필요한 입력 | 반영 위치 | 완료 근거 |
| --- | --- | --- |
| 조직·사람 검토자·업무·공유 범위 | 프로젝트 genesis identity/policy, [파일럿 계획](../examples/pilot/PLAN.template.md) | 참여자 확인, 전체 acceptance slot과 비교 지표 고정 |
| 독립 호스트·운영 담당·접속 경로 | 호스트별 배포 목록, 데이터·백업 경로 | 실제 관리/장애 경계, 호스트 식별자와 실행 위치 기록 |
| OIDC issuer·client ID·public origin·subject 매핑 | `authentication`, `server.public_origin` | 정상 로그인과 미등록/비활성 계정 거절 |
| 인증서·공개키 식별자·signer/KMS 방식 | 조직별 `fabric.identities`, 별도 signer 설정 | actor/조직 바인딩·attestation·감사·실제 VALID 거래 |
| 모델 공급자·adapter ID·허용 데이터 범위 | 서버 `modelEgress`, 호출 측 `generate` | 전송 허용/거절·timeout·생성 후 철회 차단 |
| 시험 시간·중단 대상·복구 담당·완료 기준 | 아래 장애 시험표 | 정확한 커밋·checkpoint, 원래 receipt, 복구된 데이터 비교 |

조직·업무는 설정으로 정한다. order-workflow 조직과 `kcl-demo`는 기존 테스트 fixture다.
기존 fixture의 키·genesis·데이터를 새 구성으로 덮어쓰지 않는다. 실제 파일럿은 처음부터
전용으로 기록한 저널을 준비한다. 현재 측정 CLI에는 기간/pilot_id 필터가 없으므로
과거 시험 이력이 섞인 원장 전체를 실제 파일럿의 효과로 집계하지 않는다.

## 조직별 연결 순서

1. [프로젝트 설정](19-PROJECT-CONFIGURATION.md)의 공개 조직·정책·범위를 고정한다.
   공유 원문이 채널 인프라 운영자에게 복제된다는 조건을 참여자가 확인한다.
   의존 문서는 초안의 **참조하는 공유 개정**에서 정확한 개정과 사용 조건을 선택한다.
2. 각 조직의 새 data directory, 앱 HTTPS origin, OIDC callback과 issuer를 연결한다.
   운영 설정은 HTTPS를 사용하며 issuer 문자열은 discovery 결과와 정확히 같아야 한다.
   actor는 `(issuer, subject)`의 명시적 매핑에서만 나온다. 계정 비활성화·권한 회수,
   미바인딩 subject, 브라우저 역할 전환 거절을 실제 IdP에서 확인한다.
3. 조직별 signer socket과 `key_id`, 공개 인증서/TLS CA 및 peer endpoint를 연결한다.
   configured Fabric 경로의 signer에는 `org_id`, attestation 처리와 감사 로그가 필요하다.
   [서명 프로토콜](../infra/fabric/README.md)의 digest·command·phase·tx ID·영수증 계약을 따른다.
   현재 개발 signer는 로컬 EC 개인키 참조를 읽는다. 실제 HSM/KMS 드라이버는 공급자 선택 후
   구현·검증하며, 공급자의 원문/digest 입력과 서명 바이트 표현을 기존 검증과 대조한다.
   prehashed digest를 다시 해시하거나 키를 애플리케이션으로 반출하는 우회는 하지 않는다.
4. 서버의 `modelEgress.allows`로 허용 adapter와 actor/범위를 고정하고, 선언을 강제하는
   배포는 `require_adapter`를 설정한다. 훅은 실행 코드로 주입하며 JSON 설정만으로
   공급자 연결이 생기지 않는다. [guarded generation](24-KNOWLEDGE-CLIENT.md)의
   `generate`에 선택 공급자의 transport·취소·timeout을 연결한다. 결과는 최종
   revalidate 이후에만 공개하고, 미허용 adapter에서는 공급자 호출이0회인지 확인한다.
5. 조직별 앱·signer를 기동하고 readiness, 인증 조회, 명시적 게시·사람 승인·활성화·철회를
   실행한다. ACK나 이벤트만으로 성공을 기록하지 않고 full-block VALID와 정확한
   transaction index를 확인한다. 시험 문서는 시험 종료 시 합의를 철회한다.

SSO 세션과 KMS 자격 증명은 각각 배포 소유자가 관리한다. 기존 로컬 테스트의 가상 계정,
동일 UID signer, 로컬 모델 callback이 실제 공급자 통합을 대신하지 않는다.

## 독립 호스트 장애 시험

호스트 목록에는 peer·orderer·앱·signer·백업 위치와 관리자를 대응시킨다. VM·컨테이너가
같은 물리 호스트에 있으면 그 공통 장애 경계를 명시한다. 현재3-orderer Raft 예제는 CFT이며
BFT나 악성 운영자 내성을 검증한 것으로 표시하지 않는다. 중단 전 대상 PID·명령·작업 경로
또는 정확한 컨테이너/호스트를 확인하고 복구 절차를 준비한다.

| 주입할 장애 | 확인할 동작 | 남길 근거 |
| --- | --- | --- |
| 한 조직 peer/연결 중단 | 검증 가능한 fresh fence가 없으면 normative 제공 차단; 복구 후 새 검증 | 중단·복구 시각, 응답, peer tip와 projection lag, exact checkpoint |
| 한 Raft orderer 호스트 중단 | quorum이 유지되는 범위의 실제 VALID 거래와 복구 노드 catch-up | 각 노드 상태, VALID tx/block, 복구 후 같은 block hash |
| 조직 간 네트워크 단절 | 격리된 앱이 낡은 참조를 현재 권위로 제공하지 않음 | 단절 경계·서버 응답·재검증 결과, 단절 중 요청의 pending/unknown 상태 |
| 앱/signer 호스트 중단·재시작 | 원래 command receipt를 복구하고 중복 효과 없이 재시도 | command ID, 원래/복구 receipt, outbox와 저널 일치 |
| 백업 복원 | 새 디렉터리/호스트에서 private 경계·공유 상태·checkpoint 복원 | snapshot manifest/hash, 전체 저널/초안 digest, 재생·기동 결과 |

`test:drill:multi-host`는 한 호스트의 두 프로세스·파일시스템 드릴이다. 위 물리 호스트
시험의 완료 근거로 쓰지 않는다. runtime snapshot은 앱 DB용이며 Fabric peer/orderer
volume·채널/MSP 설정·별도 키 보존까지 포괄하는 인프라 재해 복구를 대신하지 않는다.
인프라 백업은 선택한 플랫폼의 절차와 운영 담당이 필요하다. 실제 RTO/RPO는 시험 후 기록한다.

## 실행 기록과 완료 판정

실행마다 소스 commit·Node/의존성·이미지 digest·배포 바인딩, 대상 호스트와 시각,
주입한 장애·종료 신호, 실패/복구 응답, VALID transaction·전체 block/checkpoint,
원래 receipt와 snapshot/content digest를 기록한다. 공개 기록에는 원문·개인정보·세션을
제외한다. 일부만 확인했으면 그 부분과 미실행 경계를 명시한다.

실제 도입 효과는 [파일럿 측정](28-ADOPTION-PILOT.md)과 대조군 관찰을 함께 해석한다.
미관찰 항목을0건 성과로 채우지 않는다. 운영비·검토 수고·해석 혼합·공개 부담·업무 재사용을
참여자가 검토하고 확대·반복·중단 결정을 남겨야 실제 파일럿 완료다.

## 인증서 유지보수 일정

기존 예제 User1 인증서의 알려진 만료일은 `2027-01-14T14:41:57Z`이며 다음 수동 점검일은
**2027-01-01 KST**다. [인증서 절차](27-TEST-CERTIFICATES.md)의 공개 `check` 결과에 따라
경고 창에서만 갱신 필요 여부를 판단한다. 키 보존·한 번에 하나의 유지보수·앱과 signer의
재로딩 및 VALID 확인을 따른다. 미래 점검을 오늘 완료한 것으로 기록하거나 자동 갱신을
설치한 것으로 표시하지 않는다. 실제 공급자의 CA/TLS/KMS rotation은 별도 절차다.
