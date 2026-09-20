# 37. Confluence Cloud 비공개 수집

[선정 기록](35-PILOT-INTEGRATION-SELECTION.md)의 첫 KB adapter다. 명시한 사이트와
페이지만 읽고 기존 actor-private 초안을 만든다. 기본 실행에서 활성화하지 않으며 실제
OAuth 등록·로그인·refresh token rotation은 배포자가 제공하는 token 함수의 책임이다.
실제 tenant 접속·키 조회는 하지 않았고, 검증에는 가상 fetch와 임시 로컬 앱을 사용했다.

## 호출과 보존 경계

[`syncConfluenceSource`](../packages/connectors/confluence.ts)에 인증된 `SyncClient`와 다음을 전달한다.

```ts
await syncConfluenceSource(client, {
  source_id: 'team-handbook',
  cloud_id: deployment.cloudId,
  pages: [{ page_id: '123', policy_id: 'policy-handbook', policy_version: 1 }],
  getAccessToken: signal => credentials.confluenceToken(signal),
  allows: request => accessPolicy.canReadPage(request),
  signal,
});
```

`client`, `deployment`, `credentials`, `accessPolicy`, `signal`은 호출자가 구성한다.
라이브러리는 환경파일·브라우저 인증·비밀 저장소를 직접 읽지 않는다. OAuth 3LO의 고정
`https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/pages/{id}`에
`body-format=atlas_doc_format`으로 GET한다. 최소 scope는 `read:page:confluence`이고 실제
페이지/space 읽기 권한도 필요하다. [Atlassian 페이지 API](https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/),
[3LO 경로](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/).

page allowlist는 최대100개, 변환 결과는 페이지256KiB·전체16MiB, 각 upstream 응답은1MiB다.
수집 전체 기본30초(최대120초)이며 취소·리다이렉트 거절·오류 redaction을 적용한다.
`allows`의 엄격한 true를 토큰 조회 전후와 응답 뒤 확인한다. 토큰과 upstream 오류 본문은
출처나 오류 결과에 저장하지 않는다. 링크·첨부·검색 결과를 재귀 수집하지 않는다.

전체 페이지를 읽고 한 번 더 읽어 버전·제목·canonical ADF hash·변환 결과를 대조한 뒤
앱에 접근한다. 401/403/404는 접근 불가이며 삭제로 간주하지 않는다. 이 재확인은 각 페이지의
시점 검사이고 tenant 전체 원자 snapshot이나 나중의 권한 보존을 보증하지 않는다.

## 본문과 비공개 출처

지원 ADF는 문단, 제목1–6, 텍스트, strong/em/code/link, 줄바꿈, 코드 블록, 인용,
수평선, bullet/ordered list다. HTTP(S) 링크를 보존하되 가져오지 않는다. HTML은 escape한다.
표·매크로·미디어·멘션 등 지원하지 않는 구조는 전체 수집을 거절한다. 조용히 생략하지 않는다.
ADF depth32·node10000 제한도 적용한다. [ADF 구조](https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/).

경로는 `confluence/{page_id}.md`이며 private source entry와 draft source에만
`origin: { kind, cloud_id, page_id, page_version, adf_sha256 }`를 저장한다.
이는 호출자가 보고한 출처 정보이며 원본의 암호학적 증명이나 공유 문서 인가 근거가 아니다.
변환된 Markdown 본문·제목은 사용자가 게시를 확인하면 공유될 수 있으므로 먼저 검토한다.
cloud ID·page version·ADF hash는 공유 revision metadata에 자동 복사하지 않는다.

## 재실행과 실패

앱의 `/sources/:id/confluence`는 기존 session/CSRF·actor 소유권·정책·CAS를 적용하며
임의 URL이나 vendor token을 받지 않는다. 기존 Markdown endpoint는 origin 입력을 거절한다.
같은 source에서 공급자/site 혼합, upstream 버전 역행, 동일 버전의 다른 ADF hash는 거절한다.
새 페이지 버전은 내용이 같아도 새 비공개 초안을 만들고 이전 초안을 보존한다.

동일 입력과 응답 유실 재실행은 기존 초안/operation receipt를 재사용한다. 쓰기 자동 재시도는
하지 않는다. 여러 페이지 import는 페이지별 원자 작업이므로 중간 앱 오류 이전의 성공은
남는다. 다시 실행해 이어갈 수 있다. 시작된 앱 요청은 취소로 되돌리지 않는다.
allowlist에서 명시적으로 뺀 경로만 removed로 기록하며 게시된 개정·승인을 철회하지 않는다.
원본 삭제·접근 회수도 기존 공유 본문을 지우지 않는다.

브라우저 source 목록은 본인 출처의 page ID/버전을 표시하고 초안을 연다. OAuth 연결 UI나
정기 수집 scheduler는 포함하지 않는다. 이 adapter는 호출자가 실행하는 수집 경계다.
