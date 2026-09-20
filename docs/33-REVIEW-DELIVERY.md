# 33. 선택한 검토 댓글 전달

작성자가 수신자를 확인하고 요청한 댓글 하나만 별도 앱의 지정된 사람에게 전달한다.
기본값은 비활성이다. 기존 댓글·멘션·일정은 자동 전파하지 않고, 받은 댓글은 수신자
전용 inbox에 보관한다. 수신 앱의 전체 검토 대화나 승인 기록으로 편입하지 않는다.

현재 범위는 전달 인터페이스·영속 재시도 큐·수신 중복 제거와 가상 연동이다. 실제 운영
조직에 연결한 결과가 아니며 Slack/Teams/메일 adapter는 미구현이다.
[앱 내부 자동 기한 알림](34-REVIEW-REMINDERS.md)은 별도로 제공하고 이 외부 전달 큐에는 연결하지 않는다.

## 화면과 가상 데모

전달 대상을 설정한 앱에서는 본인이 작성한 댓글에 **이 댓글 전달**이 나타난다. 대상의
조직·계정을 선택하고 원문 전달 확인을 체크하면 **내 전달 요청**에 대기 상태가 표시된다.
**내게 전달된 댓글**의 원문은 본인에게만 보인다. HTML은 실행하지 않고 계정 변경 시
이전 목록과 늦은 응답을 폐기한다. 전달 상태는 화면 갱신 시 조회하며 실시간 푸시는 없다.

`수신 저장 확인`은 수신 앱 DB의 저장 영수증을 확인한 상태다. 사람이 읽거나 검토를
완료했다는 뜻이 아니며, 합의 승인·지식 사용 허가·Fabric VALID 커밋 증명이 아니다.

```sh
npm run demo:review-delivery
```

데모는 임시 로컬 앱 두 개와 메모리상의 시험 키를 만든다. 같은 공개 개정을 시뮬레이션에
준비하고 첫 수신 응답을 일부러 유실시킨 뒤 동일 패킷을 재전송한다. 전송2회·수신1건,
수신자 격리, 공유 문서 본문 제외, 승인0건과 전달에 의한 원장 변경 없음을 검증한다.
종료 시 자신이 만든 앱과 임시 폴더만 정리한다. 기존 Fabric fixture·키는 사용하지 않는다.

## 런타임 설정

`createApp`/`createConfiguredApp`의 `reviewDelivery` 옵션으로 주입한다. 함수·키를 포함하므로
`knowledger.config.json`의 새 필드가 아니다. 기본 CLI는 전송을 켜지 않는다. 배포 코드에서
비밀 저장소의 키와 고정 대상을 공급한다. 아래 조직명은 예시이며 실제 project 구성으로 바꾼다.

```ts
import { createConfiguredApp } from '../apps/api/configured-runtime.ts';
import { createReviewHttpTransport } from '../packages/review/http-delivery.ts';

// configuration, dataDir, sharedKey는 배포 코드가 검증·공급한다.
const sender = await createConfiguredApp(configuration, {
  dataDir, port: 4317,
  reviewDelivery: {
    source_id: 'alpha-review-app', source_org_id: 'AlphaMSP',
    destinations: [{
      id: 'beta-review-inbox', label: 'Beta 검토함', version: 1,
      recipient: { org_id: 'BetaMSP', actor_id: 'maintainer' },
      transport: createReviewHttpTransport({
        endpoint: 'https://beta.example.invalid/v1/workspaces/knowledge/review-deliveries/receive',
        key_id: 'alpha-beta-key', secret: sharedKey,
      }),
    }],
  },
});
await sender.listen(4317);
```

수신 앱은 같은 workspace/channel과 공개 개정을 검증할 수 있어야 한다. 수신 설정 예시는
다음과 같다. 기존 loopback listener 앞의 HTTPS proxy와 `server.public_origin`은
[프로젝트 설정](19-PROJECT-CONFIGURATION.md)을 따른다.

```ts
reviewDelivery: {
  source_id: 'beta-review-app', source_org_id: 'BetaMSP',
  peers: [{
    key_id: 'alpha-beta-key', secret: sharedKey,
    source_id: 'alpha-review-app', org_id: 'AlphaMSP',
  }],
}
```

- source ID는 설치의 지속적인 식별자이며 복원 시 유지한다.
- destination ID·버전·수신자·transport binding을 큐에 결속한다. URL/수신자/버전 변경은
  이전 작업을 차단하며, 새 대상을 확인한 별도 요청이 필요하다.
- `ReviewTransport.send(packet, signal)`은 신뢰된 배포 adapter 경계다. `binding`은 실제
  endpoint/tenant의 안정적인 식별자여야 한다. HTTP 사용자 입력으로 URL·adapter·headers를
  지정하지 못한다. credentials는 런타임에만 두고 큐/로그/API 응답에 넣지 않는다.
- 선택 `destination.allows({author, recipient, revision_digest, signal})`는 현재 전송 정책이다.
  지정 시 엄격한 `true`만 허용한다. 미지정은 명시적으로 구성된 대상과 작성자의 원문 전달
  확인으로 허용한다. 정책 훅 전후 현재 원장 membership/serving과 계정 권한을 재확인한다.
- 패킷은 선택한 댓글·작성자·공유 개정의 전체 slot을 포함한다. 공유 문서 본문, 비공개 초안,
  다른 댓글·멘션 목록·개인 원본 provenance·승인 기록은 보내지 않는다.

## 인증과 수신 경계

