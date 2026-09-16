# 테스트 인증서 점검과 갱신

이 절차는 선택형 `order-workflow` 예제의 `.data/fabric-smoke` 전용이다.
Sales·Fulfillment·Settlement의 `User1` enrollment 인증서만 갱신한다.
제품 조직 구성을 제한하지 않으며, 운영 Fabric CA·KMS 연동을 구현하지 않는다.

## 보존하는 것

- 기존 사용자 개인키와 공개키, subject·issuer, `kcl.actor_id`·`kcl.actor_kind` 속성.
- 조직 CA와 CA 개인키, peer/orderer enrollment·TLS 인증서, MSP 설정, `channel.block`, 원장.
- 과거 VALID 거래의 원래 인증서와 receipt. 과거 블록을 다시 서명하거나 바꾸지 않는다.

신규 테스트 네트워크의 사용자 인증서도 기본 90일로 발급한다. CA와 TLS 갱신은 이 명령의 범위 밖이다.
기존 인증서가 이미 만료돼도 CA와 키가 유효하면 갱신할 수 있다. 실행 중인 signer는 각 요청 전과
서명 결과 반환 전에 유효기간을 검사하며, 만료 시각부터 서명을 거부한다.

## 명령

Node24와 OpenSSL을 사용한다. `check`는 공개 인증서만 읽으며 optional Fabric 패키지가 없어도 동작한다.
`prepare`와 `apply`는 기존 테스트 사용자·CA 개인키를 읽고, `packages/fabric`의 선택 의존성을 사용한다.
새 키를 생성하거나 외부 CA에 요청하지 않는다.

```sh
npm run fabric:certs:check
npm run fabric:certs:check -- --warn-days 14
npm run fabric:certs:prepare -- --days 90 --renew-before-days 14
```

`check` 종료 코드는 정상 `0`, 만료 임박/만료 `2`, 입력·파일 오류 `1`이다.
출력의 `expired`는 아직 유효하지 않은 인증서도 포함한다. 점검 대상은 crypto 트리의 공개 인증서이며
고정된 사용자 인증서 3개가 모두 존재해야 한다. 인증서 폐기 여부나 네트워크 접근 성공을 증명하지는 않는다.

`prepare`는 3개 중 하나라도 갱신 시점에 이르면 세 인증서를 같은 기간으로 준비한다.
기간은 최대 365일이며 경고 기간보다 길어야 한다. 새 인증서는 이전 만료일을 연장하고 CA보다 오래 유효할 수 없다.
아직 갱신할 필요가 없으면 `status: current`를 반환한다.

준비 결과의 `plan_path`는 `.data/fabric-smoke` 기준 상대 경로다. 해당 JSON에서 대상, 이전/신규 만료일,
공개 인증서 SHA-256을 검토할 수 있다. 준비 폴더에는 이전/신규 **공개 인증서**, CSR, plan만 저장한다.
개인키를 복사하지 않으며, 폴더 권한은 `0700`, 파일은 `0600`이다. 이 자료들은 Git에서 제외된다.

적용 순서:

1. 다른 갱신 작업이 없는지 확인한다. 유지보수 명령은 한 번에 하나만 실행한다.
2. 영향을 받는 앱과 별도 signer를 정상 종료한다. 기본 예제 구성에서는4318/4319/4321/4331/4341이다.
3. 준비된 경로로 적용한다.
4. 같은 데이터 경로와 인자로 앱·signer를 모두 다시 기동한다.
5. 공개 만료 점검, readiness, 조직별 인증 조회와 실제 VALID 거래를 확인한다.

```sh
npm run fabric:certs:apply -- --plan certificate-renewals/renewal-YYYYMMDDHHMMSS-ID/plan.json
npm run fabric:certs:check
```

CLI는 실제 프로세스의 인증서 재로딩을 알 수 없어, 이미 적용된 plan을 재실행해 `changed: 0`이어도
`restart_required: true`를 반환한다. signer와 Gateway 앱은 시작할 때 인증서 바이트를 고정하므로 둘 다 재시작해야 한다.
기본4317의 local 모드는 이 인증서를 사용하지 않는다. peer/orderer를 재시작하거나 `fabric:up`을 실행할 필요는 없다.

