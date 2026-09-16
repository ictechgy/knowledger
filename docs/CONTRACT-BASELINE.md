# 계약 기준 초안 / Contract baseline

이 파일은 병렬 작업에서 사용한 요약 기준이다. 최종 계약의 상세 의미는 01–09 설계 문서와 schemas에 있으며, 이 기준은 해당 문서와 일치하도록 유지한다. 런타임 구현이나 운영 보증을 뜻하지 않는다.

- 이름: Knowledger.
- DDD bounded context와 부서/조직은 별도 ID다. 한 부서가 여러 context를 소유하거나 공동 소유할 수 있다.
- 공유 channel의 참여자는 문서 본문과 과거 공유 이력을 볼 수 있다. 공용 원장의 평문을 API ACL만으로 숨기지 않는다.
- 부서 private vault는 공용 원장 밖에 둔다. 원문/임베딩/문서 존재 정보는 자동 공개하지 않는다. 제한된 부서들 간 full-content channel은 추후 확장이다.
- 개인·LLM 초안은 private draft이며, PublishRevision이 명시적으로 공유 경계를 넘는다. 채택되지 않은 공유 제안도 이력에 남는다.
- 공유 문서는 전체 Markdown snapshot으로 기록한다. 한 문서 개정본 + 사용 scope가 의미 합의의 최소 단위다. 부분 합의는 문서를 분리한다.
- DocumentRevision은 immutable. revision digest는 content만이 아니라 context, parent, dependency refs, visibility, body 전체를 묶는다. 해시는 RFC 8785 JCS + SHA-256. examples는 ASCII property names + safe integers의 좁은 JCS 부분집합이다. 원문 Unicode를 서명 후 정규화하지 않는다.
- 합의는 진실 판정이 아니라 특정 context/scope에서 채택한 해석이다. 다른 context의 다른 해석은 허용한다. acceptance SlotKey=(channel_id, document_id, context_id, scope_id, usage_scope)에서 현재 active 개정본은 최대 하나다. v1 revision은 한 SlotKey에 결속한다.
- ApprovalDecision은 immutable proposal_id, revision digest, SlotKey, policy ID/version, application membership epoch와 role binding version에 결속한다. 정지 후 재승인은 새 proposal_id로 수행한다. domain approval과 Fabric peer endorsement는 다르다.
- business policy v1은 각 required domain role의 policy에 지정된 대표 한 명씩 전원 승인을 사용한다. 승인은 개인 수 단순 과반이 아니다. approve/object/abstain/retract를 구분하며 실제 사용자/역할 검증은 schema 밖의 런타임 조건이다.
- proposed/disputed은 검토 상태. active/superseded/withdrawn/suspended는 scope별 agreement 상태다. accepted revision content 자체는 삭제하거나 변경하지 않는다.
- ActivateAgreement는 expected current agreement ID를 CAS 조건으로 받으며 현재 policy/membership/dependency 상태와 모든 required approval을 같은 원장 transaction에서 검증한다. 중복 명령은 command ID + payload digest로 처리한다.
- RAG는 index를 후보 검색에만 사용하고, 본문 반환 직전에 권한/context/active agreement/dependency/철회 상태를 다시 확인한다. query 결과에는 사용한 checkpoint와 실제 제공된 revision refs를 포함한다.
- live freshness는 정책상 신뢰 가능한 checkpoint 확인을 전제로 한다. 연결 단절 중 즉시 철회 보장은 없다. strict 상태를 확인하지 못하면 규범적 결과를 withheld한다. historical 모드는 과거 설명용이며 자동 실행 근거로 사용하지 않는다.
- 실행 manifest는 제공된 근거를 기록하며 LLM이 읽었거나 이해했다는 증명은 아니다. 이미 LLM prompt에 전달된 정보를 삭제할 수 없으므로 후속 부작용은 별도 실행 게이트에서 재검증한다.
- 서명 예제는 unsigned payload 템플릿이다. 실서비스에서는 부서별 signing gateway / Fabric MSP identity, 역할 확인 및 human approval ceremony가 필요하며 example 문자열은 실제 서명/인가 증거가 아니다.

## 파일 소유권

- 메인: README.md, docs/*.
- 계약 작업자: schemas/*, examples/*, tools/validate_design.py, tools/README.md.
- 문서/계약이 충돌하면 임의로 의미를 변경하지 말고 메인에게 알린다.
