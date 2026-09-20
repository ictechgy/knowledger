# 06. API 계약

이 문서는 API의 설계 계약이다. 구현된 개발 알파의 지원 범위는 [실행 가이드](11-RUNTIME.md)에 구분한다. JSON payload의 기본 구조는 [schemas](../schemas/)에 두며 endpoint별 서명·현재 정책·transaction 검증은 런타임 책임이다.

구현된 앱 단위 댓글·기한·알림·변경 영향 경로와 정확한 입력은
[검토 워크스페이스 API](31-REVIEW-WORKSPACE.md)에 정리한다. 이 운영 기록은 원장 명령과
분리되고, actor별 `operation_id`와 일정 `expected_version`을 사용한다.

선택형 [댓글 전달 API](33-REVIEW-DELIVERY.md)는 작성자 확인·고정 수신자·영속 재시도 큐와
peer 인증 수신을 제공한다. 전달 상태의202/영수증은 원장 커밋 상태와 구분한다.

## 공통 규약

- Base path: `/v1/workspaces/{workspace_id}`. workspace와 Fabric channel은 v1에서 1:1로 매핑한다.
- HTTPS, 조직별 issuer allowlist, audience 검증, domain role 확인. query payload를 application log에 기본 저장하지 않는다.
- 쓰기 요청에는 `Idempotency-Key`와 payload digest를 결속한다. 같은 조직/key의 다른 payload는 409다.
- 개정본·scope·policy는 versioned identity로 참조한다. `latest`는 사람이 탐색할 때만 사용하고 approval 또는 manifest에 저장하지 않는다.
- 요청 수신 응답은 202 + command ID/transaction ID + `pending`이다. 이미 VALID인 동일 요청은 200 + 원래 결과다. 조직별 durable submission row에 동일 command의 여러 시도 tx ID를 묶고 committed idempotency state를 기준으로 집계한다.
- 상태는 `pending | valid | invalid | unknown`을 구분한다. timeout을 거절/미실행으로 단정하지 않는다.
- 응답의 시간 필드는 관측/주장 시각이며 ledger ordering을 대체하지 않는다.

## 명령

| Endpoint | 동작 | 주요 조건 |
|---|---|---|
| `POST /drafts` | 부서 vault에 private draft 생성 | 공용 ledger transaction 없음 |
| `POST /publication-previews` | 본문·metadata·공유 대상·보존 범위 확인 | preview token은 payload digest와 channel configuration version에 결속 |
| `POST /revisions` | 전체 본문 snapshot 게시 | preview의 config/entitlement/payload가 현재와 같은지 확인, publication gate 확인, 본문/refs·digest 검증 |
| `POST /agreement-proposals` | revision+context/scope+policy로 검토 개시 | 정확한 revision과 immutable scope version, 정책상 owner |
| `POST /agreement-proposals/{proposal_id}/decisions` | approve/object/abstain/retract | signed proposal_id가 route/state target과 같은지 확인; 조직 gateway의 attribution + 현재 role binding |
| `POST /agreement-proposals/{proposal_id}/activate` | 해당 slot active 상태 확정 | expected active ID, 모든 required approval, object 부재, dependency, CAS |
| `POST /agreements/{id}/withdraw` | 사용 철회 | 정책상 철회 권한; epoch 증가 |
| `POST /agreements/{id}/suspend` | 비상 사용 정지 | 지정 safety role; 사용 확대 불가 |
| `POST /agreements/{id}/resume` | 정지 해제 | 새 proposal_id의 현재 정책 아래 fresh 승인; 과거 검토 회차 재사용 금지 |
| `POST /governance/changes` | policy/context ownership/role binding 변경 | 기존 governance 정책으로 승인, registry/epoch 동기 갱신 |
| `POST /fences` | epoch 확인 transaction | 무작위 nonce, query/문서 목록 제외 |

`retract`는 `retracts_decision_id`로 자신의 이전 decision ID를 정확히 지정한다. 활성 합의의 필수 승인을 철회하면 사용 eligibility도 바뀐다. 철회한 객체의 bytes를 삭제하지 않는다.

