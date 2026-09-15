# 조직별 개발 앱 실행

각 가상 조직의 API·개발 로그인·서명 서비스를 별도로 실행하고 private 데이터 폴더를 분리한다.
공유 문서는 기존 Fabric channel에 남는다. 각 앱은 자기 조직의 subject·서명 키·outbox만 사용한다.
조직마다 API와 개발 IdP는 같은 프로세스에서 실행하고, Fabric signer는 별도 자식 프로세스로 실행한다.

## 실행

Node24 이상과 실행 중인 [Fabric 테스트 네트워크](../infra/fabric/README.md),
[개발 로그인 의존성](13-DEVELOPMENT-LOGIN.md)이 필요하다. 별도 터미널에서 실행한다.

```sh
npm run start:login -- --organization SalesMSP
npm run start:login -- --organization FulfillmentMSP
npm run start:login -- --organization SettlementMSP
```

| 조직 | 앱 | 개발 IdP | 기본 데이터 폴더 |
| --- | --- | --- | --- |
| SalesMSP | `http://127.0.0.1:4321` |4322| `.data/fabric-sales` |
| FulfillmentMSP | `http://127.0.0.1:4331` |4332| `.data/fabric-fulfillment` |
| SettlementMSP | `http://127.0.0.1:4341` |4342| `.data/fabric-settlement` |

해당 조직의 개발 계정 하나만 로그인 화면에 표시한다. 다른 조직의 subject는 인가되지 않는다.
브라우저의 역할 전환 API도 거부한다. 앱과 IdP의 쿠키 이름은 각각 origin에 결속하여
같은 loopback 호스트의 다른 포트에서 로그인·로그아웃이 서로 덮어쓰지 않게 한다.

```sh
npm run start:login -- --organization SalesMSP --port 4361 --issuer-port 4362 --data .data/sales-other
```

기존 `npm run start:login`의3조직 테스트 프로필과 `.data/fabric-login`은 유지한다.
조직 옵션 없이 조직 전용 폴더를 열거나 로컬 가상 역할 모드로 내려가는 것은 거부한다.

## 저장소와 서명 경계

처음 실행할 때 비어 있는 새 데이터 폴더에 `runtime-scope.json`을0600으로 생성하고 폴더를0700으로
제한한다. 파일에는 version·ledger·channel·organization만 있다. 이후에는 같은 조직만 해당 폴더를
재사용한다. 기존 다중 조직 DB 폴더를 자동으로 채택하거나 덮어쓰지 않는다.

조직 전용 폴더의 runtime 파일은 projection·private store·해당 actor outbox다. 다른 조직의
outbox·알 수 없는 파일·symlink를 거부한다. 복원 이력을 담는 `manifest.json`은 허용한다.
기존 unscoped 폴더의 권한을 scope 검사만으로 바꾸지 않는다.

API는 자기 조직의 공개 인증서와 peer만 연다. 별도 signer는 `--key-id`로 지정한 User1 키만
읽으며 다른 키 ID 요청을 거부한다. signer allowlist는 비어 있거나 중복되거나 알려지지 않은 ID일 수 없다.
app/IdP/signer 설정이 불완전하면 시작 단계에서 실패한다.

이 구성은 같은 OS 사용자·loopback·로컬 Colima에 있는 **개발 프로필**이다. 프로세스·파일 선택을
분리하지만 독립 기관의 관리 권한, OS 계정, 도메인/TLS, HSM이나 운영 SSO를 제공한 것은 아니다.
특히 쿠키 이름 분리는 같은 호스트의 악의적인 다른 서비스에 대한 보안 경계가 아니다.

## 백업·복원

해당 앱을 정상 종료한 뒤 [백업 명령](16-RUNTIME-BACKUP.md)을 사용한다.

```sh
npm run data:backup -- --data .data/fabric-sales --out .data/sales-backup
npm run data:restore -- --snapshot .data/sales-backup --out .data/sales-restored
npm run start:login -- --organization SalesMSP --data .data/sales-restored
```

조직 백업은 manifest version2 / `fabric-scoped` 프로필이며 organization을 명시한다.
DB3개와 `runtime-scope.json`의 hash를 함께 보존한다. scope 파일과 manifest가 다르거나 다른 조직의
파일이 섞이면 거부한다. 복원 폴더를 다른 조직이나 unscoped 모드로 열 수 없다.
기존 local/3조직 Fabric의 version1 백업은 계속 읽는다. 인증서·키·로그인 세션은 백업에 넣지 않는다.

## 검증

```sh
npm run check
npm run check:types
npm run organization:smoke
```

`organization:smoke`는 실제 세 peer에 연결된 앱3개·IdP3개·단일 키 signer3개를 실행한다.
동일 브라우저의 독립 세션, 자기 조직 outbox·초안, 다른 subject/초안/승인 거부,
공유 게시본 열람, 지정 사람 승인·활성·철회와 조직 백업 복원을 확인한다.
새 테스트 게시본을 만들고 마지막에 합의를 철회한다. 근거는 `.data/organization-smoke-*/organization-evidence.json`이다.
