# 07. 구현 순서와 완료 기준

## 현재 상태

공통 합의 엔진, API/UI·resolver/manifest, 실제 로컬 Fabric 네트워크와 영속 full-block projection까지 개발 알파로 구현했다. 개발 OIDC 로그인·별도 서명 프로세스와 권한 회수도 연결했다. [실행 가이드](11-RUNTIME.md)가 실제 지원 범위다. 아래 P0–P3의 운영 통합 전체가 완료된 것은 아니다. 실제 회사 SSO/KMS, 독립 조직·호스트 장애, 백업·복구와 성능 시험은 남아 있다. 실행한 112개 테스트와 실제 네트워크 검증의 범위는 [검증 기록](VALIDATION.md)에 분리했다.

## 단계별 실행

| 단계 | 산출물 | 진행 조건 / 완료 기준 |
|---|---|---|
| P0 — 신뢰·계약 확정 | 실제 context map, 역할/공개 정책, exact dependency BOM, 서명 프로필 | 참여 부서가 본문 복제·보존 범위와 관리 권한을 이해하고 수용. CFT/BFT·사용자 개별 서명 필요 여부 확정 |
| P1 — 본문 원장 | Fabric 로컬/3-node CFT, revision+policy+decision chaincode, Gateway | full text 개정 생성·해시 검증·멱등 재시도·VALID commit 확인·복구 성공 |
| P2 — 의미 합의 | 제안/diff/필수 역할 승인/이견/activation/철회/대체 UI | 3개 도메인 정의 공존. 새 본문에 옛 승인 재사용 불가. policy 변경·동시 이의 제기 경합에서 잘못된 activation 없음 |
| P3 — KB·LLM 위키·RAG | projector, scoped index, Resolver, ReadFence, manifest | 권한/맥락/합의 필터, 동일 블록 내 철회, partition fail-closed, 원장만으로 공유 view 재구축 |
| P4 — 실제 도입 파일럿 | 기존 repo/KB adapter 1개, AI-DLC adapter, 운영 대시보드 | 중앙 RAG + metadata governance 대조군과 비교해 의미 혼합·재검토 수고·관리 부담 측정 |
| P5 — 확장 | 독립 4-orderer BFT, 제한 채널, 추가 adapter | 악성 orderer 위협 요구가 실제 존재하고 독립 admin/keys/host 운영 및 migration rehearsal 완료 |

P0–P3이 초기 MVP다. 분산망을 구축하기 전 full-content 공개 정책을 먼저 확정한다. P4에서 기존 구조보다 효과가 없으면 integration 범위를 줄인다. user가 선택한 원장 설계 자체를 검증 없이 다른 제품으로 바꾸지 않는다.

## 구성별 구현 책임

- Ledger team: 공통 TypeScript 엔진과 Node.js chaincode adapter, policy/role registry, deterministic transitions, expected-version/read counters, command idempotency. Go 참조안에서 변경한 이유는 [구현 결정](10-IMPLEMENTATION-DECISIONS.md)을 참조한다.
- Application team: publication preview, SSO/signing gateway adapter, HTTP API, commit-state UI.
- Knowledge team: private-vault import boundaries, context registry, document rendering, agreement diffs.
- Retrieval team: event replay, temporal eligibility, scoped index, exact checkpoint manifest, runtime revalidation.
- 각 역할은 초기에는 동일 개발자가 맡을 수 있지만 identity/admin 키가 분리됐다는 뜻은 아니다.

## 반드시 실행할 프로토콜 검증

아래는 런타임과 통합 환경에서 충족해야 할 행동 검증이다. 실행 근거는 검증 기록을 참조하며 schema 검사만으로 대체하지 않는다.

