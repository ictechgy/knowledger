# 프로젝트 설정과 범용 실행

KCL은 특정 산업, 부서, 업무 상태를 필수로 요구하지 않는다. 프로젝트 설정이 workspace, 조직, 업무 맥락, usage scope, 승인 역할과 연결 방식을 정한다. `examples/order-workflow`는 배송·주문 같은 업무 흐름을 보여 주는 선택형 예제다.

## 시작하기

Node.js 24 이상에서 새 설정을 만든다.

```sh
npm run config:init
npm start -- --config kcl.config.json
```

`config:init`의 기본 결과는 `kcl.config.json`에 두 개의 예시 조직과 초기 문서 본문이 없는 범용 workspace를 만든다. 조직과 workspace는 반복·선택 옵션으로 정한다.

```sh
npm run config:init -- \
  --organization ExampleOneMSP \
  --organization ExampleTwoMSP \
  --workspace knowledge \
  --output kcl.config.json
npm start -- --config kcl.config.json --data .data/knowledge --port 4317
```

`--output` 파일은 이미 있으면 덮어쓰지 않는다. 생성된 조직 라벨, identity, genesis policy와 연결 참조를 검토한 뒤 실행한다. 기존 데이터 폴더의 authority와 다른 설정을 자동으로 채택하거나 덮어쓰지 않는다.

선택형 order-workflow 데모는 설정을 만들지 않고 실행한다.

```sh
npm run demo:web
npm run demo
npm run demo:fabric
npm run demo:login
```

기존 `npm run start:fabric`은 `demo:fabric`의 별칭이고, `npm run start:login`은 `demo:login`의 별칭이다. 이 별칭은 고정된 예제 프로필이며 범용 프로젝트 설정을 대신하지 않는다.

## 실행 옵션

```text
npm start -- --config FILE [--data DIRECTORY] [--port 4317] [--organization ORG_ID]
```

local-simulation은 선택한 설정의 단일 개발 프로세스로 실행하며 `--organization`을 받지 않는다. Fabric은 `--organization`이 필수다. 선택한 조직에 대해서만 다음을 연다.

- OIDC subject binding
- Fabric 인증서·peer·signer socket 참조
- private store, projection, actor outbox가 있는 data directory

조직을 생략하거나 설정에 없는 조직을 고르면 시작 전에 실패한다. 앱은 loopback listener로 열 수 있고, 외부 HTTPS reverse proxy를 사용할 때는 사용자가 브라우저에서 접근할 고정 origin을 `server.public_origin`에 기록한다. OIDC callback은 이 origin을 사용한다.

## 설정 필드

| 필드 | 역할 | authority에 포함되는가 |
| --- | --- | --- |
| `version` | 프로젝트 설정 형식 버전. 현재 `1` | 형식 검사 |
| `workspace` | `id`, 표시 `label`, `contexts`, `usage_scopes`, `roles` | workspace ID와 genesis 참조가 중요 |
| `organizations` | 조직 ID와 표시 라벨 | 조직 registry는 genesis와 일치해야 함 |
| `identities` | actor의 표시 라벨과 kind | actor registry는 genesis와 일치해야 함 |
| `genesis` | 초기 identity, policy, membership epoch, role binding | 예. authority digest에 포함 |
| `bootstrap_actor` | 초기 genesis를 기록할 사람 actor | 포함 |
| `ledger` | `local-simulation` 또는 `fabric`, channel ID | 포함 |
| `authentication` | local 개발 로그인 또는 OIDC issuer/client/subject binding | OIDC binding 포함 |
| `server` | 고정 `public_origin` | 연결/배포 설정 |
| `fabric` | chaincode와 인증서·TLS·peer·signer 참조 | 연결 설정 |

`workspace`의 표시 라벨, 조직 라벨, identity 라벨은 운영 문구를 고치는 용도로 바꿀 수 있다. genesis identity·policy·bootstrap actor·channel·OIDC subject binding처럼 권한과 초기 상태를 바꾸는 설정은 기존 runtime 폴더의 authority digest와 달라진다. 그런 변경은 기존 폴더를 재사용하지 말고 새 genesis와 새 data directory에서 검토한다. peer endpoint, certificate path, TLS CA path, signer socket path 같은 연결 참조는 authority와 별도로 교체할 수 있지만, 새 경로의 파일 권한·인증서 일치·peer 상태를 다시 확인해야 한다.

설정 JSON은 [2조직 예시](../examples/config/two-organizations.json)와 [4조직 예시](../examples/config/four-organizations.json)를 참조한다. 예시는 범용 조직 ID를 사용하며, 실제 인증서·개인키·쿠키·토큰을 포함하지 않는다.

