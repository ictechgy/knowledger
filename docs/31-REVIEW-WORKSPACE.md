# 31. 검토 대화·일정과 변경 영향

공유 개정을 선택하면 **검토 대화·일정**에서 댓글, 알릴 사람, 담당자, 기한을 관리한다.
작성자 또는 해당 범위의 정책 대표자가 일정을 설정하고, 지정된 사람 검토자가 완료 메모를
남긴다. 여러 담당자는 한 검토 작업을 함께 맡으며, 한 명의 완료가 작업을 완료한다.
합의에 필요한 각 대표자의 승인은 기존 **합의 검토**에서 별도로 받는다.

## 첫 문서에서 재검토까지

1. `npm run config:init -- --workspace knowledge --organization ExampleOneMSP --organization ExampleTwoMSP`
   로 새 설정 파일을 만든다. 기존 파일은 덮어쓰지 않는다. 조직·계정·범위·승인 정책을 확인한 후
   [설정 안내](19-PROJECT-CONFIGURATION.md)에 따라 앱을 시작한다.
2. **새 지식 문서 작성**에서 정책과 제목을 고르고, 빈 본문에 업무 가이드·용어/판단 기준·결정
   기록 템플릿을 적용한다. 비공개 초안, 게시 미리보기, 공유 게시 순으로 진행한다.
3. 게시된 정확한 개정에서 댓글과 검토 기한을 지정한다. 담당자와 명시적으로 알릴 사람에게
   앱 내 알림이 저장된다. 자신의 작성 작업은 자신에게 알림을 만들지 않는다.
4. 알림 또는 기한 목록을 열면 해당 개정이 고정된다. 새 개정이 게시되어도 이전 댓글과 일정은
   이동하지 않는다. 검토 완료는 승인이나 지식 사용 허가를 만들지 않는다.
5. **변경·철회 영향**에서 연결된 개정과 현재 사용 가능 여부를 확인한다. 영향받는 개정의
   **수정본 작성**은 원문·부모·참조를 유지한 비공개 작성으로 이어진다.
6. **이 개정 재검토 제안**은 기존 제안 API를 사용해 새 proposal을 만든다. 이전 proposal의
   승인은 재사용되지 않는다. 실제 사용 전에는 항상 resolve/revalidate가 필요하다.

## 저장과 공개 범위

검토 기록은 `private-local.sqlite`의 별도 `review_*` 테이블에 보관한다. 이 앱 설치에
접속할 수 있는 구성원에게 공유되는 운영 기록이다. 개인 초안 테이블과 조회 경로를 분리하며,
댓글은 원장·승인 근거·Fabric VALID 커밋 증명이 아니다. 앱 저장소 운영자는 이 기록을 볼 수 있다.

로컬 시뮬레이션은 구성된 가상 조직들이 한 앱을 함께 사용한다. 조직별 Fabric 앱은 해당
조직의 persona만 대상으로 하므로 **다른 조직 앱과 댓글·일정·알림을 자동 복제하지 않는다**.
선택한 본인 댓글만 별도 앱의 지정 수신자에게 보내는
[전달 인터페이스·재시도 큐](33-REVIEW-DELIVERY.md)는 선택적으로 구성할 수 있다.
이를 조직 간 공통 댓글 원장으로 간주하지 않는다. 외부 메일·Slack·Teams 전송도 없다.
알림과 기한은 앱 시작·목록 갱신·기록 저장 후 조회하며, 백그라운드 스케줄러는 설치하지 않는다.

기존 [정지 후 백업·새 폴더 복원](16-RUNTIME-BACKUP.md)에 검토 테이블도 포함된다.
오래된 DB에는 앱 시작 시 테이블을 추가한다. 이전 앱 버전으로 돌아가도 추가 테이블은 남고
기존 승인·초안 데이터는 유지된다. 댓글 수정·삭제·보존 기한 자동 정리는 아직 제공하지 않는다.

## API

모든 경로의 접두사는 `/v1/workspaces/:id`다. 세션·현재 actor 인가와 POST CSRF 검사를 따른다.

| 경로 | 의미 |
| --- | --- |
| `GET /revisions/:digest/review?limit=20&cursor=...` | 해당 공유 개정의 일정·최신 검토 기록·지정 가능한 사람 |
| `POST /revisions/:digest/review/comments` | `operation_id`, `body`, 선택 `mentions: [{org_id, actor_id}]` |
| `POST /revisions/:digest/review/schedule` | `operation_id`, `expected_version`, `assignees`, `due_at`, `repeat_after_days` |
| `POST /revisions/:digest/review/complete` | `operation_id`, `expected_version`, `body`로 사람 검토 완료 |
| `GET /review-notifications?limit=20&cursor=...` | 현재 actor에게만 전달된 알림·읽지 않은 수 |
| `POST /review-notifications/:event_id/read` | 빈 객체로 본인의 알림을 읽음 처리 |
| `GET /review-due?limit=50` | 현재 actor의 기한이 된 작업, 기한순 최대 50개·`has_more` |
| `GET /revisions/:digest/impact?limit=20&cursor=...` | 정확한 원장 체크포인트의 직접·전이 참조와 eligibility |

