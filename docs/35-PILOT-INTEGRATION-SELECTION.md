# 35. 첫 파일럿 연동 조합 선정

공식 문서 확인일: **2026-09-20**. 기준 구현: Knowledger v0.8.0 / `78d5049`.
사용자는 Atlassian·Microsoft·Slack·OpenAI·Ollama의 공개 공식 문서 조회를 승인했다.
기존 업무 도구·운영 계정은 미지정이다. 아래는 첫 **구현 대상에 대한 권고 결정**이며
가입·구매·모델 다운로드·키 조회·실제 조직 연결·실데이터 전송은 실행하지 않았다.

## 주 조합

**Confluence Cloud + Slack Bot의 개인 DM + OpenAI `text-embedding-3-small`**을
첫 외부 연동 구현 대상으로 선정한다. 기존 Git/Markdown·앱 내부 알림은 회귀 기준으로 유지한다.

| 영역 | 선택 | 공식 확인 사실과 선택 이유 |
| --- | --- | --- |
| KB | Confluence Cloud REST v2 | page ID·버전·본문 조회와 페이지/space 읽기 권한이 명시돼 있다. 현재 private source → immutable revision 흐름에 대응시키기 좋다는 구현 판단이다. [페이지 API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/) |
| 알림 | Slack Bot → 지정 사용자 DM | `chat.postMessage`의 bot `chat:write`, DM을 여는 `conversations.open`의 권한이 문서화돼 있다. 현재 수신자별 알림 경계를 유지하도록 개인 DM을 우선한다. [전송](https://docs.slack.dev/reference/methods/chat.postMessage/), [DM](https://docs.slack.dev/reference/methods/conversations.open/) |
| 임베딩 | `text-embedding-3-small`, 1536차원 | 공식 기본 차원1536, 최대 입력8192토큰. 모델 페이지 표시 가격은 입력100만 토큰당$0.02다. 먼저 비용·저장 크기가 작은 기준 모델로 측정한다. 한국어 품질 우위는 아직 주장하지 않는다. [벡터 가이드](https://developers.openai.com/api/docs/guides/embeddings), [모델](https://developers.openai.com/api/docs/models/text-embedding-3-small) |

이 선택은 API 형태와 현재 저장소의 연결 지점을 비교한 엔지니어링 판단이다.
세 제품의 운영비·한국어 정확도·개발 시간 비교를 실측한 결과는 아니다. 가격은 조회일의
공식 모델 페이지 기준이며 KB/알림 구독료, 실제 계정 한도와 조직 계약은 확인하지 않았다.

## 범위를 작게 고정하는 방법

### Confluence: 지정한 페이지를 비공개 초안으로

초기에는 한 사이트의 명시적 page ID 목록만 수집한다. `GET /wiki/api/v2/pages/{id}`의
`body-format`과 version을 사용하고, 최소 읽기 scope `read:page:confluence` 및 실제
페이지/space 읽기 권한을 확인한다. 임의 링크·첨부 전체 수집은 첫 단계에서 제외한다.
저장 형식 변환은 지원되는 제목/본문 요소에 한정하고 지원하지 않는 구조는 명시적으로 보고한다.
[페이지 계약](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/)

인증은 사용자 권한으로 동작하는 OAuth 2.0 3LO를 우선한다. 백그라운드 수집에 refresh token이
필요하면 `offline_access`와 rotation을 구현한다. 토큰은 공급자의 권한 범위 안에서만 동작하며
실제 권한 회수 시험이 필요하다. [3LO](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)

우리 쪽 구현에서는 사이트/page ID/버전/본문 digest를 private source 기록에 결속하고,
수집은 private draft까지만 진행한다. 원본403/404를 성공 또는 빈 본문으로 바꾸지 않는다.
원본 삭제·권한 회수가 이미 공유한 원장 본문을 회수하지 않으며, 자동 게시/승인은 하지 않는다.
현재 source의100개 파일·파일256KiB·전체16MiB 제한도 유지한다.

### Slack: 본문 대신 확인할 알림과 앱 링크

초기 권한은 `chat:write`, DM 생성에 필요한 `im:write`로 제한하고, 앱 actor와 Slack의
workspace/user/DM ID를 명시적으로 매핑한다. 조직 디렉터리·대화 이력 전체를 읽는 기능은
추가하지 않는다. 기본 메시지는 알림 종류와 로그인 후 확인할 앱 링크만 포함하도록 설계한다.
원문·댓글·문서 제목을 자동 첨부하거나 링크 미리보기로 노출하지 않도록 처리한다.
[DM 열기](https://docs.slack.dev/reference/methods/conversations.open/),
[메시지 옵션과 scope](https://docs.slack.dev/reference/methods/chat.postMessage/)

Slack의 `ok`·`channel`·`ts`를 검증해 **공급자 접수** 상태로 기록한다. 이를 기존 앱 간
`ReviewReceipt`나 사람의 열람/승인으로 위장하지 않는다. 채널별 전송 제한과429에 맞춘
대기 처리가 필요하다. 수신 성공 후 응답 유실 때 자동 재시도가 중복 메시지를 만들 수 있으므로
초기 설계는 모호한 결과를 별도 상태로 두고 확인 전 재발송을 보류한다. Slack 자체의
exactly-once 보장을 가정하지 않는다. [전송 응답·오류·제한](https://docs.slack.dev/reference/methods/chat.postMessage/)

### 임베딩: 질의와 문서의 전송 정책부터

두 임베딩 함수에 같은 모델/차원/전처리 프로필을 사용하고, 원문 입력 한도를 초과하면
거절하거나 검증된 분할 경로로 보낸다. 조용히 잘라낸 입력을 전체 개정의 임베딩으로 표시하지 않는다.
첫 파일럿은 한도 내의 짧은 문서로 시작한다. 모델/차원 변경은 별도 index version과
재구축/평가를 요구한다. 내부 최대4096차원 검사가 실제 벡터 DB 인덱스 지원의 증명은 아니다.

현재 `vectorSearch`의 `embedQuery`와 재구축의 `embedRevisionCached` 호출은 생성용
`checkEgress`를 거치지 않는다. 따라서 원격 provider 호출 전에 별도 임베딩 전송 정책,
현재 actor/범위, 허용된 모델·endpoint, timeout/취소·응답 크기/차원 검사를 구현해야 한다.
기존 `modelEgress` 설정만으로 질의·문서 임베딩까지 보호된다고 설명하지 않는다.
[현재 service](../apps/api/service.ts), [설정형 주입](../apps/api/configured-runtime.ts)

OpenAI 문서는 API 데이터가 기본적으로 학습에 쓰이지 않는다고 설명하지만, abuse monitoring
보관은 별개다. `/v1/embeddings` 표에는 기본30일 로그 보관·application state 없음이 기재돼 있다.
ZDR은 자동 기본값으로 가정하지 않는다. 실제 문서/질의의 전송 허용과 계정 설정을 확인한 뒤
호출한다. [데이터 처리](https://developers.openai.com/api/docs/guides/your-data)

## 대안과 전환 조건

| 조건 | 대안 | 확인할 차이 |
| --- | --- | --- |
| 기존 M365 환경 사용 | SharePoint + Teams, 임베딩은 허용된 공급자 | Graph의 sitePage 본문은 `canvasLayout` 확장 경로를 사용한다. Teams proactive 메시지는 앱 설치와 conversation/tenant 식별자가 필요하다. 기존 환경이면 별도 KB/메신저 전환을 우선하지 않는다. [sitePage](https://learn.microsoft.com/en-us/graph/api/sitepage-get?view=graph-rest-1.0), [Teams](https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages) |
| 문서·질의의 원격 임베딩 전송 불가 | 기존 Git/Markdown·내부 알림 + Ollama `embeddinggemma:300m` | 공식 tag는 약622MB, 2K context와 최소 Ollama v0.11.10을 안내한다. 짧은 문서 평가용 대안이며 실제 장비 성능·한국어 품질은 미측정이다. [모델](https://ollama.com/library/embeddinggemma:300m) |
| small의 검색 품질이 목표에 못 미침 | `text-embedding-3-large` 비교 평가 | 공식 기본3072차원, 표시 가격은 입력100만 토큰당$0.13. 우리 자료에서의 개선 폭을 측정한 뒤 바꾼다. 자동 승격하지 않는다. [모델](https://developers.openai.com/api/docs/models/text-embedding-3-large), [차원](https://developers.openai.com/api/docs/guides/embeddings) |

M365에서는 Selected 권한이 동의만으로 접근을 주지 않고 대상 리소스 할당·유효 토큰까지
요구한다. 한편 sitePage GET의 권한 표는 `Sites.Read.All`을 제시한다. 따라서 필요한 endpoint가
선택한 리소스 권한으로 동작하는지는 tenant에서 별도 검증하고, 전역 읽기 권한을 묵시적으로
기본 승인하지 않는다. Teams Workflows는 소유자/공동 소유자 운영 의존도도 검토한다.
[Selected 권한](https://learn.microsoft.com/en-us/graph/permissions-selected-overview),
[sitePage 권한](https://learn.microsoft.com/en-us/graph/api/sitepage-get?view=graph-rest-1.0),
[Workflows 소유권](https://learn.microsoft.com/en-us/microsoftteams/platform/webhooks-and-connectors/how-to/connectors-using)

Ollama 대안은 로컬 전용 모드와 loopback binding을 고정한다. 공식 API의 `truncate` 기본값이
true이므로 adapter에서는 false로 지정해 입력 손실을 감추지 않는다. `/api/embed`의 출력
정규화·차원을 실제 반환값에서 검증하고, 배포 시 모델 digest/전처리 프로필도 기록한다.
현재 모델 다운로드·서버 호출·로컬 설정 수정은 수행하지 않았다.
[Ollama FAQ](https://docs.ollama.com/faq), [embed API](https://docs.ollama.com/api/embed),
[임베딩 사용법](https://docs.ollama.com/capabilities/embeddings)

## 구현 순서와 완료 기준

1. **임베딩 전송 경계와 provider adapter**: small/1536을 기본 평가 프로필로 준비한다.
   허용 안 된 입력의 외부 호출0회, timeout/취소, 잘못된 차원/모델·큰 응답 거절을 검증한다.
   로컬 토큰 해시와 무설치 경로는 유지한다.
   후속 [구현 안내](36-EMBEDDING-EGRESS.md)에 새 guarded provider와 OpenAI adapter를 기록했다.
   실제 tokenizer/키 연결 및 한국어 실측은 별도다.
2. **Confluence source adapter**: 페이지 allowlist·고정 버전·보수적인 본문 변환,
   private import/CAS/재시도, 원본 권한 회수·삭제·버전 경합을 시험한다.
   후속 [구현 안내](37-CONFLUENCE-SOURCE.md)에 수집 API와 지원 본문/인증 경계를 기록했다.
3. **Slack 알림 adapter**: 명시적 actor/DM 매핑, 최소 메시지, 실제 전송 전 현재 인가,
   공급자 접수와 모호한 결과·재시도 상태를 구현한다. 기존 peer 영수증 계약은 유지한다.
4. **실제 소규모 파일럿**: 제안 범위는 대표 문서10~20개·한국어 질의30~50개다. 참여자가
   자료·정답 개정·반출 범위를 확정한 뒤 recall/MRR와 잘못된 제공/보류를 측정한다.
   목표 점수는 시작 전에 고정하고, 미측정을0건 성과나 공급자 간 품질 우위로 기록하지 않는다.

선정 완료는 adapter 구현·실계정 연동·한국어 품질 검증 완료가 아니다. 후속 연결에는
Confluence 사이트/page ID·OAuth 등록, Slack workspace/user/DM 매핑·앱 설치,
임베딩 프로젝트/모델·허용 데이터 범위와 secret 저장 방식이 필요하다. 비밀값을 공개 문서나
채팅에 요구하지 않고 배포 환경의 참조로 연결한다.
