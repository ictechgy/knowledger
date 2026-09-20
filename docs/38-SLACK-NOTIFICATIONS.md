# 38. Slack 개인 DM 기한 알림

[선정 기록](35-PILOT-INTEGRATION-SELECTION.md)의 Slack adapter다. 명시적으로 구성한
사람에게 현재 미열람 기한 알림의 종류와 로그인 후 확인할 앱 링크만 보낸다.
설정이 없으면 Slack 호출은0회다. 이번 검증은 전부 가상 fetch이며 실제 메시지는 보내지 않았다.

## 구성

`createApp` 또는 `createConfiguredApp`의 runtime option으로 지정한다. JSON 설정 파일이나
기존 peer `reviewDelivery` 설정에 토큰을 넣지 않는다. 다음 변수·함수는 배포자가 제공한다.

```ts
const app = await createConfiguredApp(config, {
  dataDir,
  slackNotifications: {
    targets: [{
      recipient: { org_id: deployment.orgId, actor_id: deployment.actorId },
      version: 1,
      address: { team_id: deployment.teamId, user_id: deployment.userId, dm_id: deployment.dmId },
      appUrl: deployment.authenticatedAppUrl,
      getBotToken: signal => credentials.slackBotToken(signal),
      allows: request => notificationPolicy.allows(request),
    }],
    worker: { pollMs: 60000, timeoutMs: 30000, batchSize: 10 },
  },
});
```

최대32개 local human recipient를 구성할 수 있다. 동일 actor 중복과 같은 workspace/DM의
두 actor 매핑은 거절한다. bot token은 호출자 함수로만 받으며 앱은 환경파일·인증파일을
읽지 않는다. `allows` 미지정·false·엄격한 true 이외 값은 모든 외부 호출을 차단한다.
정책 요청에는 recipient/address/알림 ID/개정 digest/phase/signal만 포함하며 원문은 없다.