| ID | 사례 | 기대 결과 |
|---|---|---|
| P-01 | 본문 1 byte 수정 후 기존 revision digest 제출 | 게시 거부 |
| P-02 | active revision의 본문을 직접 overwrite | 새 revision 생성 경로 외 거부 |
| P-03 | 같은 command ID + 같은 payload 재전송 | 하나의 효과와 동일 결과 |
| P-04 | 같은 command ID + 다른 payload | 409 충돌 |
| P-05 | orderer ACK 뒤 timeout/peer 미커밋 | pending/unknown 유지, active로 표시 안 함 |
| P-06 | 필수 역할 승인 누락/abstain/object | activation 불가 |
| P-07 | 다른 revision/policy/scope에 대한 승인 재사용 | activation 불가 |
| P-08 | activation과 object가 경쟁 | 명시한 read counter/CAS 순서에 따라 유효 상태 하나만 확정 |
| P-09 | 두 새 revision이 같은 slot을 동시 대체 | 하나만 VALID, 다른 요청은 새 상태 재검토 |
| P-10 | dependency 철회/정지/대체 | dependent 문서가 normative serving에서 제외 |
| P-11 | policy 필수 조직 제거를 새 정책으로 자체 승인 | 거부 |
| P-12 | role/멤버십 변경 뒤 pending approval 재사용 | 새 역할 기준 재검토 |
| P-13 | 같은 역할의 여러 actor가 서로 다른 결정 | 지정 대표만 blocker/approve 집계; 다른 의견은 advisory |
| P-14 | activation 후 필수 대표 object 커밋 | 동일 tx에서 suspended + epoch 증가 |
| P-15 | timeout 후 같은 command 재시도로 VALID+INVALID tx 발생 | command 성공은 원장 idempotency state 기준; duplicate INVALID로 뒤집지 않음 |
| P-16 | 동일 본문/slot/policy라도 다른 proposal에 승인 복사 | proposal_id binding으로 거부 |
| P-17 | suspend 후 옛 proposal 승인으로 resume | 새 proposal과 fresh 승인 요구 |

## 기밀과 검색 검증

| ID | 사례 | 기대 결과 |
|---|---|---|
| S-01 | private vault에 비밀 canary를 넣고 일반 검색 | 타 부서의 본문·제목·수·로그에 canary 노출 없음 |
| S-02 | private hash 자동 export | 기본 흐름에 export 자체가 없음 |
| S-03 | shared payload 제출 후 chaincode reject | 테스트 canary가 블록에는 남을 수 있음을 확인; publication UI/정책 교육 근거 |
| S-04 | 비인가 사용자가 known revision ID로 조회 | 동일 404, existence oracle 방지 |
| S-05 | 승인 문서에 system/tool permission 변경 문구 | 문서 내용이 실행 권한을 변경하지 않음 |
| R-01 | 같은 '주문 완료'의 세 context | 각 의미 보존, 업무에 맞는 mapping 적용 |
| R-02 | 필요한 mapping 미합의 | clarification/withheld, 유사도 1위로 대체 안 함 |
| R-03 | fence와 철회가 같은 block, fence가 먼저 | fence tx 시점 결과와 이후 action recheck 결과가 구분됨 |
| R-04 | 철회가 fence보다 먼저 | 철회된 지식 normative 제외 |
| R-05 | local projector가 fence tx보다 뒤처짐 | 대기 한도 뒤 503, 오래된 index로 성공 반환 안 함 |
| R-06 | 검색 후 사용자 권한 회수 | 최종 응답 반환 차단 |
| R-07 | 분리된 partition에서 새 normative 요청 | fence 불가로 withheld; historical 표시만 허용 |
| R-08 | context packet 발급 뒤 철회, 이미 LLM 호출 중 | 재검토 표시·후속 부작용 차단; prompt 삭제 보증 안 함 |
| R-09 | query는 confidential인데 fence 호출 | query/doc IDs/run ID가 공용 거래 payload에 없음 |
| R-10 | 원장으로부터 새 index 재구축 | 동일 fixture checkpoint에서 문서·scope·eligibility 결과 일치 |
| S-06 | 기존 channel에 신규 조직 소급 가입 | v1 정책 거부, 새 channel/재공개 절차 요구 |
| S-07 | preview 후 channel config 변경 | publish 거부/새 preview 요구, freeze 중 serving 차단 |
| R-11 | 알 수 없는 write-set schema 또는 full tx 누락 | projector cursor 중단; 성공 checkpoint 발급 금지 |
| R-12 | event 알림 유실, write set 정상 | replay 결과 동일 |
| R-13 | epoch 동일하지만 SSO/private source/tool 권한 철회 | action 재검증 거부, 미공개 산출물 withheld |