HTTP adapter는 고정 HTTPS URL을 사용하고 userinfo·query·fragment와 redirect를 거절한다.
`allowInsecureLoopback: true`는 숫자 loopback HTTP 시험 주소만 허용한다. 실제 URL과 peer
키의 배포·회수는 운영 설정이며 이 기능이 자격정보를 발급/회전하지 않는다.

32~128바이트 키로 key ID·현재 초 단위 시각·canonical payload digest를 HMAC-SHA256에
결속한다. 수신자는 5분 시각 범위·상수 시간 MAC 비교·key별 source ID/조직을 검증한다.
재시도는 새 전송 시각/MAC을 사용하되 delivery ID와 payload는 유지한다. 이 인증은
**발신 앱의 진술**을 확인하며 개별 사람의 독립 서명이 아니다. 시계 동기화와 HTTPS가 필요하다.

수신 전 workspace/channel/전체 slot/정확한 digest, 현재 발신자 membership과 수신자의
로컬 persona·사람 종류·현재 계정 권한을 검사한다. 공개 개정을 아직 읽을 수 없으면503으로
재시도할 수 있다. 같은 source/delivery ID와 내용은 최초 영수증을 반환하고, 다른 내용은409다.
패킷·영수증은32KiB, 인증 후 동시 수신4건·수신 권한 검사10초 상한이다. 기존 Host/Origin
제한을 유지하며 이 기계 경로는 브라우저 쿠키 대신 peer MAC을 요구한다.

## 영속 큐·재시도·종료

outbox/inbox는 `private-local.sqlite`에 추가되고 기존 [정지 후 snapshot/복원](16-RUNTIME-BACKUP.md)에
포함된다. 키·토큰·URL을 저장하지 않지만 확인한 댓글 원문은 저장하므로 기존 private DB의
접근/백업 경계를 유지한다. 과거 앱 버전은 추가 테이블을 남긴다. actor별 `operation_id`와
요청 내용은 멱등이며, DB 트랜잭션으로 등록하고 원자적인 임대 토큰으로 작업을 가져간다.

프로세스 종료 후 임대 만료 시 재처리한다. 오래된 응답은 새 임대 소유자의 상태를 덮지 못한다.
수신은 **at-least-once**이며, 저장 후 응답 유실은 같은 ID를 다시 보내 수신 측에서 중복 제거한다.
전역 exactly-once를 주장하지 않는다. 기본/범위는 다음과 같다.

| worker 옵션 | 기본·범위 |
| --- | --- |
| `pollMs` | 1,000ms; 0은 자동 실행 중지, 최대60,000ms |
| `timeoutMs` | 권한 검사+전송 합산10,000ms; 10~30,000ms |
| `maxAttempts` | 5회; 1~10회 |
| `retryBaseMs` | 1,000ms; 1~60,000ms, 지수 backoff 최대1시간 |

한 tick은 서로 다른 작업 최대20개를 순차 처리하고 임대는 시도 마감+5초다. listen 후 자동
실행하며 수동 실행은 `app.service.reviewDelivery.worker.runOnce()`다. 종료는 타이머·활성
요청을 중단한 뒤 DB를 닫는다. 늦은 성공은 큐 상태를 바꾸지 않고, 권한 훅이 마감 후 끝나도
adapter를 새로 호출하지 않는다. 이미 호출된 사용자 정의 adapter는 signal을 준수해야 하며,
이를 무시한 외부 부수 효과까지 worker가 멈출 수는 없다. 이미 시작한 외부 수신도 취소로
되돌릴 수 없으므로 수신자 중복 제거를 사용한다.

네트워크/timeout·408/429/500/502/503/504와 영수증 불일치는 유한 재시도한다. 인가 거절·
수신 ID 충돌·대상 변경은 `blocked`, 횟수 소진은 `failed`다. failed는 미수신 확정이 아니라
확인 실패다. 본인의 명시적 재시도는 회차 시도 수를0으로 초기화하고 총 시도 수·동일 ID·원문을
유지한다. 대상 binding 변경은 수동 재시도로도 우회하지 못한다. 원격 오류 본문 대신 제한된
오류 코드만 남긴다. 자동 worker 저장소 오류는 `worker.lastError`의 안전한 코드로 관측하며
수동 `runOnce()`의 저장소 오류는 호출자에게 전달한다.

## API

접두사는 `/v1/workspaces/:id`. receive 외에는 현재 세션 인가와 POST CSRF를 따른다.

| 경로 | 입력/결과 |
| --- | --- |
| `GET /review-delivery-targets` | 활성 여부·대상 ID/라벨/버전/수신자; URL·키 제외 |
| `POST /revisions/:digest/review/deliveries` | `operation_id`, `event_id`, `destination_id`, `destination_version`, `confirm_shared: true`; 본인 댓글만 허용 |
| `GET /review-deliveries?limit=20&cursor=...` | 본인 전송함·상태·시도 수·다음 시도·오류 코드·영수증 |
| `POST /review-deliveries/:id/retry` | 빈 객체; 본인의 blocked/failed 작업만 재등록 |
| `POST /review-deliveries/receive` | peer 인증된 `ReviewPacket`; 검증·중복 제거 뒤 `ReviewReceipt` |
| `GET /review-deliveries/received?limit=20&cursor=...` | 본인 수신함과 댓글·최초 영수증 |

등록/재등록의 pending은 HTTP202, 수신 저장은200이다. 전달 큐202를 원장 VALID 대기로
혼동하지 않는다. 목록은 최신순 keyset이며 limit은1~50이다. 문서의 실제 사용 가능 여부는
전달 영수증이 아니라 기존 resolve/revalidate로 확인한다.