## 검증과 실패 복구

준비·적용 시 고정된 3개 profile의 subject, 공개키, CA 서명, CA 용도, leaf 용도, 정확한 actor 속성을 검증한다.
Fabric attribute OID `1.2.3.4.5.6.7.8.1`의 값은 Fabric shim이 읽는 raw UTF-8 JSON이다.
TLS 전용 EKU를 enrollment 인증서에 넣지 않는다.

발급 CA는 조직 `msp/cacerts` 및 저장된 channel genesis의 Application MSP root와 일치해야 한다.
plan에는 genesis 해시도 기록한다. 이는 이 테스트 네트워크의 고정된 신뢰 기준이며,
운영 중 변경된 channel 설정을 조회하거나 CA rotation을 수행하는 기능은 아니다.

적용은 **모든 대상 사전 검증 → 각 파일의 임시 쓰기/fsync/rename → 결과 검증** 순서다.
plan·후보·활성 인증서·CA·genesis가 달라지거나 경로가 이탈하면 교체 전 거부한다.
symlink와 hardlink, 중복 JSON 필드, 과도한 크기, 충분한 유효기간이 남지 않은 후보도 거부한다.

여러 파일 전체를 하나의 파일시스템 transaction으로 교체하지는 못한다. 일반 오류 시 이번 시도의 변경을 롤백하고
복구를 확인한다. 강제 종료로 일부만 바뀌었다면 앱을 멈춘 상태에서 **같은 plan**을 다시 적용한다.
각 대상이 plan의 이전/신규 인증서 중 하나여야 안전하게 재개된다. `ROLLBACK_FAILED`이면 앱을 시작하지 말고
plan의 공개 백업과 실제 파일을 확인한다. 키나 원장 재생성으로 문제를 우회하지 않는다.

이 절차는 인증서 폐기를 수행하지 않는다. 이전 인증서는 만료되기 전까지 동일 키로 유효하므로,
키 유출 대응이나 강제 폐기에는 별도 운영 절차가 필요하다.

## 실제 검증 — 2026-09-16

사용자 인증서 3개를 `2026-09-22T07:55:04Z`에서 **`2026-12-15T06:29:11Z`**까지 갱신했다.
81개 공개 인증서 중 정확히 3개만 바뀌었으며 공개키는 모두 유지했다. 대상 외130개 파일의 내용·inode·수정시각과
genesis가 유지됐고, 앱5개를 정상 재시작했다.

갱신 후 이전 인증서로 제출한 실제 대기 거래를 영속 outbox에 남기고 연결을 닫은 다음,
새 인증서로 같은 거래를 재제출 없이 복구했다(VALID247). 세 조직 각각 새 인증서·별도 signer로
peer 조회와 fence 쓰기를 실행해 전체 블록으로 VALID248/249/250을 확인했다.
이는 인증서 유효기간이 겹치는 동안의 복구 시험이며, 이미 만료된 이전 인증서의 실제 peer 복구 시험은 아니다.

같은 날 두 번째 갱신으로 세 인증서를 **`2027-01-14T14:41:57Z`**까지 연장했다. 이때 `apply`의
첫 rename 직후 실제 `SIGKILL`을 주입해 부분 적용 상태를 만들고, 같은 plan 재적용으로
나머지 대상을 재개·완료한 뒤 앱 재시작과 실제 게시까지 확인했다.

회귀 테스트는 합성 CA/키를 사용해 키·genesis 보존, raw actor 속성, 만료 후 갱신, 잘못된 키/CA/actor,
변조·symlink·stale plan, rename/fsync 실패 롤백, 일부 적용 후 재개, 재실행을 확인한다.
전체 실행 근거는 [검증 기록](VALIDATION.md)에 있다.

## 근거 문서

- [Hyperledger Fabric 인증서 관리](https://hyperledger-fabric.readthedocs.io/en/latest/certs_management.html): 인증서 역할, 갱신과 구성 반영.
- [OpenSSL x509](https://docs.openssl.org/3.6/man1/openssl-x509/): 기존 인증서/키에서 CSR 생성과 명시적 확장 발급.

이 예제에는 Fabric CA 서버가 없으므로 cryptogen의 테스트 CA와 OpenSSL을 사용한다.
