# 36. 임베딩 전송 정책과 OpenAI adapter

선택형 `embedding` 런타임 옵션은 질의/공유 개정의 외부 임베딩 전송을 별도로 검사한다.
기본 앱의 로컬 토큰 해시와 기존 `embedQuery`/`embedRevision` 쌍은 유지한다. 새 provider와
기존 함수를 동시에 설정하면 기동을 거절한다. 기존 함수는 배포자가 소유하는 확장 경로이며
새 전송 정책이 자동으로 그 함수 내부의 네트워크를 가로채지는 않는다.

## 구성

```ts
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { createOpenAIEmbeddingProvider } from '../packages/embeddings/openai.ts';

const provider = createOpenAIEmbeddingProvider({
  profileId: 'openai-small-1536-v1',
  model: 'text-embedding-3-small', dimensions: 1536,
  // 배포 코드가 제공하는 함수. 이 adapter는 env/파일/secret manager를 직접 읽지 않는다.
  getApiKey: loadEmbeddingKey,
  countTokens: countTokensForSelectedModel,
});
const app = await createConfiguredApp(configuration, {
  dataDir, port: 4317,
  embedding: { provider, allows: embeddingPolicy, policyVersion: 1 },
});
```

`getApiKey(signal)`은 배포 비밀 저장소에서 선택한 프로젝트 키를 반환한다. `countTokens(text)`는
선택한 모델과 맞는 tokenizer를 이용해 정확한 토큰 수를 반환해야 하며 **필수**다.
임의의 글자 수 추정을 운영 tokenizer로 사용하지 않는다. tokenizer/SDK 설치를 기본 runtime에
강제하지 않기 위해 함수로 주입한다. 실제 키 읽기·계정 호출·추가 package 설치는 이번 검증에 없다.