댓글은 1~4,000자, 멘션/담당자는 중복 없는 사람 최대 16명이다. AI actor도 자신의 종류가
표시되는 댓글을 남길 수 있지만 일정 설정·사람 검토 완료는 할 수 없다. 게시되지 않은
비공개 digest는 검토 대상으로 사용할 수 없다. 클라이언트가 actor·공유 범위를 지정하지 않는다.

최초 일정의 `expected_version`은 0이다. `due_at`은 `2026-10-01T00:00:00.000Z`처럼 엄격한
UTC ISO 문자열 또는 `null`, `repeat_after_days`는 1~3,650 또는 `null`이다. 반복 일정에는
기한이 필요하다. 완료 후 반복 기한은 **실제 완료 시각 + 지정 일수**로 정한다. 일회성 작업은
기한을 비운다. 이미 완료한 작업은 다음 기한 전까지 다시 완료할 수 없으며, 담당자를 포함한
일정 수정은 새 버전을 만든다. 기한 경과 자체가 지식 사용을 차단하지 않는다.

이벤트·일정 CAS·수신자 알림을 하나의 SQLite 트랜잭션에 저장한다. `operation_id`는 actor별
검토 작업 전체에서 유일하며, 같은 내용 재시도는 원래 이벤트를 반환하고 다른 내용은 409다.
기록/알림 목록은 최신순 keyset 페이지로, 페이지 중 새 항목이 추가되어도 기존 페이지를
밀어내지 않는다. 원장 스냅샷과 달리 일정과 읽음 상태는 현재 값이다. 기한 목록에 50개가
넘으면 처리 후 새로고침해 다음 작업을 확인한다.

## 영향 해석

검증된 원장의 공유 개정을 훑어 전체 slot이 일치하는 역방향 참조를 만든다. 모든 간선이
`requires_active`인 경로가 하나라도 있으면 `required`, 그 외에는 `informational`로 표시한다.
`depth`와 `via_revision_digest`는 해당 종류의 최단 경로를 설명한다. 순환과 중복 경로는
중복 집계하지 않는다. 결과에는 과거 개정도 포함된다. 참조 경로가 있다는 사실만으로 현재
문서가 차단되었다고 단정하지 않으며, 각 행의 `eligible`은 반환된 체크포인트에서 따로 계산한다.

페이지 커서는 actor·기준 digest·정확한 checkpoint에 결속한다. 시작 시와 반환 전 현재
인가를 확인한다. 브라우저 목록으로 승인이나 use 권한을 부여하지 않는다. 조회 상한은
공유 개정 100,000개·참조 500,000개이며, 초과하면 불완전한 목록 대신
`IMPACT_CAPACITY_EXCEEDED`를 반환한다. 매 요청에서 다시 계산하므로 대형 이력의 영향 조회는
일반 브라우즈보다 비싸다. AI run manifest와 외부 업무 시스템의 역방향 영향 추적은 별도 범위다.

## 검색 품질 측정

`createConfiguredApp`은 `embedQuery`, `embedRevision`, `vectorIndex` 옵션을 `createApp`에 전달한다.
임베딩 함수 둘은 반드시 같은 공간의 쌍으로 제공한다. 외부 색인은 명시적인 임베딩 쌍을
요구하며 앱이 종료할 때 닫는다. 미설정 기본값은 개발용 토큰 해시이고 의미 검색 모델이 아니다.
실제 공급자·모델·전송 범위와 자격정보는 배포에서 지정해야 한다.

`packages/measurement/retrieval.ts`의 `evaluateRetrieval(client, cases, k, options)`는
기존 `KnowledgerClient`를 받아 `/vector-search`와 정상 `resolve` 경로를 실행한다.
각 사례는 다음 형태다(정답 digest는 실제 채택한 개정으로 바꾼다).

```ts
const cases = [{
  id: 'case-guideline', query: '이 상황의 판단 기준은?',
  context_id: 'context-shared', scope_id: 'scope-primary', usage_scope: 'reference/v1',
  relevant_revision_digests: [knownRevisionDigest],
  use: { document_ids: ['doc-shared-guideline'], expected_status: 'provided' },
}];
const report = await evaluateRetrieval(client, cases, 5);
```

철회·의존성 철회·범위 불일치 사례는 `expected_status: 'withheld'`로 함께 넣는다. 로컬
시뮬레이션을 의도적으로 측정할 때만 `{allowDevelopment: true}`를 지정한다. 모델 전송
정책이 필요하면 `modelAdapterId`도 명시한다. resolve는 기존 run/fence 기록을 만들며,
평가가 승인 또는 모델 생성을 수행하지 않는다. 각 사례는 조회와 사용 판정을 순서대로 실행하므로
동일한 단일 원장 스냅샷 평가가 아니다. 재현하려면 평가 중 데이터 변경을 통제한다.

보고서는 precision@k(분모 k), recall@k, MRR@k와 예상하지 않은 제공/보류 건수를 나눈다.
정답이 없는 사례의 recall/MRR은 `null`로 평균에서 제외하고 제공/보류 판정은 포함한다.
입력 사례를 전부 검증한 뒤 요청하며, 실패를 좋은 점수로 덮지 않는다. 질의 원문·문서 본문은
보고서에 넣지 않지만 case ID·개정 digest는 포함한다. 테스트의 가상 점수는 실제 검색 모델의
정확도 또는 경쟁 제품 대비 성능 증명이 아니다.
