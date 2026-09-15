# 08. 지식의 합의 — 전체 예시

## 등장 주체

아래 이름·ID·역할은 가상이다. 실제 승인 서명이나 실제 조직 자료가 아니다.

- 영업: 계약 성립 관점의 `주문 완료` 정의를 소유한다.
- 물류: 배송 완료 관점의 정의를 소유한다.
- 정산: 수납 완료 관점의 정의와 private 회계 자료를 소유한다.
- 공동 업무: 리뷰 요청을 언제 보낼지 결정한다.

이 세 context를 하나의 문서 revision chain으로 이어서 후속 부서가 이전 부서의 정의를 대체하는 방식은 사용하지 않는다. 독립 문서가 공존하고, 별도 mapping/rule 문서가 이들을 참조한다.

## 정상 흐름

### 1. Private 지식에서 공유 정의 준비

각 부서는 private vault의 근거로 공유할 정의를 작성한다. 실제 거래액, 고객 식별자, 내부 사고 사례, 회계 자료는 공유하지 않는다. 정산은 필요한 경우 `정산 부서가 이 공개 정의의 근거를 관리한다`는 제한된 assertion을 제공할 수 있다. 다른 부서가 비공개 원문을 직접 검증한 것으로 표시하지 않는다.

### 2. 세 정의를 독립 게시

각 정의의 `document_id`와 `context_id`를 구분하고, 첫 revision의 parent는 비어 있다. 실제 본문 snapshot과 metadata digest를 게시한다. 세 정의의 같은 한글 제목은 identity나 동일성의 근거가 아니다. 각 정의는 자신의 domain-definition/v1 scope에서 소유자 정책으로 active가 된 뒤 공동 규칙의 requires_active 근거로 사용된다.

### 3. 공동 규칙 제안

별도 문서 `리뷰 요청 기준`을 작성한다.

```text
적용 범위: review-invitation/v1
정의: 리뷰 요청의 기준은 물류의 배송 완료다.
관계: 영업의 계약 완료 또는 정산의 수납 완료와 동치가 아니다.
예외: 부분 배송이면 모든 대상 품목의 완료 조건을 먼저 확인한다.
예외: 취소/반품 처리 중이면 리뷰 요청을 보류한다.
필수 검토: 물류 책임자와 정산 책임자.
근거: 각 도메인의 정확한 공개 definition revision.
```

여기서 `정산 책임자`를 필수로 둔 것은 예제 정책이다. 실제 팀에서는 고객 경험 등 영향을 받는 다른 도메인 소유자가 들어갈 수 있다. 전사 전원 승인을 기본으로 삼지 않는다.

### 4. 이견과 개정

정산 담당자가 `수납 완료와 혼동되지 않는가`라는 object를 남긴다. 작성자는 서로 독립된 상태임을 명시한 새 revision을 만든다. 이전 revision에 한 결정은 새 revision의 approve가 아니다. 필수 역할들이 새 digest에 대해 각각 승인한다. 질문과 반례는 수정된 본문에 어떤 영향을 줬는지 연결한다.

### 5. Activation과 조회

Activate는 policy/role binding/dep/expected active slot을 검증한다. VALID commit 뒤에만 위키에 `공동 업무에 사용 가능`으로 표시한다. `문서가 원장에 있음`과 `이 업무에 합의됨`은 다른 상태다.

사용자가 AI-DLC에 `주문 완료 뒤 리뷰 요청 기능을 구현`하게 한다. Resolver는 작업 scope를 확인하고 공동 규칙을 normative source로, 필요한 도메인 정의를 맥락 설명으로 제공한다. 정산 원자료는 읽지 않는다. packet/manifest에 정확한 revision들과 fence tx를 남긴다.

## 핵심 실패 시나리오

### A. 본문 바꿔치기

문서 bytes를 바꾸고 옛 digest를 제출하면 revision 검증에서 거부한다. 새 digest로 정상 게시하면 새 개정본일 뿐, 옛 approval은 따라오지 않는다. 이 검증 자체는 분산원장만의 고유 장점이 아니며, 원장에는 이력 보존과 공동 상태 운영 역할이 추가된다.

