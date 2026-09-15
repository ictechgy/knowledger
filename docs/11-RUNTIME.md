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

로그인 흐름은 [개발용 OIDC·서명 서비스 가이드](13-DEVELOPMENT-LOGIN.md)의
`npm run start:login`으로 실행한다. 이 모드는 계정 로그인 뒤 서버의 subject 바인딩으로
actor를 정하며 역할 전환 API를 거부한다. 비밀번호 없는 개발 계정이고 실제 회사 SSO는 아니다.

## KB / LLM 위키 연결

Markdown 본문은 문서 유형에 종속되지 않는다. 기존 KB나 LLM 위키의 공유 가능한 내용을 초안에 넣고 검토·공개·합의한 뒤, `/resolve`의 `documents[].body_markdown`을 지식 패킷으로 사용한다. `manifest`를 실행 기록과 함께 조직 로컬 저장소에 보관하고, 후속 사용 전 `/runs/{run_id}/revalidate`를 호출한다.

[Markdown 가져오기](14-MARKDOWN-IMPORT.md)는 로컬 파일 한 개를 actor별 비공개 초안으로
저장한다. 최대 256 KiB의 UTF-8 원문을 보존하며, 파일명·가져오기 기록은 공용 원장에 넣지 않는다.
공개 검토와 사람의 합의 승인은 기존 절차로 진행한다.

v0.1 resolver는 **정확한 문서 한 개와 하나의 사용 범위**를 받는다. 합의와 전이 의존성을 검사하고 실제 반환한 문서만 manifest에 적는다. `query`는 공용 fence 거래에 기록하지 않는다. 의존 문서의 본문은 자동으로 반환하지 않는다. 필요한 추가 지식은 별도로 범위를 지정해 해석해야 한다.

초기 검색은 권한이 있는 공유 문서의 문자열 검색이다. embedding/vector DB, 원격 KB 동기화, 외부 모델 호출, 임의 도구 실행은 아직 연결하지 않았다. 화면에는 Markdown 원문을 안전한 텍스트로 표시한다.

## HTTP 인터페이스

기본 경로는 `/v1/workspaces/demo`다. [설계 API](06-API.md)는 최종 참조 계약이며, 이 표가 현재 실행 가능한 로컬 API다.

| 경로 | 현재 동작 |
|---|---|
| `GET /api/session` | 데모 세션·역할 목록 또는 OIDC 로그인 상태; 익명 로그인 모드에는 actor·CSRF 없음 |
| `POST /api/session` | 데모 역할 전환; OIDC 로그인 모드에서는 403 |
| `GET /overview` | 공유 개정·합의·제안·역할 정책·체크포인트 |
| `POST /drafts` | actor별 로컬 비공개 초안 |
| `POST /draft-imports/markdown` | UTF-8 파일 → actor별 비공개 초안; import_id 재시도 보존 |
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

로컬 명령은 SQLite commit 후 HTTP 200 `committed`를 반환한다. `--ledger fabric-test-network`에서는 실제 Gateway 제출 후 peer VALID 블록과 영속 projection의 원래 거래 receipt를 확인해야 `committed`다. 확인 대기는 HTTP 202 `pending`, 엄격 조회의 연결·신선도 실패는 HTTP 503이다. [Fabric 웹 실행 가이드](12-FABRIC-WEB.md)를 참조한다.

## 현재 보장과 제한

| 영역 | 구현 | 아직 검증·연결이 필요한 부분 |
|---|---|---|
| 불변 본문/합의 | 공유 TS 도메인 엔진, 엄격 입력 검증, 전체 본문 해시, 최신 대표 승인, CAS, 철회 | 실제 기관의 역할·공개 정책 확정 |
| 로컬 보존 | SQLite 원자적 명령, 전체 write-set 이력, 시점별 projection 재구축 | 독립 조직 운영·외부 백업·복구 목표 |
| Fabric | 같은 엔진의 shim/Gateway, 실제 로컬 3 peer·3 Raft orderer 배포, VALID commit·MVCC INVALID·outbox 복구 검증 | 독립 조직/호스트·운영 인증·네트워크 partition 시험 |
| resolver | 정확한 fence 거래 시점, 영속 Fabric projection·재시작, 실제 HTTP 승인·철회·peer 단절 후 fail-closed 검증 | 큰 원장 catch-up 성능, 운영 보관/백업 정책 |
| 인증/기밀 | loopback·출처/CSRF, actor별 초안·manifest, 개발 OIDC·subject 바인딩·권한 회수, 별도 서명 프로세스 | 실제 회사 SSO·계정 저장, 조직별 권한·KMS·vault 격리 |
| 운영 | 고정된 genesis·정책, 명시적 실패 처리 | 동적 governance, 실제 channel config 변경 감지·freeze·조직 migration |

로컬 원장은 **블록당 거래 한 개**다. 체크포인트의 `transaction_index`는 0이다. 이것을 Fabric에서 fence와 철회가 한 블록에 들어가는 경우의 실증으로 주장하지 않는다. 테스트의 MVCC 모델은 동시 read/write 집합의 기대 동작을 검증한다.

로컬 관리자는 SQLite 파일과 모든 가상 역할에 접근할 수 있다. 로컬 journal hash 연결은 우발적 변조·손상 검출용이며 그 관리자의 악의적 재작성에 저항하지 못한다. 공유 본문은 반환 후 회수할 수 없고, 외부 부작용과 원장 fence 사이의 원자적 트랜잭션을 보장하지 않는다.

공개 검토는 기밀 여부를 자동 판정하지 않는다. Fabric 서명 adapter는 호출자가 제공한 signer를 사용한다. CLI와 웹 테스트 프로필은 승인된 `.data/fabric-smoke/crypto`의 가상 조직 키를 사용한다. 개발 로그인 모드에서는 별도 서명 프로세스만 개인키를 읽는다. 같은 OS 사용자 아래의 프로세스 분리는 HSM이나 독립 조직의 보안 경계를 뜻하지 않는다. 운영 개인 인증·외부 LLM은 연결하지 않았다.
