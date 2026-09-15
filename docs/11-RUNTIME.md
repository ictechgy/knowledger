# 11. 실행 가이드와 현재 구현 경계

## 빠른 시작

Node.js 24 이상에서 실행한다. 로컬 앱과 테스트에는 외부 npm 패키지가 필요 없다.

```sh
npm start
```

브라우저에서 `http://127.0.0.1:4317`을 연다. 가상 영업·물류·정산 책임자와 AI 초안 작성자가 준비되어 있다. 기본 저장 위치는 `.data/demo`이며 Git에서 제외한다. 공유 원장과 로컬 비공개 저장소는 서로 다른 SQLite 파일이다.

```sh
npm start -- --port 4318 --data .data/second-demo
npm run demo
npm run check
```

`--data`에 새 폴더를 지정하면 기존 데이터에 손대지 않고 새 데모를 시작한다. 종료는 실행 터미널에서 Ctrl+C다. 기본 genesis는 [demo-config.ts](../apps/api/demo-config.ts)에 있다. 이미 초기화된 원장의 genesis를 코드 변경으로 덮어쓰지 않는다.

## 화면에서 해볼 흐름

1. 각 도메인의 `주문 완료` 정의를 읽는다. 초기 예제에서 세 정의는 각자의 책임자 합의가 있으며, 리뷰 요청 규칙은 미합의 상태다.
2. 물류 책임자로 리뷰 요청 규칙을 승인한다. 정산 책임자로 전환해 승인한 후 합의를 활성화한다.
3. 해당 context·scope·usage scope로 조회한다. 본문과 정확한 개정·채택·승인·체크포인트 manifest가 반환된다.
4. 문서를 수정하면 비공개 초안이 된다. 공개 검토에서 본문과 복제 대상 조직을 확인한 후 공유한다. 새 개정본은 새 제안·승인 없이는 채택되지 않는다.
5. 의존 문서의 합의를 철회하거나 채택한 제안에 이의를 제기하면 resolver는 사용을 보류한다. 기존 실행 기록도 재검증에서 차단된다.

역할 전환은 데모 조작이다. 실제 사람의 로그인·인증·전자서명으로 해석하면 안 된다.

## KB / LLM 위키 연결

Markdown 본문은 문서 유형에 종속되지 않는다. 기존 KB나 LLM 위키의 공유 가능한 내용을 초안에 넣고 검토·공개·합의한 뒤, `/resolve`의 `documents[].body_markdown`을 지식 패킷으로 사용한다. `manifest`를 실행 기록과 함께 조직 로컬 저장소에 보관하고, 후속 사용 전 `/runs/{run_id}/revalidate`를 호출한다.

v0.1 resolver는 **정확한 문서 한 개와 하나의 사용 범위**를 받는다. 합의와 전이 의존성을 검사하고 실제 반환한 문서만 manifest에 적는다. `query`는 공용 fence 거래에 기록하지 않는다. 의존 문서의 본문은 자동으로 반환하지 않는다. 필요한 추가 지식은 별도로 범위를 지정해 해석해야 한다.

초기 검색은 권한이 있는 공유 문서의 문자열 검색이다. embedding/vector DB, 원격 KB 동기화, 외부 모델 호출, 임의 도구 실행은 아직 연결하지 않았다. 화면에는 Markdown 원문을 안전한 텍스트로 표시한다.

## HTTP 인터페이스

기본 경로는 `/v1/workspaces/demo`다. [설계 API](06-API.md)는 최종 참조 계약이며, 이 표가 현재 실행 가능한 로컬 API다.