개발 알파의 draft 생성·수정·Markdown 가져오기는 [공유 개정 참조](15-PRIVATE-DRAFTS.md)를
선택할 수 있다. 호출자는 digest·관계·사용 조건을 보내고 서버가 canonical 개정에서 전체
slot을 채운다. 새 참조는 새 revision digest에 결속되며 지식 사용 판정과 사람 승인은 별도다.

## 질의와 RAG

| Endpoint | 반환 |
|---|---|
| `GET /commands/{command_id}` | ledger submit/commit 상태와 안전한 오류 |
| `GET /documents/{document_id}` | 허용된 context/scope별 개정·합의 view |
| `GET /revisions/{revision_digest}` | 인가된 본문 snapshot + digest |
| `GET /revisions/{revision_digest}/view`, `/history` | 선택한 원문·상태 / 같은 슬롯의 개정 요약 페이지 |
| `GET /agreements/{agreement_id}` | 상태·policy·결정·dependencies·effective eligibility |
| `GET /events?cursor=...` | 허용된 channel의 변경 feed; opaque cursor |
| `POST /search` | browse 후보 + projection checkpoint; 규범적 사용권 증명 아님 |
| `POST /vector-search` | 벡터 색인 후보 + 같은 checkpoint의 원장 eligibility 재검증; 색인은 자격 증명 아님 |
| `POST /resolve` | fence에 결속된 normative 또는 historical packet; `model_adapter_id` 지정 시 현재 모델 egress 정책 확인 |
| `POST /runs/{run_id}/revalidate` | 현재 SSO·application entitlement·channel 정합성·private source 권한/상태·모델 egress·tool 권한 + 새 fence와 manifest 비교; 정책·epoch·egress 결속 필드 불일치·`EGRESS_POLICY_DENIED`/`EGRESS_POLICY_UNAVAILABLE`·run에 결속된 어댑터와 다른 `EGRESS_ADAPTER_MISMATCH`는 withheld |

Private vault endpoint는 조직별 origin과 권한 범위에서 제공한다. common API가 private source URI를 임의로 fetch하지 않는다. private source 연결은 allowlisted adapter만 사용하고 SSRF 방지·egress 권한을 적용한다.