Slack 앱 설치와 bot의 `chat:write`, `im:write` scope가 필요하다. 각 시도는 고정
`https://slack.com/api/`의 `auth.test`로 team/bot identity를 확인하고,
`conversations.open`에 사용자1명과 `return_im: true`를 보내 설정된 DM/user/is_im을 대조한다.
그 뒤 `chat.postMessage`를 호출한다. 임의 endpoint, 공개 채널, 다인 DM은 지원하지 않는다.
[인증 확인](https://docs.slack.dev/reference/methods/auth.test/),
[DM 열기](https://docs.slack.dev/reference/methods/conversations.open/),
[메시지 전송](https://docs.slack.dev/reference/methods/chat.postMessage/).

`appUrl`은 로그인 보호된 Knowledger 페이지의 HTTPS URL이어야 하며 사용자명·비밀번호·
query·fragment는 받지 않는다. 배포자가 이 URL의 앱/SSO 보호를 구성해야 한다.
메시지는 도래/초과 문구와 고정 앱 링크뿐이다. 제목·문서 본문·댓글·page ID·기한 날짜는
첨부하지 않는다. 링크/미디어/app unfurl을 모두 false로 보내고 자동 파싱을 끈다.
명시적 링크만 제한된 Slack 문법으로 만든다.
[링크 형식](https://docs.slack.dev/messaging/formatting-message-text/).

## 현재 인가와 처리 예산

현재 ledger serving·actor membership·구성된 계정 인가, 현재 일정/수신자/읽음 상태를
토큰 조회 전과 각 HTTP 요청 직전에 확인한다. 비동기 정책 조회 뒤에도 다시 확인한다.
완료·재할당·새 일정·읽음 처리된 알림은 보내지 않는다. 같은 일정에 초과 알림이 있으면
이전 도래 알림을 보내지 않는다. 검사 뒤 원격 요청이 이미 시작된 경우 메시지를 회수하지는 못한다.
알림은 검토 기한 안내이므로 개정이 사용 가능한 합의 상태임을 뜻하지 않는다.

`listen()` 뒤 worker가 실행된다. 한 번에 recipient1명을 순환하고 최대10개(상한20개)의
알림을 조회한다. recipient 수·페이지 수에 따라 알림 지연이 기본 poll 간격보다 길 수 있다.
`pollMs: 0`이면 자동 발송하지 않고 `app.service.slackNotifications.worker.runOnce()`로
명시 실행한다. 앱 내부 기한 알림 생성 worker는 독립적이다.

adapter 기본10초/최대30초는 token/policy/HTTP 전체를 포함한다. 응답64KiB·strict JSON,
redirect 거절·취소·안전한 오류 코드만 사용한다. 종료는 전송을 취소하고 불명 상태 저장을
마친 뒤 private DB를 닫는다. 응답을 무시하는 callback은 늦게 완료해도 추가 호출하지 않는다.

## 영속 상태와 재시도

별도 private SQLite `slack_notices`에 알림/recipient/target binding·시도 수·상태·접수 응답을
저장한다. binding은 Knowledger workspace, recipient, Slack team/user/DM, 앱 URL,
설정 version, 메시지 형식을 포함한다. 변경된 binding으로 이전 작업을 다시 보내지 않는다.
DB transaction과45초 lease로 중복 claim을 막고 동일 DM은 동시 전송하지 않는다.
시도 종료 후 같은 DM에 최소1초 간격을 둔다.

| 상태 | 의미와 후속 동작 |
| --- | --- |
| `pending` / `sending` | 아직 시도 전 / 현재 worker가 처리 중 |
| `provider_accepted` | Slack의 ok/channel/ts와 사전 team 검사를 통과해 저장. 사람의 열람이나 승인 증명이 아님 |
| `retry_wait` | post 이전의 일시 오류 또는 유효한429. 지정 시각 이후 최대 총3회까지 자동 시도 |
| `blocked` / `failed` | 정책·연결·주소 불일치·명확한 거절 / 허용된 시도 소진. 자동 재시도 없음 |
| `unknown` | post 이후 timeout/응답 유실/잘못된 응답/서버 오류 또는 만료된 sending lease. 자동 재발송 없음 |
| `skipped` | 읽거나 지난 알림이어서 발송 대상에서 제외 |

429의 `Retry-After`는1초~24시간 범위에서 그대로 기다리며 같은 workspace에도 대기 시간을
적용한다. 없거나 파싱 불가·범위 초과면 자동 재시도를 중지한다. HTTP200이어도 `ok`와
channel/ts를 검증한다. Slack은 internal/fatal 오류 시 일부 작업이 이미 성공했을 수 있다고
명시하므로 이런 응답은 unknown이다. [오류 계약](https://docs.slack.dev/reference/methods/chat.postMessage/).

기존 앱 간 `ReviewReceipt`를 생성하지 않고 원장·댓글 이벤트·승인·읽음 상태도 바꾸지 않는다.
브라우저 본인 기한 알림에 Slack 접수/대기/불명 상태를 표시한다. Slack 이력 조회나
unknown 강제 재발송·운영자 조정 UI는 제공하지 않는다. 불명 메시지는 Slack에서 실제
상태를 확인해야 하며 exactly-once 전송을 주장하지 않는다.

## 백업과 운영 경계

접수/불명 상태가 포함된 stopped-app snapshot을 새 디렉터리로 복원하면 그 상태를 보존한다.
외부 발송 이전의 **과거 snapshot**으로 되돌리면 이후 발송 기록은 복원할 수 없다.
이 경우 먼저 `slackNotifications`를 빼고 시작해 원격 발송 내역과 대조한 뒤 재활성화한다.
로컬 DB 복구가 Slack 메시지를 되돌리지는 않는다. [백업 절차](16-RUNTIME-BACKUP.md).

초기 구현은 기한 알림만 연결한다. 댓글·멘션·임의 원문 전송, Slack 승인 버튼, OAuth 설치
wizard, 디렉터리/대화 이력 수집, 실제 조직 연결은 포함하지 않는다. Confluence와 임베딩의
반출 권한도 독립적이며 이 알림 설정으로 함께 허용되지 않는다.