## 분산 신뢰와 장애 검증

3-node Raft PoC에서 orderer 1개 crash를 복구하며 중복·거짓 active 상태가 생기지 않는지 확인한다. 이는 Byzantine 검증이 아니다. BFT 프로필은 4개의 독립 관리 경계에서 1개 orderer 장애/악성 행동을 주입하는 별도 실험으로 수행한다. peer/client/gateway 악의는 또 다른 시험이다.

membership 변경 시 serving freeze가 동작하고, infra config와 application registry가 불일치한 동안 normative serving이 열리지 않아야 한다. 사용자가 이미 받은 본문은 회수할 수 없음을 운영 계약에 포함한다.

## 성능·비용 실험

성능 목표는 아직 사용자 SLA가 아니다. 아래 값은 초기 실험의 후보 기준이며 하드웨어·망·문서 분포와 함께 재검토한다.

| 측정 | 초기 후보 목표 | 조건 |
|---|---|---|
| browse metadata 조회 | p95 300ms 이하 | shared 문서 10,000개, 인가 필터 포함, 캐시 유무 분리 |
| 본문/승인 거래 | p95 VALID commit 5초 이하 | 3-node CFT, 4/64/256 KiB 본문을 나누어 측정 |
| normative packet | p95 5초 이하 | fence+projection+digest+권한 확인 포함, 외부 LLM 생성 시간 제외 |
| projector lag | p95 5초 이하 | 항상 exact tx checkpoint 일치 여부를 별도 검사 |
| 복구 | RTO/RPO 측정 후 설정 | full history replay·backup restore·index rebuild 각각 측정 |

기본 용량 예: 문서 10,000개 × 개정 20개 × 평균 본문 20 KiB = **약 4.096 GB의 본문**을 원장 사본마다 보관한다. 여기에 metadata, block/endorsement, state DB, orderer 사본, backup, 검색 인덱스가 추가된다. 압축·dedup 효과는 측정 전 가정하지 않는다.

한 번의 비교 실험에서 local centralized append-only store와 동일한 도메인/합의 규칙도 운영해본다. naive RAG와만 비교해 분산원장의 효과를 과장하지 않는다. 분산 운영의 가치는 독립 관리·단독 변경 저항과 운영비를 함께 평가한다.

## 도입 파일럿

한 개념(`주문 완료`)과 실제 cross-context 업무 하나로 시작한다. 소수 문서를 정리하고 승인해야 하는 사람이 그 scope를 이해하는지 관찰한다. 측정 항목은 해석 혼합 건수, 합의까지 걸린 시간, 필요한 질문/재검토 횟수, 기밀 공개 부담, 두 번째 업무에 재사용한 비율이다. 팀과 도메인 구성은 가설이며 시장 수요 검증은 별도다.

## 운영 중 교체·업그레이드

schema/reducer/signing policy는 버전 고정한다. 새 schema는 옛 payload를 수정하지 않고 새 reader와 새 revision contract를 도입한다. reader를 먼저 배포하고 replay 검증 후 writer를 전환한다. shared channel 분할이나 CFT→BFT 전환은 새로운 trust/config migration이며 일반 앱 배포처럼 무음 변경하지 않는다. full backup, admission freeze, compatibility 확인, 복구 리허설을 거친다.