### B. 승인 경합

두 작성자가 각각 v2a/v2b를 같은 active v1의 후계로 제안한다. 둘 다 승인되더라도 같은 expected active를 사용하는 activation은 한쪽만 유효하게 커밋된다. 다른 쪽은 `REVISION_CONFLICT` 후 재검토한다. 조용히 last-write-wins로 의미를 정하지 않는다.

### C. 마지막 순간 이의

필수 역할의 object와 activation이 경쟁한다. decision counter/역할별 상태를 실제 read set에 넣는다. activation이 최신 object를 못 본 proposal로 커밋하려 하면 MVCC가 invalid 처리해야 한다. activation 뒤 필수 대표의 object 또는 approve retract가 커밋되면 동일 거래에서 agreement를 suspended로 만들고 epoch를 증가시킨다. 이의 해제만으로 자동 복귀하지 않는다.

### D. 같은 블록 안의 철회

```text
block 1842 / tx 3: ReadFence -> epoch 12
block 1842 / tx 4: WithdrawAgreement -> epoch 13
```

packet은 tx 3 시점의 상태를 명시한다. block 1842 끝까지 적용한 상태를 tx 3의 상태라고 표현하지 않는다. 이후 외부 action 전에 새 fence에서 epoch 13를 확인하면 재검토해야 한다. 이미 실행된 부작용을 원장이 취소한다고 주장하지 않는다.

### E. 기밀 공개 실수

Private 본문을 공용 transaction에 넣은 뒤 chaincode가 invalid 처리해도 payload는 블록에 남을 수 있다. 예제 실험에서는 무해한 canary로 이를 확인한다. 실제 secret은 테스트하지 않는다. publication preview와 공개 권한 확인을 ledger 제출 전 수행한다.

### F. 연결 단절

특정 부서 peer/projector가 뒤처진다. Browse는 표시된 checkpoint의 캐시를 볼 수 있지만, 새로운 normative packet에 fresh VALID fence를 얻지 못하면 withheld한다. 네트워크가 복구되면 블록 hash/cursor를 확인하고 VALID tx를 재생한다. 판단 중인 agent의 기존 context를 지웠다고 보고하지 않는다.

### G. 요약의 근거가 바뀜

LLM 위키의 요약 revision이 물류 definition v1에 의존한다. 물류가 v2를 active로 만들면 `requires_active` 근거인 v1은 해당 scope에서 대체된다. 요약의 effective eligibility는 false이고 재검토를 요청한다. 과거 요약은 historical 조회에서 근거와 함께 볼 수 있다.

### H. 소유자 변경

영업 context owner가 다른 조직으로 변경된다. governance는 기존 소유 정책으로 변경을 승인하고 새 role binding/entitlement epoch를 기록한다. pending approval은 재검토한다. SSO/실제 channel membership 변경은 별도 serving freeze 절차로 동기화한다.

### I. 도메인 관점의 공존

정산팀이 수납 완료 definition v2를 채택해도 영업의 계약 완료 정의가 자동으로 틀렸다고 표시되지 않는다. 두 문서의 context가 다르다. 공동 mapping이 영향을 받는지를 dependency와 사용 범위로 판단한다.

### J. 위키/인덱스 손실

PostgreSQL read model과 벡터 인덱스를 지운 새 환경에서 보존된 공유 원장의 VALID 이력을 replay한다. 문서 본문, 승인/이견/철회, active slot, temporal eligibility를 복구한다. 부서 private vault는 별도 백업에서 복구한다. 공용 블록에 없는 private 문서를 복원했다고 주장하지 않는다.

## 기계 계약 예제 읽기

[examples](../examples/)의 JSON은 schema·본문 digest·참조 일관성을 확인하기 위한 payload다. 실제 committed agreement, Fabric membership, 인간 서명, SSO 권한 또는 네트워크 체크포인트는 아니다. runtime activation과 위 시나리오의 성공은 P1–P3 실행 증거가 있어야 주장할 수 있다.
