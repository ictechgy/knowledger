# 09. 결정 기록과 출처

설계일: 2026-09-15. 아래의 **결정**은 이 프로젝트의 제안이고, **근거**는 기술 원리/기능의 출처다. 공개 자료가 이 제품의 수요나 성능을 검증한 것은 아니다.

## ADR-001 — 문서 본문을 공유 원장의 정본으로 삼는다

결정: 공유된 지식은 전체 Markdown snapshot과 metadata를 함께 digest하고 ledger transaction에 포함한다. Wiki와 RAG index는 파생물이다. 합의 당시 내용을 복원하기 위해 외부 원문 서버 하나에만 의존하지 않게 한다.

대안: hash-only ledger + 외부 object store. 저장·삭제/가용성 운영을 분리하기 쉽지만, 원장 이력만으로 공유 본문을 재구축할 수 없다. 사용자의 full-document ledger 선택을 따라 snapshot을 기본으로 한다. 대용량 첨부는 이 약속의 범위 밖이다.

근거: [Fabric Ledger](https://hyperledger-fabric.readthedocs.io/en/latest/ledger/ledger.html). full-history 보존과 백업이 있어야 복원할 수 있으며 단순 복제만으로 영구 가용성을 보증하지 않는다.

## ADR-002 — 하나의 전사 모델을 강제하지 않는다

결정: 부서와 context를 분리하고, 개정본이 아닌 **SlotKey별 agreement**가 사용 상태를 가진다. 도메인 간 연결은 별도 mapping 문서로 표현한다. 개인/LLM 다수결로 의미를 확정하지 않는다.

근거: [Bounded Context](https://martinfowler.com/bliki/BoundedContext.html), [Data Mesh Principles](https://martinfowler.com/articles/data-mesh-principles.html). DDD의 다중 모델과 Data Mesh의 도메인 소유/연합 거버넌스는 이 설계의 배경이다. Data Mesh가 분산원장을 요구한다는 뜻은 아니다.

## ADR-003 — 의미 승인과 분산 execution 합의를 분리한다

결정: 도메인 역할의 signed approval은 업무 의미에 대한 조직의 증언이다. Fabric endorsement는 chaincode 실행 결과의 무결성을 다루고 orderer는 순서를 정한다. 표준 MSP role과 업무 role을 혼합하지 않는다.

근거: [Endorsement Policies](https://hyperledger-fabric.readthedocs.io/en/latest/endorsement-policies.html), [Ordering Service](https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html).

## ADR-004 — Hyperledger Fabric을 기본 원장으로 채택하고 신뢰 프로필을 표시한다

상태: 사용자 채택 확정. 자체 분산 합의 알고리즘을 새로 구현하지 않고 Hyperledger Fabric을 활용한다. 제품과 기반 기술의 책임 구분은 [구현 결정](10-IMPLEMENTATION-DECISIONS.md)에 기록한다.

결정: PoC는 Raft CFT, BFT 목표는 독립 관리의 최소 4 orderer다. v3 계열의 정확한 patch/이미지 digest·지원 기간·SDK 호환성은 구현 P0에서 확인해 고정한다.

대안: 중앙 append-only DB + 서명/WORM snapshot은 모든 조직이 단일 운영자를 수용하는 환경에서 더 작을 수 있다. 이 설계의 Fabric 선택 이유는 조직별 peer/admin/endorsement와 공동 상태 관리다. 한 중앙 root가 모든 키와 노드를 통제한다면 탈중앙 신뢰 이득을 주장하지 않는다.

애플리케이션은 `AgreementRegistry`, `ValidatedEventStream`, `ReadFence` 세 포트로 원장에 접근하고 Fabric Gateway/Deliver adapter에 protocol 세부 사항을 둔다. 범용 blockchain framework를 선행 구현하지 않는다.

근거: [Fabric Gateway](https://hyperledger-fabric.readthedocs.io/en/latest/gateway.html), [Peer Event Services](https://hyperledger-fabric.readthedocs.io/en/latest/peer_event_services.html), [공식 releases](https://github.com/hyperledger/fabric/releases).

## ADR-005 — 기밀은 원장 참여 범위와 일치시킨다

결정: v1 private vault는 공용 원장 밖에 남긴다. 제한된 공유 본문은 고정 참여 그룹의 별도 channel을 추후 평가한다. 단일 공용 channel의 API ACL로 부서 기밀을 숨길 수 있다고 주장하지 않는다.

PDC는 private 본문을 authorized peers에 별도 보관하고 공통 원장에는 hash를 남긴다. 따라서 공통 원장만으로 전문 복원하는 기능과 다르다. cross-channel 합의·철회는 단일 transaction 원자성을 가정하지 않는다.

근거: [Private Data](https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html).

## ADR-006 — 불변 개정과 표준 canonical digest를 사용한다

결정: 전체 revision payload를 RFC 8785 JCS 후 SHA-256으로 묶는다. 서명 전후 Unicode를 임의 정규화하지 않는다. 예제 checker는 ASCII property names와 safe integers를 사용하는 좁은 subset만 구현한다. 운영에서는 검증된 JCS 구현과 상호운용 test vector가 필요하다.

근거: [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785).

## ADR-007 — 초안 편집과 채택은 별도다

결정: 실시간 편집은 private draft 협업 도구에 맡기고, 원장에는 게시할 전체 개정본과 검토 사건을 기록한다. CRDT/Git merge 결과가 의미 합의를 대신하지 않는다. 초안도 공유했다면 이후 기록 회수를 보증하지 않는다.

참고: [Automerge](https://automerge.org/docs/hello/)는 협업 데이터 동기화의 대안 예시이며 이 프로젝트의 필수 dependency가 아니다.

## ADR-008 — exact-tx fence와 시간별 projection

결정: normative packet에는 epoch-only ReadFence를 사용하고 정확한 `(block, tx index)` 시점으로 eligibility를 평가한다. 같은 블록 뒤에 철회가 있을 수 있다. global epoch는 보수적 무효화를 선택한다. 이미 전달된 prompt 삭제나 partition 중 즉시 철회를 약속하지 않는다.

대안: TTL cache만으로 최신성을 주장하거나 모든 검색을 원장 transaction으로 바꾸는 방식을 피한다. browse와 normative/action 경로를 나눈다. fence 비용은 PoC에서 측정한다.

## ADR-009 — AI-DLC는 adapter다

결정: 원장은 KB 또는 LLM 위키에 독립적인 계약을 가진다. AI-DLC adapter는 task context와 사용 scope를 요청하고, 지식 packet/manifest를 연결하며 draft proposal을 만든다. 공식 프레임워크의 내부 파일이나 자체 승인 모델을 덮어쓰지 않는다.

근거: [AI-DLC Knowledge](https://awslabs.github.io/aidlc-workflows/guide/08-knowledge/), [AI-DLC plugin authoring](https://awslabs.github.io/aidlc-workflows/harness-engineering/10-authoring-a-plugin/). 실제 extension capability는 버전별로 P0 검증한다.

## 결정이 필요한 운영 질문

아래 질문은 설계 작성을 막는 승인 요청이 아니다. 실환경 구현에서 확정할 입력이다.

1. 실제 context 소유자와 개인/조직 승인 책임, 부서 간 직무분리 수준.
2. 본문을 영구 공유해도 되는 분류와, 삭제 의무가 있는 자료의 경계.
3. 조직 gateway의 증언으로 충분한지, 개별 인간의 독립 서명이 필요한지.
4. CFT만 요구하는지, 어느 독립 관리 주체의 Byzantine 행동까지 가정할지.
5. 첫 KB source·LLM 위키 adapter와 승인된 모델 endpoint, private 지식의 외부 전송 정책.
6. 문서 크기·개정 빈도·보존 기간·RTO/RPO와 strict fence 가용성 요구.
7. 의미 합의가 장기간 disputed일 때 escalation/중재 역할과 처리 기한.
8. 오픈소스 배포 시 라이선스와 외부 기여·업스트림 호환성 정책.

## 설계 검토 반영

독립 architecture review로 exact transaction checkpoint, application entitlement와 SSO/Fabric membership의 분리, shared channel의 orderer 가시성, 승인자 귀속의 신뢰 경계, CFT/BFT 차이를 반영했다. 최종 검토에서는 고정 channel 멤버십, 지정 대표 승인, active 이후 이의 제기, validated write-set replay, 전체 action 재인가, 다중 tx 멱등 재시도 집계, 명시적 SlotKey를 추가로 고정했다. 최종 schema/doc 정합성·검증 기록은 [VALIDATION.md](VALIDATION.md)에 남긴다.
