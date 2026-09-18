# Knowledge client와 guarded generation

`packages/client/knowledge-client.ts`는 Knowledger resolver를 호출하는 Node.js 24 이상에서 사용하는 client다. client가 승인 판정을 계산하지 않는다. 서버가 반환한 fresh fence, exact revision, 사람 승인 목록, policy binding을 검증해 caller가 안전하게 사용할 수 있는 결과로 바꾼다.

## Client 만들기

현재 서버는 OIDC 세션 cookie·CSRF·Origin 계약을 사용한다. 아래 helper는 이 계약을 충족하는 인증된 호출 측 구현이다. 기본 동작을 바로 확인하려면 `npm run demo:kb`를 실행한다.

```ts
import { KnowledgerClient } from "./packages/client/knowledge-client.ts";

const client = new KnowledgerClient({
  baseUrl: "https://knowledger.example.test",
  workspaceId: "knowledge",
  // 인증을 완료한 호출 측이 현재 Knowledger session cookie·CSRF·Origin 헤더를 제공한다.
  headers: async () => getApprovedKnowledgerSessionHeaders(),
  timeoutMs: 10_000,
});
```

`baseUrl`은 origin만 받는다. client는 workspace ID를 경로에 안전하게 넣고, caller가 제공한 `fetch`와 headers provider를 사용한다. client가 토큰을 발급하거나 저장하지 않으며, 인증서·private key·cookie discovery도 하지 않는다. 모든 응답은 제한된 크기로 읽고 strict JSON으로 파싱한다. 기본 request timeout은 10초, 최대 60초다. context 조회·재검증은 추가로 30초의 응답 신선도 한도를 적용한다.

운영 OIDC transport는 caller가 로그인 세션과 headers를 소유한 상태에서 주입한다. 개발용 local client는 [development client handshake](../packages/connectors/development-client.ts)를 사용하지만 local-simulation과 loopback에 한정된다.

## Resolve 검증

```ts
const result = await client.resolve({
  document_ids: ["doc-shared-guideline"],
  context_id: "context-shared",
  scope_id: "scope-primary",
  usage_scope: "reference/v1",
});

if (result.status === "provided") {
  console.log({ status: result.status, document_count: result.documents.length });
}
```

`resolve`는 정확히 한 문서, 유효한 context/scope/usage scope를 요구한다. 서버가 `withheld`를 반환하면 client는 문서를 빈 배열로 만들고 안전한 reason을 유지한다. `provided`인 경우에는 다음을 확인한다.

- 응답의 revision digest와 `GET /revisions/{digest}`의 full immutable payload가 일치
- 선택한 document/context/scope/usage scope와 revision slot이 일치
- manifest가 정확한 normative revision, policy, membership epoch와 사람 승인 decision을 가리킴
- `private_sources`가 비어 있고, strict checkpoint가 resolver 응답과 일치
- caller가 development mode를 명시하지 않았다면 Fabric mode만 허용

ACK, chaincode event, HTTP 200만으로 제공 상태를 만들지 않는다. 실제 Fabric 경로에서는 검증된 peer block과 projection이 필요하다. local-simulation은 명시적으로 `allowDevelopment: true`를 준 예제와 테스트에서만 사용한다.

`revalidate(runId)`는 서버에 현재 상태를 요청하고 반환된 strict manifest 구조를 확인한다. `guardedGeneration`은 `validateRefreshedManifest`로 이전 manifest와 비교한다. 새 run ID와 checkpoint는 허용되지만 policy, revision digest, agreement, approval decisions, membership·egress binding은 바뀌면 실패한다. 결과가 `withheld`이면 caller는 기존 output을 계속 사용해서는 안 된다.

`resolve`와 `revalidate`는 `modelAdapterId` 옵션으로 모델 어댑터 식별자를 서버에 전달할 수 있다. 서버는 `createApp`/`KnowledgerService`의 `modelEgress` 옵션에 설정된 정책으로 현재 전송 권한을 확인한다 — `policy_version`은 manifest의 `model_egress_policy_version`에 실리고, `allows` 콜백이 `false`나 예외를 반환하면 `EGRESS_POLICY_DENIED`로 withheld한다. `guardedGeneration`은 `adapterId`를 두 호출에 자동으로 실어 generation·release 직전에 서버 측 egress 정책도 재확인한다. 검색 권한이 외부 모델 전송 권한을 함축하지 않는다.

## Guarded generation

`packages/client/guarded-generation.ts`는 승인된 지식을 외부 또는 로컬 생성 callback에 전달하는 경계다.

```ts
import { guardedGeneration } from "./packages/client/guarded-generation.ts";

const outcome = await guardedGeneration({
  client,
  selection,
  adapterId: "example-generator",
  authorize: async ({ phase, manifest }) => {
    // caller-owned authorization service
    return await checkCurrentEgressPermission(phase, manifest);
  },
  generate: async ({ documents, manifest, signal }) =>
    draftFromApprovedKnowledge(documents, manifest, signal),
});
```

실행 순서는 다음과 같다.

1. resolver로 지식을 조회한다.
2. `generate` authorization callback을 통과한다.
3. 같은 실행을 revalidate해 generation 직전 knowledge binding을 확인한다.
4. caller가 제공한 `generate` callback을 실행한다.
5. `release` authorization callback을 통과한다.
6. 다시 revalidate해 release 직전 상태를 확인한 뒤에만 output을 반환한다.

callback은 결과를 미리 스트리밍하거나 외부 부작용을 실행하지 않고 초안을 Promise로 반환해야 한다. 라이브러리는 자동 publish, approval, external tool 호출을 제공하지 않는다. AI actor는 사람 승인을 발행할 수 없다. `authorize`는 두 phase 모두 필요하고, `adapterId`는 제한된 식별자여야 한다. 기본 generation timeout은 120초, 최대 600초이며 AbortSignal 취소도 지원한다. timeout·취소·freshness 실패·authorization 거부는 output 대신 `withheld` 결과가 된다.

`generate` callback으로 이미 외부 시스템에 전달된 원문을 나중에 회수할 수 있다는 뜻은 아니다. egress 전에 generation authorization과 fresh revalidation을 완료하고, callback이 원문을 보존하거나 재전송하지 않도록 caller가 책임져야 한다.

## 모델과 운영 경계

Knowledge client는 모델 provider, vector database, SSO, HSM/KMS를 선택하지 않는다. 실제 모델 호출은 caller가 `generate` callback 안에서 명시적으로 연결한다. 기본 production client는 Fabric과 strict checkpoint를 기대하며, 개발 local-simulation은 `allowDevelopment`를 명시한 테스트·예제에서만 허용한다.

client는 신뢰하는 인증된 Knowledger 응답의 구조·digest·scope·manifest binding을 검사한다. Fabric quorum proof를 독립 검증하는 클라이언트는 아니며, 실제 승인·dependency·VALID 판정은 서버의 검증된 projection에 의존한다. 원장 consensus가 문서 의미의 진실성이나 모델 출력의 정확성을 보증하지 않는다. 운영 배포에서는 HTTPS, 인증 transport, private source 보관, 모델 egress 정책, callback timeout과 audit 경계를 별도로 구성해야 한다.

관련 구현은 [KnowledgerClient](../packages/client/knowledge-client.ts), [guarded generation](../packages/client/guarded-generation.ts), [resolver API](06-API.md), [RAG 경계](05-RAG.md)를 참조한다.
