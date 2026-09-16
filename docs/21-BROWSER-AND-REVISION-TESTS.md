# 개정본 비교와 브라우저 회귀 검사

## 개정본 비교

선택한 정확한 개정본을 부모 개정 또는 같은 문서 범위의 이전 개정과 비교한다.
검토함에서 과거 제안을 선택하면 최신 게시본이 그 원문을 대신하지 않는다.
현재보다 나중에 게시된 개정을 “이전 개정” 후보로 넣지 않는다.

제목·본문 줄·의존성의 추가/제거/조건 변경을 표시한다. 같은 dependency digest라도
`enforcement`, `relationship`, 범위 필드가 달라지면 상세 비교에 나타난다.
CRLF/LF만 바뀐 경우에도 원문 바이트가 다르다는 안내를 표시한다.
최초 게시본에는 비교할 이전 개정이 없음을 명시한다.

본문은 HTML로 실행하지 않고 텍스트로 표시한다. 256KiB를 넘는 본문은 거부하고,
줄 수의 곱이20,000을 넘으면 LCS 계산을 생략해 두 원문을 나란히 보여준다.
작은 입력의 줄 비교와 큰 입력의 원문 비교는 같은 정확한 digest를 가리킨다.
개정 비교는 검토 보조이며 승인·채택의 서버 판정을 대신하지 않는다.

## 브라우저 검사 설치와 실행

Playwright는 별도 선택형 테스트 패키지에 고정했다. 기본 로컬 실행과 `npm run check`에는 필요 없다.
[공식 설치 안내](https://playwright.dev/docs/intro)와 [CI 안내](https://playwright.dev/docs/ci)를 따른다.

```sh
npm ci --prefix packages/browser-tests --ignore-scripts --no-fund
node packages/browser-tests/node_modules/playwright/cli.js install chromium
npm run test:browser
npm run test:browser -- --grep 'pending'
```

각 검사는 별도 임시 DB와 임의 loopback 포트를 사용한다. 실행 중인4317 앱이나 기존 Fabric 원장을
수정하지 않는다. 개인 브라우저 프로필·실제 회사 계정·외부 모델은 사용하지 않는다.

## 자동화한 동작

- 빈2조직 workspace에서 초안→공개 미리보기→게시→사람 승인2개→활성→조회→철회.
- 계정 전환 후 비공개 초안과 요청 이력 격리.
- 정확한 과거 제안 원문, 개정 차이, 악성 HTML의 비실행,390/600/1440px 가로 넘침과 focus.
- 미확정 요청을 앱 재시작 후 복원하고 명시적 동일 요청 재시도로 한 번만 반영.
- 확인 API503 동안 미확정 유지, 지연된 커밋의 자동 발견.
- 이전 계정의 늦은 목록/401 응답 무시.
- 빠른 승인 중복 클릭의 단일 요청, 게시 응답 유실 뒤 원장 결과 재조회.

미확정·지연·503은 테스트 전용 adapter/HTTP fault로 주입한다. 실제 Fabric VALID 검증의 대체 증거가 아니다.
실제 원장 경로는 [요청 추적](20-REQUEST-TRACKING.md)의 configured smoke와 Fabric adapter 검사로 확인한다.

trace·video·자동 screenshot은 기본 비활성화한다. 실패 시 DOM 맥락은 Git 제외 `.artifacts/browser-tests`에 남는다.
테스트 데이터는 합성 데이터만 사용한다. CI는 Chromium 검사와 별도 [성능·장애 실험](22-AUTOMATED-EXPERIMENTS.md)을 실행하도록 구성했다.
원격 CI 실행 여부는 [검증 기록](VALIDATION.md)에 구분한다.