현재 browse API는 기본20/최대50 요약과 actor·조회 조건·snapshot에 결속된 cursor를 사용한다.
본문과 누적 이력은 목록마다 반복하지 않는다. 상세 응답 필드와 개발 알파 호출자 변경 사항은
[실행 API의 조회 페이지 계약](11-RUNTIME.md#조회-페이지와-원문)에 있다. 규범적 사용 판정의 fence 계약은 유지한다.

## 오류

| 코드 | HTTP | 의미 / 클라이언트 처리 |
|---|---|---|
| `INVALID_PAYLOAD` | 400 | 지원하지 않는 형식/필수 항목 누락; 원문을 오류에 반사하지 않음 |
| `DIGEST_MISMATCH` | 400 | payload와 digest 불일치 |
| `UNAUTHENTICATED` | 401 | 인증 필요 |
| `NOT_FOUND_OR_NOT_VISIBLE` | 404 | 비인가/미존재를 구분하지 않음 |
| `IDEMPOTENCY_CONFLICT` | 409 | 같은 key에 다른 payload |
| `REVISION_CONFLICT` | 409 | expected base/active가 현재와 다름 |
| `POLICY_CHANGED` | 409 | policy/role/application membership epoch 변경; 재검토 |
| `APPROVAL_REQUIRED` | 409 | 필수 역할 승인 누락 또는 이의 존재 |
| `SCOPE_UNRESOLVED` | 409 | 필요한 context/mapping 합의가 없음 |
| `DEPENDENCY_INELIGIBLE` | 409 | 근거 agreement가 철회·대체·정지 등으로 사용 불가 |
| `PAYLOAD_TOO_LARGE` | 413 | text-only 게시 크기 한도 초과 |
| `RATE_LIMITED` | 429 | 조직별 한도, Retry-After 제공 |
| `FRESHNESS_UNAVAILABLE` | 503 | VALID fence 확인 불가; strict 결과 withheld |
| `PROJECTION_BEHIND` | 503 | fence tx까지 projection이 따라오지 못함 |

오류 body는 `{code, message, retryable, request_id}`와 필요한 비민감 conflict reference만 포함한다. stack trace, secret, 문서 본문, private path를 응답하지 않는다. `APPROVAL_REQUIRED`와 충돌 원인은 해당 proposal을 볼 수 있는 사용자에게만 자세히 표시한다.

## 권한/일관성 규칙

- 상태를 바꾸는 명령은 chaincode의 point reads와 counter keys를 이용한다. rich query 결과만으로 필수 승인 부재·이의 부재를 판단하지 않는다.
- proposal별 `review_version`을 모든 decision 변경에서 올리고 Activate가 읽는다. 동일 블록에서 늦게 들어온 이의를 MVCC 경합으로 처리할 수 있어야 한다.
- SlotKey=(channel_id, document_id, context_id, scope_id, usage_scope)를 모든 binding에 사용한다. context/scope 이름의 뜻을 같은 ID로 조용히 재정의하지 않는다. v1 usage scope는 예를 들어 `review-invitation/v1`처럼 immutable version ID다. 새 의미는 새 ID 또는 새 합의 revision으로 표현한다.
- 디지털 서명 검증은 `서명한 조직이 이 actor/role의 attribution을 할 권한이 있는가`까지 확인한다. 예제 JSON의 actor 문자열만으로 승인하지 않는다.
- ACL/SSO revocation은 반환 직전 다시 확인하며 runtime interface가 source 권한을 우회하지 못한다.

## 크기와 리소스 제한

초기 후보 상한은 UTF-8 Markdown 본문 256 KiB, revision payload 512 KiB, parent 2개, dependency 32개, dependency traversal depth 8, 탐색하는 고유 dependency 노드 256개다. 개정 이력의 총 길이를 8개로 제한하지 않는다. 이 값은 **설계 기본값**이며 1 MiB급 확장은 부하 실험 후 결정한다. JSON Schema의 문자 수 제한과 byte 상한은 서로 다르므로 ingress와 chaincode가 byte 크기를 별도 검사한다. channel의 최대 transaction 크기는 payload+endorsement overhead보다 커야 한다. 첨부 binary·base64 본문 우회는 거부한다.

Normative candidate batch 크기, fence retry 수, projector wait 시간은 versioned serving policy로 고정한다. 초기 제안은 후보 20개, 충돌 재시도 최대 2회, projector wait 최대 5초다. 실제 SLA가 아니라 P0/P1에서 측정할 시작값이다.

## 기계 계약과 추가 런타임 조건

| Schema | 핵심 wire binding | schema 밖에서 확인할 것 |
|---|---|---|
| document-revision | wrapper `revision_digest` + full `payload`; SlotKey, body, parents/dependencies, author/source metadata | 공개 허가, 등록된 context/slot, ledger 동일성, 실제 서명 |
| agreement-policy | SlotKey, policy version, application membership epoch, role binding snapshot, 지정 대표 목록 | 기존 governance 권한, 대표의 현재 registry 일치 |
| approval-decision | exact proposal_id/revision/SlotKey/policy/epochs, actor 조직·ID·role, decision | gateway 서명, human intent attribution, 같은 actor의 retract 대상, object 이후 상태 전이 |
| run-context-manifest | exact tx checkpoint/eligibility epoch, normative/reference sources, decision refs, local private refs, retrieval/authz/egress profile | 실제 VALID commit, 현재 접근/전송/실행 권한, 유효한 runtime agreement |

`source_kind=llm_drafted`는 문서의 생성 출처이며 승인 상태가 아니다. `agreement_id`는 normative manifest와 런타임 agreement registry에만 있고 불변 document payload 안에 넣지 않는다. `subject_id`는 예제의 업무 대상 ID이며 로그인 subject와 동일시하지 않는다. actor 인증은 별도의 issuer/subject/role binding을 검증한다.

Manifest의 `retrieval_profile_id`는 parser/chunker/embedding/index 설정을 담은 불변 로컬 configuration snapshot을 가리킨다. `authorization_snapshot_id`도 당시 판단 자료를 가리키는 로컬 ID일 뿐 현재 권한을 대체하지 않는다. JSON schema는 payload 형식이며 의미 합의·실제 서명·현재 인가까지 증명하지 않는다.
