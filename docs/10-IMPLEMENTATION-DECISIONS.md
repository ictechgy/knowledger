# 10. v0.1 구현 결정

## 채택 확정 — Hyperledger Fabric 기반

사용자 결정: 기존에 검증된 Hyperledger Fabric을 분산원장 기반으로 사용한다. Microsoft Fabric과는 다른 제품이다. 자체 분산 합의 알고리즘이나 범용 블록체인 플랫폼 개발은 현재 제품 범위에 넣지 않는다.

Fabric의 조직 신원·원장 복제·거래 순서 합의·커밋 검증 기능을 활용한다. Knowledger은 도메인별 해석, 정확한 개정본에 대한 사람의 승인, 채택·철회·의존성, 부서 기밀 경계, KB·LLM 위키 및 AI 작업에 제공할 지식 패킷을 구현한다. 사람의 의미 합의와 Fabric 노드의 거래 합의를 구분한다.

도입 편의성은 노드 구성과 운영 절차를 제품에서 안내·자동화하는 방향으로 개선한다. 원장 adapter 경계는 테스트와 유지보수를 위해 유지하고, 실제 운영 통합의 기본 대상은 Fabric으로 고정한다. 로컬 SQLite 모드는 개발·체험용이다. 이 기술 선택의 확정은 실제 Fabric 네트워크 검증 완료를 뜻하지 않는다.

## 공통 TypeScript 합의 엔진