## 인증과 서명 경계

### OIDC

`authentication.mode`를 `oidc`로 설정하면 서버는 public client의 Authorization Code + PKCE 흐름을 사용한다. actor는 ID token의 임의 role claim이 아니라 설정의 `(issuer, subject) -> organization, actor` registry에서만 결정한다. Fabric 실행에서는 선택한 조직에 매핑된 binding만 사용한다.

운영형 OIDC에서는 issuer와 고정 `server.public_origin`에 HTTPS를 사용한다. 앱 listener가 loopback이어도 reverse proxy가 외부 HTTPS origin을 제공할 수 있다. `allow_insecure_loopback: true`는 loopback issuer와 loopback public origin을 사용하는 개발 fixture에서만 허용되며, 회사 SSO 설정의 우회 수단이 아니다.

### Fabric signer

앱 설정에는 개인키를 넣지 않는다. Fabric identity에는 `key_id`와 외부 signer socket path만 넣고, 개인키 참조는 signer 프로세스 설정 파일에 둔다.

```json
[
  {
    "key_id": "example-owner",
    "certificate_path": "/secure/msp/signcerts/owner.pem",
    "private_key_path": "/secure/msp/keystore/owner.key"
  }
]
```

개발·검증 signer는 별도 프로세스로 실행한다.

```sh
node infra/fabric/signing-service.ts \
  --config /secure/config/signing-keys.json \
  --socket /run/kcl/example-owner.sock
```

signer 설정은 앱 프로젝트 JSON에 inline private key를 넣지 않는다. Unix socket은 절대 경로와 제한된 파일 권한을 사용한다. 이 개발 프로세스 분리는 HSM, cloud KMS, 독립 OS 계정 또는 조직 간 운영 격리를 제공하지 않는다.

## Chaincode package

범용 설정에서 genesis와 bootstrap identity를 읽어 chaincode package를 만들 수 있다.

```sh
node infra/fabric/build.mjs \
  --config kcl.config.json \
  --output .artifacts/chaincode
```

고정된 order-workflow fixture를 명시적으로 패키징하려면 다음을 사용한다.

```sh
node infra/fabric/build.mjs --demo --output .artifacts/order-workflow-chaincode
```

package builder는 설정의 channel, 등록된 bootstrap actor, genesis policy를 검사한다. 패키지 생성은 실제 Fabric channel에 배포하거나 두 조직·네 조직 네트워크의 endorsement를 검증했다는 뜻이 아니다.

## 백업과 호환성

현재 runtime snapshot CLI는 새 configured profile을 version 3으로 저장하고, 기존 version 1·2 snapshot도 호환 경로에서 읽는다.

```sh
node tools/runtime-snapshot.ts backup --data .data/knowledge --out .data/knowledge-backup
node tools/runtime-snapshot.ts restore --snapshot .data/knowledge-backup --out .data/knowledge-restored
```

복원 후에는 같은 authority와 선택 조직으로 앱을 다시 열고 peer의 최신 VALID 상태를 확인한다. snapshot에는 OIDC session, 개인키, 인증서가 자동으로 들어가지 않는다. runtime DB 복원은 Fabric peer/orderer, CA, signer 운영 복구를 대신하지 않는다.

## 검증 범위와 제약

`createProjectTemplate`과 `config:init`은 임의의 2개 또는 4개 조직을 대상으로 local API와 chaincode package 생성을 검증한다. 새 범용 2·4조직 설정으로 실제 physical Fabric network를 기동해 검증한 것은 아니다.

실제 실행 기록이 있는 네트워크는 기존 order-workflow의 3조직 개발 Fabric 프로필이다. `npm run configured:smoke`는 이 네트워크를 새 JSON 설정·OIDC·별도 signer로 연결해 VALID 게시/승인, 철회와 version3 복원까지 확인한다. 그 기록은 범용 프로젝트가 영업·이행·정산 조직을 요구한다는 증거가 아니며, 운영 SSO, HSM/KMS, 독립 호스트, BFT 네트워크, RTO/RPO와 대규모 성능을 입증하지 않는다.

```sh
npm run check
npm run check:types
npm run demo
```

자세한 API·Fabric·개발 로그인·백업 경계는 [실행 가이드](11-RUNTIME.md), [Fabric 웹 가이드](12-FABRIC-WEB.md), [개발 로그인](13-DEVELOPMENT-LOGIN.md), [백업 가이드](16-RUNTIME-BACKUP.md)를 참조한다.