| 경로 | 현재 동작 |
|---|---|
| `GET /api/session` | 로컬 데모 세션·CSRF 토큰·가상 역할 목록 |
| `POST /api/session` | 데모 역할 전환; 새 CSRF 토큰 반환 |
| `GET /overview` | 공유 개정·합의·제안·역할 정책·체크포인트 |
| `POST /drafts` | actor별 로컬 비공개 초안 |
| `POST /publication-previews` | 본문 digest·현재 config·조직·5분 만료에 묶인 공개 검토 |
| `POST /revisions` | `confirm_shared: true`로 검토한 개정 게시 |
| `POST /agreement-proposals` | 정확한 revision/policy에 대한 새 제안 |
| `POST /agreement-proposals/{id}/decisions` | 서버가 actor와 정확한 제안 바인딩을 채운 결정 |
| `POST /agreement-proposals/{id}/activate` | expected active ID 비교 후 채택 |
| `POST /agreements/{id}/withdraw` 또는 `/suspend` | 지정 책임자의 사용 철회·정지 |
| `GET /documents/{id}`, `GET /agreements/{id}` | 공유 이력·현재 상태 |
| `GET /events?cursor=0` | 로컬 공유 원장 write set, 최대 100 거래씩 |
| `POST /search` | 공유 본문·제목 및 선택한 범위 검색 |
| `POST /resolve` | 새 fence와 시점별 상태에 근거한 지식 패킷 또는 withheld |
| `POST /runs/{id}/revalidate` | `action: use-context`의 현재 지식 사용 가능 여부 재검증 |

쓰기 요청은 `application/json`, 동일 출처, 로컬 세션 cookie, `X-KCL-CSRF`가 필요하다. 토큰을 로그에 남기지 않는다. 합의 변경에는 `command_id`가 필수다. 동일 조직/명령 ID로 다른 actor나 본문을 보내면 충돌한다. HTTP 계층은 처음 만든 결정 ID·시각까지 저장해 재시도 때 바뀌지 않게 한다.

로컬 명령은 SQLite commit을 기다린 뒤 HTTP 200과 `status: committed`를 반환한다. 이는 로컬 모의 원장의 commit이다. 실제 Fabric 명령의 비동기 pending/VALID 검증은 별도 [Fabric adapter](../infra/fabric/README.md)가 담당하며 웹 서버에 선택 가능한 운영 모드로 연결된 상태는 아니다.

## 현재 보장과 제한

| 영역 | 구현 | 아직 검증·연결이 필요한 부분 |
|---|---|---|
| 불변 본문/합의 | 공유 TS 도메인 엔진, 엄격 입력 검증, 전체 본문 해시, 최신 대표 승인, CAS, 철회 | 실제 기관의 역할·공개 정책 확정 |
| 로컬 보존 | SQLite 원자적 명령, 전체 write-set 이력, 시점별 projection 재구축 | 독립 조직 운영·외부 백업·복구 목표 |
| Fabric | 같은 엔진의 shim/Gateway adapter와 테스트 | 실제 peer/orderer/CA 배포·endorsement·SDK 의존성 설치·네트워크 장애 시험 |
| resolver | fresh local fence, 정확한 transaction 위치, 의존성 검증, 실제 승인 refs | Fabric 블록 해독·VALID write-set 이벤트 투영·동일 블록 여러 거래 통합 시험 |
| 인증/기밀 | loopback, 출처/CSRF 검사, actor별 초안·manifest, 공개 확인 | SSO/개별 사용자 서명, 조직별 프로세스·KMS·vault 분리 |
| 운영 | 고정된 genesis·정책, 명시적 실패 처리 | 동적 governance, 실제 channel config 변경 감지·freeze·조직 migration |

로컬 원장은 **블록당 거래 한 개**다. 체크포인트의 `transaction_index`는 0이다. 이것을 Fabric에서 fence와 철회가 한 블록에 들어가는 경우의 실증으로 주장하지 않는다. 테스트의 MVCC 모델은 동시 read/write 집합의 기대 동작을 검증한다.

로컬 관리자는 SQLite 파일과 모든 가상 역할에 접근할 수 있다. 로컬 journal hash 연결은 우발적 변조·손상 검출용이며 그 관리자의 악의적 재작성에 저항하지 못한다. 공유 본문은 반환 후 회수할 수 없고, 외부 부작용과 원장 fence 사이의 원자적 트랜잭션을 보장하지 않는다.

공개 검토는 기밀 여부를 자동 판정하지 않는다. 개인키/인증파일을 읽거나 외부 LLM에 보내는 통합은 없다. Fabric 서명 adapter는 호출자가 제공한 signer를 사용하도록 한다.