참조 설계의 Go 체인코드를 TypeScript 공통 도메인 엔진과 Node.js Fabric adapter로 변경한다. 로컬에서 쉽게 실행하고, 로컬 모드와 실제 Fabric에서 승인·철회·멱등 규칙을 동일하게 유지하기 위한 선택이다. [Fabric 공식 문서](https://hyperledger-fabric.readthedocs.io/en/latest/cc_service.html)는 Node.js chaincode shim을 지원한다.

로컬 개발에는 Node.js 24 이상과 내장 SQLite를 사용한다. 별도 패키지 설치 없이 지식 작성·공개 검토·합의·맥락 조회를 체험할 수 있도록 한다. 로컬 모드는 **단일 프로세스 개발용 모의 원장**이다. 여러 조직의 독립 보관, Fabric MVCC, 합의 장애 내성, 실제 사용자 인증을 증명하지 않는다. 화면에서 이를 명시한다.

Fabric adapter는 동일한 도메인 엔진을 사용하고 제출자의 인증된 identity에서 actor를 얻는다. 실제 commit 상태가 VALID인지 확인한 뒤 성공을 반환한다. [Gateway의 SubmittedTransaction 문서](https://hyperledger.github.io/fabric-gateway/main/api/node/interfaces/SubmittedTransaction.html)에 따라 endorsement 결과만으로 성공을 판단하지 않는다.

## 초기 도입 범위

### 조직별 개발 실행과 디자인 논의

운영 계정 없이 다음 경계를 검증하기 위해 세 가상 조직의 앱·IdP·signer·private 데이터 폴더를 분리한다.
인증된 조직과 고정된 subject/key/peer 매핑만 사용하고, scoped 폴더의 unscoped/다른 조직 재사용은 거부한다.
초기 폴더 바인딩을 자동 migration으로 사용하지 않는다. 조직 scope를 백업에서 누락하지 않도록 version2
manifest를 도입하고 version1 local/다중 조직 백업 호환성을 유지한다.

브라우저 쿠키는 포트로 분리되지 않는다. 테스트 브라우저도 host/path 기준으로 고쳐 실제 충돌을 재현했고,
앱·IdP의 cookie 이름을 origin별로 나눴다. 이는 개발 편의의 세션 충돌 방지이며 독립 host/OS 관리 경계의 대체가 아니다.

웹 디자인은 사용자 요청에 따라 Claude와 상의했다. 현재 팔레트를 유지하면서 검토함·문서/초안·실행 컨텍스트를
분리하는 방향을 [DESIGN.md](../DESIGN.md)에 기록했다. 먼저 미확정 상태의 자동 숨김과 게시/합의 상태 어휘를 보완하고,
큰 화면 배치 변경은 코드 안정화 뒤 별도 검증한다.

### 초안 재개와 앱 종료 후 DB 복구

초안 목록은 actor/org 조건의 SQL index로 페이지 단위 요약만 조회한다. 원문 전체를 시작 때마다
메모리에 올리거나 별도 목록 테이블에 복제하지 않는다. 다시 저장하면 원본을 보존한 새 private revision을
만들고 문서 ID·slot·의존성·공유 parent를 유지한다. private 편집 출처와 재시도 정보는 공유 payload에 넣지 않는다.

초기 복구 도구는 앱을 종료한 상태의 정확한 로컬/Fabric DB 프로필만 복사한다. 대상 폴더를 새로 확보하고,
복사 전후 hash·SQLite 무결성·원본 변경 여부를 확인한 뒤 파일·디렉터리를 flush하고 완성한다.
인증서·키·로그인 세션과 peer/orderer 자체는 별도 보존 대상이며, 복원 앱은 실제 peer 상태를 다시 확인한다.

### 로컬 Markdown 가져오기를 첫 KB adapter로 선택

외부 서비스 선택이나 인증정보 없이 사용할 수 있는 첫 연결로 단일 파일 가져오기를 구현한다.
브라우저가 선택한 UTF-8 바이트를 actor별 private draft로 저장하고 원래 preview·게시·사람 승인
경계를 재사용한다. 경로·원격 링크·frontmatter를 해석해 추가 파일이나 권한을 자동으로 가져오지 않는다.
원본 파일명·hash는 private record에만 두며 `approved_import`를 합의 승인으로 해석하지 않는다.
actor/import_id로 요청을 식별해 같은 요청의 재시도는 같은 초안을 반환하고 변경된 입력은 거부한다.

### 운영 제공자 선택 없이 개발 로그인 진행

사용자가 개발용 기본 구성은 에이전트가 정해 진행하도록 했다. 따라서 운영 SSO/KMS
이름을 개발의 선행 조건으로 두지 않는다. 표준 `openid-client`와 `oidc-provider`로
loopback 개발 로그인을 구성하고, 승인된 Fabric 테스트 키를 별도 Unix socket 서명
프로세스에서 사용한다. 가상 로그인 계정과 메모리 저장 IdP를 운영 인증으로 표현하지 않는다.

서버의 issuer/subject 바인딩만 actor를 결정한다. 요청 및 각 write phase에 권한을 재검사하고,
전송 전 취소와 전송 후 상태 불명을 구분한다. 로그인 검증 시간까지 HTTP 컨텍스트 제공
유효 시간에 포함한다. 비공개 OAuth token은 서버 메모리에만 두며, 개발 구성에서는
새 운영 인증파일·클라우드 계정·외부 비밀키 설정을 만들지 않는다.

### Fabric 웹 모드와 시간별 영속 projection

웹 서비스는 공통 `ApplicationLedger` 인터페이스로 로컬 모의 원장과 실제 Fabric
테스트 원장에 연결한다. Fabric의 raw block, 거래별 이력과 cursor는 SQLite에
원자적으로 저장한다. 시작 시 원본 replay로 검증·복원하고 새 블록은 증분 적용한다.
생성된 테스트 신원만 사용하는 `fabric-test-network` 모드는 실제 SSO와 구분한다.
테스트 chaincode는 lifecycle sequence를 올려 현재 공통 엔진으로 갱신할 수 있다.

`docs/05-RAG.md`의 fence 거래 시점은 그대로 유지한다. 응답 직전까지 이미 관측한
더 최신 epoch가 있다면 추가로 `FENCE_SUPERSEDED`를 반환한다. 이는 기존 선형화
기준보다 보수적인 제공 정책이며, 확인한 철회를 무시하지 않는 대신 일부 요청을
더 많이 보류할 수 있다. 이미 전달한 문서나 외부 동작의 원자적 철회를 뜻하지 않는다.
명령 receipt의 거래 위치와 블록 끝 상태를 혼동하지 않는다.

### 첫 실제 네트워크 통합의 버전 고정

첫 통합 프로필은 Fabric 2.5.16, shim 2.5.8, Gateway 1.12.1로 고정한다.
기존 v3 계열 참조 설계를 유지하면서, 먼저 2.5 계열의 공식 lifecycle·SDK·공통
도메인 엔진 경계를 확인하기 위한 단계다. Fabric의 선택이나 지식 승인 정책은
바뀌지 않는다. 구체 도구 체크섬과 이미지 digest는 [통합 가이드](../infra/fabric/README.md)에 기록한다.

로컬 프로필은 세 조직 peer와 3-orderer Raft를 한 Docker 호스트에서 실행한다.
이 구성으로 독립 관리 경계나 운영 CFT 장애 내성을 입증하지 않는다.
v3 기반 별도 운영 검증과 독립 4-orderer BFT는 후속 단계다.

### 운영 연결 범위

v0.1은 고정된 채널·역할·합의 정책으로 시작한다. 임의 정책 변경이나 조직 추가 API를 제공하지 않는다. 변경이 필요하면 founders가 새 genesis/channel을 검토한다. SSO·조직 서명 게이트웨이·운영 PostgreSQL/pgvector·BFT 운영은 별도 통합 단계다. 구현 완료 범위와 실제 실행 증거는 검증 기록에 구분해 남긴다.

초기 검색은 맥락을 제한한 문자열 검색이다. 외부 LLM, embedding 서비스, 원격 KB에 연결하지 않는다. 원본 Markdown import/export와 사용한 정확한 개정본을 반환하는 resolver를 통해 기존 도구가 연결할 수 있게 한다.

CI는 Node 24/26 로컬 검사를 실행하도록 작성했다. Actions는 [checkout v7.0.1](https://github.com/actions/checkout/commit/3d3c42e5aac5ba805825da76410c181273ba90b1)과 [setup-node v6.5.0](https://github.com/actions/setup-node/commit/249970729cb0ef3589644e2896645e5dc5ba9c38)의 확인한 commit SHA에 고정했다. 원격 CI 실행은 아직 하지 않았다.

기밀 초안과 run manifest는 로컬 저장소에만 둔다. 공용 원장에는 명시적으로 공개를 확인한 본문만 제출한다. 이 분리는 실제 배포에서 각 조직 gateway/vault를 분리하는 요구를 대체하지 않는다.

### 설정 기반 제품과 선택형 업무 예제 — 2026-09-16

MIT 오픈소스 제품이 특정 세 부서에 종속되지 않도록 workspace·조직·identity·역할·정책·연결을
version1 프로젝트 JSON으로 받는다. `npm start`는 명시적 설정 또는 `knowledger.config.json`이 필요하고,
초기 문서·제안·가상 승인은 만들지 않는다. 주문 업무 seed와 고정 peer/계정/키 선택은
`examples/order-workflow`와 명시적인 `demo:*` 실행으로 옮겼다.

같은 actor ID를 여러 조직에서 사용할 수 있으므로 로컬 계정 선택은 조직과 actor 쌍으로 한다.
Fabric은 선택 조직의 OIDC subject와 서명 route만 연다. 앱 설정의 개인키 본문은 받지 않으며
별도 signer는 명시적인 인증서/키 파일 참조를 사용한다. 고정 HTTPS public origin을 사용하는
reverse proxy 뒤에서도 listener는 loopback이며, 전달된 Host/Origin을 검증한다.

기존 원장에 권한 변경을 조용히 적용하지 않도록 프로젝트 binding에 genesis·로그인 binding을
묶는다. 표시 라벨과 연결 참조의 교체는 별도로 허용한다. 새 configured snapshot은 version3이며
기존 예제의 version1·2를 유지한다. 범용 2·4조직 로컬/API·패키징 검사와 기존 3조직 실제 Fabric
검증을 구분한다. 지식 승인 프로토콜과 인프라 합의 선택에는 변경이 없다.

### KB source와 generation 경계 — 2026-09-16

첫 KB adapter는 명시적인 파일 manifest를 받는 로컬 Markdown 저장소다. 웹 폴더 선택과
Node CLI는 같은 source API를 사용한다. 파일 경로·해시·원본 연결은 actor별 private record에만 두고,
업데이트는 새 초안으로 만든다. source의 version 비교와 operation receipt를 SQLite transaction에
묶어 동시 쓰기·재시작 재시도를 보존한다. 원본 누락 표시는 공유 합의를 자동 철회하지 않는다.

한 source의 present100개/16MiB, 파일당256KiB를 제한한다. 전체 snapshot을 검증한 뒤
누락 원본을 먼저 표시하고 순차로 가져온다. 각 요청은 원자적이며 전체 batch의 일괄 rollback은
제공하지 않는다. 실패하면 멈추고 최신 source version으로 재개한다.

지식 SDK는 Node24의 인증 transport 주입 방식을 선택했다. 자격증명을 탐색하거나 모델 업체를
선택하지 않는다. `GET /revisions/{digest}`로 본문을 다시 검증하고 strict manifest의 동일 binding을
유지한다. 새로운 재검증마다 run ID가 바뀌는 기존 서버 계약을 따른다.

모델 callback은 명시적인 generate/release 권한 검사와 fresh revalidation 사이에서 초안만 만든다.
결과 반환 직전 철회·권한 변경·실패가 발견되면 output을 내보내지 않는다. 이미 모델에 보낸 본문 회수,
callback의 외부 부작용 원자적 취소, 독립 Fabric quorum 검증을 보증하는 라이브러리는 아니다.

### 리뷰 후 조회·대기 경계 — 2026-09-16

같은 슬롯의 모든 개정에 전체 이력을 반복하던 browse 응답을 기본20/최대50 요약 페이지와
선택한 정확한 개정의 원문/이력으로 분리했다. 개발 알파의 목록 호출 계약 변경이며,
SDK 원문 조회와 resolver/fence/재검증 계약은 유지한다. 페이지 cursor는 actor·조건·원장 snapshot에
HMAC으로 결속하고 프로세스 재시작 때 무효화한다. 과거 페이지는 최신 사용 권한의 증거가 아니다.

비공개 import/edit/source CAS는 fresh 인가 뒤 동기 SQLite 구간에서 끝내며, 외부 원장 제출 대기와
service 큐를 공유하지 않는다. 공개 명령은 안정적인 command ID/시각 생성을 위해 순서를 유지하고32개로
진입을 제한한다. Fabric은 projection 적용 순서를 유지하면서 transport 대기 중 refresh를 허용한다.
동시 refresh를 합치되 제출 완료 후에는 이전 세대의 refresh를 사용하지 않는다.

`/healthz`는 원장 통신 없는 생존 확인이다. `/readyz`만 단일 비동기 probe,1초 간격,5초 최대 샘플 나이를
사용한다. 운영 probe의 완만한 관측과 지식 사용 직전 strict freshness를 분리한 것이며,
준비 상태 캐시가 합의나 VALID commit의 근거를 대신하지 않는다.

Fabric projection은 raw journal을 한 블록씩 재생하고 현재 상태만 유지한다. 과거 상태와 검증된 블록 결과는
각각8개 LRU로 제한한다. 최초 VALID 쓰기의 checkpoint·값/거래/raw digest는 현재 key당 하나씩 독립 anchor로
보관한다. SQL 인덱스는 위치 탐색과 파생 view이며 자체 권위가 아니다. 캐시 미스 재생은 현재 상태뿐 아니라
검증 당시 원시 journal의 누적 digest와도 대조해, 나중에 덮어쓴 값의 과거 VALID 메타데이터 변조를 거부한다.

이 변경은 이력을 삭제하거나 무결성 검사를 health로 옮기지 않는다. 모든 durable raw/history 행을 유지하고
재시작 시 파생 creation 인덱스를 재구축한다. 현재 상태 O(keys), 최대8개 과거 상태 복사본, cold replay 비용은
명시적인 확장 한계다. 새로운 블록 합의 알고리즘이나 외부 quorum proof를 추가한 것은 아니다.

### 검증된 조회 참조 인덱스 — 2026-09-16

어댑터가 검증한 journal write에서 compact revision/proposal/agreement 참조를 만든다.
SQLite 커밋 전에 delta를 준비하고 성공 후 공개한다. 재시작에는 기존 검증 pass의 generator를
소비해 메타데이터만 구성하며 인덱스용 파일/schema는 추가하지 않는다.

후보·순서는 이 독립 참조에서 고르고 선택된 원문/상태는 canonical read로 대조한다.
HTTP·cursor·SDK 계약과 strict resolver는 유지한다. 문자열 검색은 같은 JS substring 규칙을 유지하고,
원문을 읽어 구한 digest 목록만 actor/조건/snapshot에 결속해 제한적으로 캐시한다.
구조, 캐시 상한, 비교 측정과 쓰기 비용은 [조회 인덱스](26-BROWSE-INDEX.md)에 기록했다.

### 벡터 후보 검색 읽기 모델 — 2026-09-19

`VectorCandidateIndex` 포트는 임베딩 유사도로 문서 후보만 제안한다. `POST …/vector-search`는
후보 digest를 요청 체크포인트의 검증된 브라우즈 색인·canonical 개정본·`resolveAt` 자격 판정으로
재검증하고, 색인이 제안한 digest 중 체크포인트에서 확인되지 않는 것은 낡은 후보로 버린다.
색인은 지식 사용을 승인하지 않으며, 결과는 `eligible`/`reason`/`active_agreement` 주석을 그대로 실는다.

`document_ids`로 지정한 필수 참조는 색인을 거치지 않고 항상 검증된 색인에서 직접 해상한다.
응답의 `candidate_source`(`derived-scan`|`external-index`)와 `complete`는 후보 수집 범위만 알린다 —
외부 색인 모드에서 빈 페이지는 "지식이 없다"는 증거가 아니다. 외부 색인이 없을 때는
체크포인트의 검증된 개정본을 전수 열거해 점수를 매기므로 후보 집합이 원장 스캔과 동일하다.

개발 어댑터 `LocalVectorIndex`는 검증된 개정본에서 재구축하는 인프로세스 파생 색인이고,
`developmentEmbedding`은 외부 모델 없는 결정적 토큰 해시 임베딩(의미 임베딩 아님)이다.
`PgVectorIndex`는 `index_version`으로 스키마를 구분하는 pgvector 어댑터로, `pg`를 지연 로드해
최소 로컬 런타임이 선택 의존성을 요구하지 않는다. 배포는 `createApp`의 `vectorIndex`·
`embedQuery`·`embedRevision` 옵션으로 실제 임베딩 프로파일을 주입한다.

### 모델 egress 서버 게이트 — 2026-09-19

검색 권한이 외부 모델 전송 권한을 함축하지 않으므로 `modelEgress` 정책을 서비스 옵션으로 둔다.
`policy_version`은 manifest의 `model_egress_policy_version`에 실리고, 호출자가 `model_adapter_id`를
지정하면 `resolve`는 manifest 발급 전에, `revalidate`는 release 직전에 `allows` 콜백으로 현재
전송 권한을 확인한다 — 정책 거부는 `EGRESS_POLICY_DENIED`, 훅 예외(정책 저장소 장애)는
`EGRESS_POLICY_UNAVAILABLE`로 구분해 withheld하고, allows 미설정 시 어댑터 요청은 허가 근거가
없어 거부된다. resolve는 요청 어댑터를 run 기록에 결속하고 revalidate는 다른 어댑터·무어댑터
재검증을 `EGRESS_ADAPTER_MISMATCH`로 거부해 egress 확인 우회를 막는다.
`revalidate`는 policy·membership epoch·egress version·retrieval profile 결속 필드를 서버에서도
대조해 클라이언트 검증만에 의존하지 않는다 — `egressVersion`은 한 boot 안에서 상수라 이 대조는
run 기록 변조에 대한 심층 방어다(재시작은 boot_id 검사가 먼저 차단한다).
`guardedGeneration`은 `adapterId`를 resolve와 두
revalidate 호출에 전달해 클라이언트 `authorize` 콜백과 서버 정책 게이트가 같은 어댑터를 가리킨다.
게이트의 보호 범위는 **선언된 어댑터로의 전송**이다 — `model_adapter_id` 없이 resolve하면 어댑터
결속 없는 manifest가 발급되며, 그 출력을 어디로 보내든 서버가 알 수 없다. 미선언 경로는 위협
모델 밖이므로(제공된 본문의 자체 유출은 게이트가 통제할 수 없다), 모든 resolve를 어댑터 선언으로
강제하려는 배포는 자체 게이트웨이에서 요청 수준 정책을 둬야 한다.
현재 manifest 계약에는 어댑터 식별자가 없어 manifest만으로는 발급 대상 어댑터를 감사할 수
없다 — 결속은 vault run 기록에만 있다. 후속 계약 버전에서 manifest에 `model_adapter_id`를
포함해 `validateRefreshedManifest` 비교 대상에 넣는 것을 검토한다.