OpenAI adapter는 `text-embedding-3-small`/`text-embedding-3-large`를 지원하고 기본은
small/1536이다. 공식 `/v1/embeddings`에 단일 문자열, `dimensions`, `encoding_format: float`를
보낸다. 입력은8192토큰까지 받고 자동 절단·batch·자동 재시도는 하지 않는다. 모델별 차원 상한은
small1536, large3072로 검증한다. [공식 생성 API](https://developers.openai.com/api/reference/resources/embeddings/methods/create),
[임베딩 가이드](https://developers.openai.com/api/docs/guides/embeddings)

endpoint는 `https://api.openai.com/v1/embeddings`로 고정하고 redirect를 따르지 않는다.
별도 호환 API나 지역 endpoint 지원을 암묵적으로 주장하지 않는다. 개인 식별 `user` 필드는
공급자 요청에 자동 첨부하지 않는다. 응답의 model, 단일 item/index, 차원, 유한/nonzero vector,
usage와256KiB 크기를 확인하며 원격 오류 본문/키/입력 원문은 오류에 넣지 않는다.

## 정책과 현재 인가

`allows(request)`가 없거나 엄격한 true를 반환하지 않으면 임베딩 호출/캐시 재사용을 거절한다.
`modelEgress`의 생성용 허용이 이 정책을 대신하지 않는다. 정책 입력은 다음 metadata다.

- actor, 고정 provider/model/차원/endpoint/전처리 profile과 digest, policy version
- `kind: query | revision`, 입력 byte 수, 요청 checkpoint
- query의 명시된 context/scope/usage 또는 null; revision은 canonical digest와 전체 slot
- `phase: before-provider | before-send | after-result | cache`, AbortSignal

질의/문서 원문은 정책 훅에 자동 제공하지 않는다. 훅 전후 현재 원장 serving/membership과
배포의 현재 계정 인가를 재확인한다. credential 조회 후 실제 HTTP 요청 직전에도 검사해
늦게 끝난 키 조회가 오래된 허용으로 전송하지 못하게 한다. 공급자 응답 뒤 정책/인가가
거절되면 결과를 반환하거나 캐시에 넣지 않는다. 이미 허용돼 전송한 데이터는 이후 권한
회수로 되돌릴 수 없으므로 전송 가능한 데이터 범위부터 배포에서 결정해야 한다.

새 provider 경로의 캐시는 profile digest와 개정 digest로 구분하고 최대1000개다. cache hit도
현재 actor의 정책을 확인한다. 전처리는 질의 원문 그대로, 개정은 `title + newline + body`다.
변경할 때 profile ID/전처리 계약·색인 version을 함께 관리한다. provider의 같은 model ID가
가중치의 영구 불변성을 증명하지는 않으므로 품질 변화는 별도 평가한다.

검색 응답은 model/차원 등 안전한 profile 정보와 digest를 추가하며 endpoint/키를 노출하지 않는다.
후보와 eligibility는 기존의 검증된 원장 checkpoint에서 확인한다. 검색 결과나 임베딩 정책이
실제 사용 권한을 주지는 않으며 resolve/revalidate는 그대로 필요하다.

## 예산·취소·재구축

| 옵션 | 기본과 범위 |
| --- | --- |
| `embedding.timeoutMs` | 검색/재구축 operation 합산30초; 10ms~120초 |
| `embedding.maxCalls` | operation당 provider 호출 시도128회; 1~10,000 |
| `embedding.maxConcurrent` | 동시에4개 operation; 1~32 |
| provider `timeoutMs` | tokenizer/키/검사/HTTP10초; 10ms~60초 |
| provider `maxInputBytes` | 512KiB; 1~512KiB, 토큰 제한도 별도 검사 |

HTTP 연결 중단·앱 종료·마감은 해당 operation을 취소한다. 늦은 정책/credential callback은
새 요청을 시작하지 않고 늦은 결과도 캐시에 넣지 않는다. 응답 stream도 중단한다.
사용자 정의 provider는 `beforeSend()`와 signal 계약을 따라야 한다. 런타임은 신뢰된
callback이 임의로 수행하는 네트워크나 동기 CPU 작업을 강제로 통제하지 않는다.

외부 색인 없는 전수 검색은 공유 개정을 임베딩하므로 큰 corpus에서는 호출 예산에 걸릴 수 있다.
한도를 넘으면 일부 검색을 완전한 결과로 반환하지 않고 `EMBEDDING_BUDGET_EXCEEDED`로 실패한다.
큰 corpus는 같은 profile의 별도 벡터 색인과 배치 재구축 설계가 필요하다. 외부 DB가 실제로
그 profile/차원의 벡터를 보유하는지는 배포자가 보장해야 한다.

재구축은 bootstrap actor만 실행한다. 입력별 검사 후 교체 직전에 전체 metadata의 정책을
다시 확인한다. 거절/마감이 원자적 `replaceAll` 호출 전에 발생하면 기존 색인을 유지한다.
이미 시작된 외부 DB의 교체를 취소로 되돌린다고 약속하지 않는다. 동시 재구축 요청은 원래
하나의 작업에 합류하며 첫 요청의 취소가 공유 작업을 중단할 수 있다. 색인은 권한 근거가 아니다.

오류는 전송 거절, 현재 인가 거절, 정책 장애, timeout/abort, 입력 초과, 잘못된 응답,
공급자 거절/일시 장애/429, credential 부재, 예산/동시 처리 한도를 안전한 코드로 구분한다.
원문·키를 진단 원인으로 저장하지 않고 자동 HTTP 재시도로 비용을 늘리지 않는다.

## 검증 범위

가상 tokenizer·키·fetch 응답으로 전송 거절0회, cache/다른 actor의 거절, 키 조회 중 권한 회수,
late callback, 잘못된 model/차원/usage/큰 응답, 연결 중단·종료, 재구축의 기존 색인 보존을
검증한다. 가상 tokenizer/벡터는 실제 한국어 모델 성능 또는 실제 OpenAI 호출 성공의 근거가 아니다.
실사용에는 승인된 데이터 범위, 실제 tokenizer/프로젝트 키와 별도 품질 평가가 필요하다.
