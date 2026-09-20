# 32. 조직·정책 변경 후속 설계

**상태: 구현 전 설계.** 현재 실행 중인 설치의 조직·역할·정책은 genesis에 고정되어 있다.
이 문서는 기존 설정 파일을 고쳐 실행하는 우회 절차가 아니다. 사용자의 조직 구성과 운영
승인 주체가 확정된 뒤 별도 프로토콜 변경으로 구현·검증한다.

## 필요한 사용자 결정

조직 편입/탈퇴와 정책 변경을 승인할 **기존 관리 주체 및 정족수**를 정해야 한다. 일반 지식
문서의 대표자와 네트워크 운영자 중 누구에게 이 권한을 줄지 제품이 임의로 결정하지 않는다.
또한 membership/role epoch 변경으로 재검토가 필요한 기존 문서 수와 제공 중단 범위를
운영 조직이 받아들일 수 있어야 한다. 이 입력 없이 승인 권한 CRUD를 열지 않는다.

## 제안하는 변경 절차

1. 변경 제안은 현재 config digest/version, 예상 membership epoch/role binding version,
   적용할 전체 정책 snapshot, 변경 이유를 고정한다. 조직은 구성 ID로 표현하며
   선택형 업무 fixture를 기본값으로 도입하지 않는다.
2. 제안 시점의 **기존 관리 정책**으로 사람이 승인한다. 변경 대상 정책이 자신을 승인하는
   순환을 허용하지 않는다. AI 작성은 허용하되 사람 승인 계약을 재사용한다.
3. 영향 미리보기는 새 epoch에서 유효하지 않게 되는 합의·승인·제공 범위와 필요한 재검토
   목록을 정확한 체크포인트에서 계산한다. 미리보기 결과로 사용 권한을 부여하지 않는다.
4. 하나의 결정적 domain 명령에서 이전 config CAS, 관리 승인 검증, 새 config snapshot과
   epoch 기록을 원자적으로 반영한다. Fabric VALID 커밋 전에는 변경 완료로 표시하지 않는다.
5. 기존 승인/개정/합의를 삭제하지 않는다. 새 epoch와 일치하지 않는 승인을 재사용하지 않으며
   resolve/revalidate가 즉시 제공을 보류한다. 재검토가 필요한 정확한 개정에 새 proposal을
   만들고 새 승인으로 합의를 활성화한다. 과거 체크포인트에는 당시 config를 사용한다.
6. 복구는 과거 설정 파일을 덮어쓰는 방식이 아니라, 새 관리 제안과 새 버전의 전진 변경으로
   진행한다. 네트워크 MSP·채널 정책·인증서 변경은 별도 인프라 절차와 검증을 요구한다.

## 구현해야 할 경계

| 구성 요소 | 변경 요구 |
| --- | --- |
| `packages/domain` | 관리 제안·승인·적용 명령, 이전 설정 CAS, epoch 전이와 재생 계약 |
| `packages/config` | 초기 신뢰 기준과 현재 정책 snapshot 구분, 관리 승인 정책 검증 |
| `apps/api/service.ts` | `initialize()`의 genesis 비교를 보존하면서 합법적인 현재 config 진화를 검증하는 경로 |
| `packages/storage/configuration-scope.ts` | 설치의 초기 authority binding을 보존하는 버전 명시 migration |
| Fabric command 검증/chaincode/projector | 새 명령 schema와 이벤트/쓰기 계약, 실제 upgrade와 VALID 검증 |
| OIDC·signer | 현재 ledger 권한과 계정 mapping/서명 가능 주체의 갱신·제거, 오래된 세션 무효화 |
| 검토 기록·검색·UI | 현재 권한에 맞는 수신자/조회 제한, 캐시 폐기, 영향·재검토 진행 표시 |
| snapshot/restore | 이전 버전 복원과 현재 정책 재생, 기존 설치를 새 genesis로 바꾸지 않는 검증 |

전역 epoch를 올리면 해당 epoch에 결속된 모든 기존 승인이 영향을 받는다. 일부 문서만
갱신하는 최적화는 slot별 authority version 같은 추가 계약이 필요하므로 첫 적용과 분리한다.
권한 제거를 신속하게 반영하는 기존 serving freeze와 use 재검증 경계를 약화하지 않는다.

## 완료 기준

로컬/Fabric adapter의 동일 전이, 서로 경합하는 변경 제안의 CAS, 제거된 관리자의 승인,
새 정책을 이용한 자기 승인, 이전 approval replay, 변경 중 실행의 결과 반환 전 보류,
과거 snapshot 재생, 중단·재시작·복구를 회귀 테스트한다. 기존 실제 fixture에는 fresh-network
초기화를 하지 않으며 별도 데이터와 명시적인 체인코드 upgrade 계획으로 리허설한다.
현재 검토 댓글·알림 기능은 이 관리 권한의 근거로 사용하지 않는다.
