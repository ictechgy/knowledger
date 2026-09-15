# Fabric 웹 테스트 모드

계정 로그인과 별도 서명 프로세스를 함께 실행하려면 [개발용 로그인 가이드](13-DEVELOPMENT-LOGIN.md)의
`npm run start:login`을 사용한다. 아래 모드는 기존 가상 역할 선택 테스트다.

실제 Fabric peer에 연결해 기존 웹 화면에서 문서를 게시·승인·채택·철회한다.
이 프로필은 **loopback 전용, 가상 테스트 사용자**다. 세 조직의 테스트 서명 키가
한 프로세스에 있으므로 운영의 조직별 독립 인증·vault·KMS 경계를 대신하지 않는다.

## 실행

Node 24 이상과 [Fabric 테스트 네트워크](../infra/fabric/README.md)가 필요하다.
현재 작업 환경에서는 Colima의 `colima` context와 `.data/fabric-smoke/crypto`에
생성한 테스트 인증서를 사용한다. 개인 인증파일이나 환경변수에서 키를 탐색하지 않는다.

```sh
npm ci --prefix packages/fabric --ignore-scripts
npm run start:fabric
```

기본 주소는 `http://127.0.0.1:4318`, 데이터 디렉터리는 `.data/fabric-web`이다.
다른 포트·데이터 경로를 사용하려면 다음처럼 실행한다. 한 데이터 디렉터리는
한 서버 프로세스만 사용한다.

```sh
npm run start:fabric -- --port 4320 --data .data/fabric-web-other
```

예제 `npm run demo:web`는 로컬 SQLite 시뮬레이션을 실행한다. Fabric 모드로 앱을
시작할 때 Init, fixture 게시, 사람의 승인을 자동 실행하지 않는다. 이미 커밋된
공개 genesis와 원장 상태를 읽는다.

## 저장과 재시작

`SqliteFabricProjection`은 원본 peer 블록, 거래별 이력, 최신 상태와 cursor를
하나의 SQLite 트랜잭션으로 저장한다. 새 블록 검증과 DB commit이 성공한 뒤에만
메모리의 상태를 교체한다. SQL 실패 시 원본·이력·상태·cursor 모두 이전 상태다.

앱 재시작 시 원본 블록을 genesis부터 다시 검증하고 파생 테이블을 재구축한다.
블록 전체 바이트의 별도 SHA-256도 검사해 header hash 밖에 있는 VALID 필터의
손상을 검출한다. 실행 중에는 최신·과거 파생 상태와 cursor를 검증된 메모리 상태와
대조한다. 로컬 DB 관리자가 모든 원본과 해시를 함께 바꾸는 공격에 대한 별도 서명
증명은 제공하지 않는다. 블록의 출처 신뢰는 인증된 peer TLS 연결에 둔다.

읽기 요청은 peer의 최신 높이·해시를 확인한 뒤 필요한 전체 블록을 반영한다.
과거 시점 읽기는 정확한 `(block_number, transaction_index)`까지만 반영한다.
현재 동기화는 요청 및 시작 시에 수행하며 별도 상시 백그라운드 서비스는 없다.
큰 원장의 시작 시 재생 비용과 운영 성능 목표는 아직 측정하지 않았다.

서명 신원별 durable outbox와 actor별 비공개 command 기록은 HTTP 재시도에서도
처음 생성한 ID·timestamp·본문을 유지한다. 아직 확인되지 않은 명령은 HTTP 202
`pending`, peer나 projection을 확인할 수 없는 엄격 조회는 HTTP 503이다.
성공 receipt는 peer의 VALID 블록에 있는 원래 idempotency 거래를 가리킨다.

## fence와 제공 기준

manifest는 [기존 프로토콜](05-RAG.md)의 정확한 VALID fence 거래 위치를 가리킨다.
그 뒤의 거래를 과거 스냅샷에 섞지 않는다. 추가로 응답을 만들기 전에 이미 관측한
최신 `eligibility_epoch`가 fence 값과 다르면 `FENCE_SUPERSEDED`로 제공을 보류한다.
따라서 같은 블록에서 뒤따르는 철회도 보류 사유가 된다. 이 보수적인 추가 검사는
[구현 결정](10-IMPLEMENTATION-DECISIONS.md)에 기록했다.

프로세스가 바뀌면 이전 run manifest의 재사용은 `SESSION_RESTARTED_RESOLVE_AGAIN`으로
보류한다. 새 resolve가 새 fence를 얻어야 한다. 이미 외부로 전달한 문서나 이후
발생할 외부 부작용과 철회를 원자화한다는 보장은 아니다.

## 검증 명령

```sh
npm ci --ignore-scripts
npm ci --prefix packages/auth --ignore-scripts
npm run check:types
npm run check
npm run demo
npm run fabric:http-smoke
```

`fabric:http-smoke`는 기존 원장을 보존하면서 새 가상 영업 개정본을 생성한다.
비공개 초안·공개 확인·권한 거부·승인·채택을 검사하고, Fulfillment 테스트 peer를
잠시 정지해 503을 확인한 뒤 다시 기동한다. API 프로세스도 다시 시작해 원래
receipt·데이터 복원과 이전 manifest 거부를 검사한 후 해당 가상 합의를 철회한다.
근거는 `.data/fabric-http-smoke-*/http-evidence.json`에 저장한다.

소스 변경으로 테스트 chaincode package가 달라졌다면 `npm run fabric:upgrade`로
각 조직이 다음 lifecycle sequence를 승인·커밋한다. 고정된 genesis, 논리 버전
0.1.0, endorsement 정책과 기존 Init 상태는 유지한다. 일반 `fabric:deploy`는
다른 package를 자동으로 대체하지 않는다.

OIDC 클라이언트와 개발용 로그인 서버·서명 프로세스는 추가됐다. 실제 운영 제공자·KMS·Fabric CA enrollment 및 조직별 배포는 후속 단계다.
외부 모델/KB와 독립 호스트의 CFT/BFT·성능 검증도 별도 단계다.
