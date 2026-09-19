# 채택 파일럿 측정

[도입 계획](07-DELIVERY-PLAN.md)의 P4 파일럿은 한 개념과 실제 cross-context 업무 하나를 관찰한다.
`tools/adoption-metrics.ts`는 그 관찰을 감사 가능한 측정 기록으로 만든다 — 저널에서 파생할 수 있는
지표는 검증된 이벤트에서 계산하고, 사람이 판단해야 하는 지표는 명시적 관찰 로그로 받는다.

## 측정 항목과 출처

| 지표 | 출처 | 계산 |
| --- | --- | --- |
| 해석 혼합 건수 | 관찰 로그 | `interpretation_mixing` 관찰 건수 |
| 합의까지 걸린 시간 | 저널 | 각 활성화된 합의의 `agreement.activated_at − proposal.created_at`, 표본·중앙값 |
| 검토 수고 | 저널 + 관찰 로그 | 제안·결정(승인/이의/철회)·철회된 합의·게시 개정 수 + `review_question` 관찰 건수 |
| 기밀 공개 부담 | 관찰 로그 | `disclosure_burden` 관찰 건수 |
| 재사용 비율 | 저널 | `dependencies`를 가진 개정 비율, 의존성 참조 수, 재사용된 distinct 다이제스트 수 |

저널 파생분은 도메인 기록의 타임스탬프와 결정 종류를 그대로 집계한다. 불변 기록(개정·결정)의
재기록은 한 번만 세고, 철회·중지는 상태 스냅샷이 아니라 상태 전이로 센다 — 같은 상태의
재기록은 새 철회가 아니다. 관찰 로그는 측정자가 기록한 건수만 더한다 — 도구는 관찰 내용의
진위를 판단하지 않는다.

## 관찰 로그

`examples/pilot/observations.example.json` 형식을 따른다. `kind`는
`interpretation_mixing`·`review_question`·`disclosure_burden` 세 가지이고, 각 항목은
`subject`·RFC 3339 시각·선택 `detail`을 가진다. 스키마는 엄격히 검증된다 — 형식과 필드
범위(존재하지 않는 날짜 포함)를 모두 확인한다.

## 실행

애플리케이션을 정상 종료한 뒤 데이터 디렉터리의 저널을 연다.

```sh
npm run pilot:metrics -- \
  --data .data \
  --observations ./examples/pilot/observations.example.json \
  --out ./.artifacts/pilot-measurement.json
```

`--ledger PATH`로 저널 파일을 직접 지정하거나 `--channel ID`로 다른 채널을 선택할 수 있다.
출력은 `schema_version: 1`의 측정 기록이다 — `derived`(저널 파생)·`observed`(관찰 집계)·
`window`(이벤트 범위)를 포함하고 각 합의의 시간 표본을 남긴다.

## 해석 한계

이 측정은 한 파일럿의 기록이다. 팀·도메인 구성은 가설이며 일반화된 운영 지표나 SLA가 아니다.
local-simulation 저널에서 계산한 지표는 Fabric 네트워크의 동일 이벤트를 대표하지 않는다 —
동일 도메인 규칙이므로 Fabric 배포에서 같은 절차를 반복할 수 있지만, 측정값 자체는 해당
저널에만 유효하다.
