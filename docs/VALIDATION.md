# 설계 검증 기록

검증일: 2026-09-15. 환경: Python 3.14.7, 표준 라이브러리만 사용. 새 패키지를 설치하지 않았다.

## 확인한 범위

이 프로젝트는 **설계 산출물**이다. 문서, JSON payload 계약, 예제 및 검사 도구의 정합성을 확인했다. 애플리케이션 서버·Fabric 네트워크·실제 signing·RAG·UI는 구현/배포하지 않았다.

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

런타임 완료 기준은 [구현 계획](07-DELIVERY-PLAN.md)의 P-01–P-17, S-01–S-07, R-01–R-13 및 CFT/BFT·복구 실험이다. 실행 서비스가 아직 없으므로 실행하지 않은 runtime test를 통과로 표시하지 않는다. 성능 수치는 설계 가설이며 benchmark 결과가 아니다.
