# 37. Confluence Cloud 비공개 수집

[선정 기록](35-PILOT-INTEGRATION-SELECTION.md)의 첫 KB adapter다. 명시한 사이트와
페이지만 읽고 기존 actor-private 초안을 만든다. 기본 실행에서 활성화하지 않으며 실제
OAuth 등록·최초 동의와 비밀 저장소는 배포자가 구성한다. 회전 토큰 갱신과 정기 수집은
아래 선택형 runtime으로 연결할 수 있다.
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

브라우저 source 목록은 본인 출처의 page ID/버전과 정기 수집 상태를 표시하고 초안을 연다.
최초 OAuth 동의 UI와 실제 tenant 등록은 배포 환경에서 준비한다.

## 회전 refresh token 갱신

[`createConfluenceOAuthProvider`](../packages/connectors/confluence-oauth.ts)는 고정
`https://auth.atlassian.com/oauth/token`을 사용한다. 최초 OAuth 동의에는 `offline_access`가
필요하다. Atlassian은 성공 시 새 refresh token을 주므로 이전 토큰을 계속 사용하면 안 된다.
[공식 갱신 계약](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/).

```ts
const oauth = createConfluenceOAuthProvider({
  grantId: deployment.grantId,
  clientId: deployment.clientId,
  store: secretGrantStore,
  getClientSecret: signal => credentials.confluenceClientSecret(signal),
  allows: request => oauthPolicy.allows(request),
});
```

`secretGrantStore`는 `ConfluenceGrantStore`의 `load`와 **영속·원자적인 compareAndSwap**을
구현해야 한다. 프로세스 사이에서도 같은 grant/version을 한 번만 교체하고 version을
재사용하지 않는다. 암호화·접근제어·KMS와 최초 grant 저장은 이 backend의 책임이다.
앱은 실제 토큰이나 client secret을 private DB·로그·브라우저에 저장하지 않는다.
초기 ready grant는 grant/client ID, version, access/refresh token, expires_at(ms),
`read:page:confluence`를 포함한 scope를 가진다. 이 값들을 채팅이나 Git에 넣지 않는다.

유효기간30초 전부터 갱신한다. 외부 요청 **전에** CAS로 `refreshing` 의도를 기록하고,
응답의 새 토큰 쌍을 CAS로 저장·재조회한 다음에만 access token을 반환한다. 동시 갱신,
다른 로그인으로 교체된 grant 덮어쓰기와 저장 전 토큰 반환을 막는다. 매 사용 시 backend를
조회하고 별도 정책의 true를 요구한다. 기본10초/최대30초, 응답32KiB와 취소를 적용한다.

응답 유실·invalid grant·저장 실패·프로세스 중단 뒤 `refreshing`이 남으면 이전 refresh
token을 자동 재사용하지 않는다(`OAUTH_REFRESH_UNCONFIRMED`). 최초 동의를 다시 수행해
새 ready grant를 더 높은 version으로 설치해야 한다. 공급자의 reuse leeway를 재시도
보장으로 가정하지 않는다. backend에 새 ready grant가 이미 저장됐지만 확인 응답만
유실된 경우 다음 호출은 저장된 새 토큰을 사용하며 또 갱신하지 않는다.

## 정기 수집

```ts
const app = await createConfiguredApp(config, {
  dataDir,
  confluenceSync: {
    pollMs: 1000,
    sources: [{
      owner: { org_id: deployment.orgId, actor_id: deployment.actorId },
      intervalMs: 900000,
      timeoutMs: 60000,
      source: { ...sourceOptions, getAccessToken: oauth.getAccessToken },
    }],
  },
});
```

`sourceOptions`는 앞 절의 source_id/cloud_id/pages/allows다. 최대16개 local human owner의
source를 명시하며 설정하지 않으면 자동 수집하지 않는다. `listen()` 뒤 기본1초마다 기한을
확인하고 source별 기본15분 간격으로 순차 수집한다. 처리 시간이 길면 다음 source가 지연될 수
있다. `pollMs: 0`은 자동 실행을 끄며 `app.service.confluenceSync.runOnce()`로 도래한
작업만 실행한다. 다운타임 동안 누락된 횟수를 몰아서 실행하지 않는다.

private DB의 actor별 source-schedule에 다음 실행 시각·원인 코드·개수·유한 lease를 저장한다.
두 DB 연결의 중복 claim을 막고 재시작/복원 후 간격을 유지한다. 실패도 같은 간격 뒤 재시도한다.
owner/workspace/site/page 매핑이 바뀌면 새 binding을 사용하며 source의 site 혼합 금지는
계속 적용된다. 토큰과 원문은 scheduler 상태에 저장하지 않는다.

각 provider 요청과 private 읽기/쓰기 직전에 현재 owner·계정·serving 상태와 lease를 검사한다.
비동기 refresh 중 종료/시간 초과 시 늦은 private 쓰기를 차단한다. 이미 완료된 페이지 import는
되돌리지 않으며 다음 실행에서 이어간다. `/source-automations`와 브라우저는 본인 상태만 보여준다.
`app.close()`는 scheduler를 취소·정리한다. 외부에서 소유한 oauth provider는 필요 시
`oauth.close()`로 별도 종료한다. 과거 snapshot 복원 시 grant store를 과거 refresh token으로
되돌리지 않는다. 토큰 backend와 앱 DB는 각각의 복구 경계를 가진다.
