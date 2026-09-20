# 채택 파일럿 측정

[도입 계획](07-DELIVERY-PLAN.md)의 P4 파일럿은 한 개념과 실제 cross-context 업무 하나를 관찰한다.
`tools/adoption-metrics.ts`는 그 관찰을 감사 가능한 측정 기록으로 만든다 — 저널에서 파생할 수 있는
지표는 검증된 이벤트에서 계산하고, 사람이 판단해야 하는 지표는 명시적 관찰 로그로 받는다.
기본 모드는 로컬 저널이고, `--mode fabric`은 저장된 Fabric full block을 읽기 전용으로
재생해 VALID 거래만 같은 계산기에 전달한다.

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

실제 파일럿은 [계획·결과 템플릿](../examples/pilot/PLAN.template.md)으로 대상 조직,
개념·업무·기간, 사람 검토자, 공개 범위, 대조군, 성공·중단 기준부터 정한다.
[빈 관찰 로그](../examples/pilot/observations.template.json)를 비공개 작업 경로로
복사하고 `pilot_id`·`concept`·`workflow`를 바꾼 뒤 실제 관찰만 추가한다.
아래 예제 로그는 형식 확인용 가상 관찰이며 실제 파일럿 측정에 섞지 않는다.

`examples/pilot/observations.example.json` 형식을 따른다. `kind`는
`interpretation_mixing`·`review_question`·`disclosure_burden` 세 가지이고, 각 항목은
`subject`·RFC 3339 시각(윤초 `:60` 제외)·선택 `detail`을 가진다. 스키마는 엄격히
검증된다 — 형식과 필드 범위(존재하지 않는 날짜 포함)를 모두 확인한다.

## 실행

애플리케이션을 정상 종료한 뒤 데이터 디렉터리의 저널을 연다.

### 로컬 저널

```sh
npm run pilot:metrics -- \
  --data .data \
  --observations ./examples/pilot/observations.example.json \
  --out ./.artifacts/pilot-measurement.json
```

`--mode local`은 생략할 수 있다. `--ledger PATH`로 저널 파일을 직접 지정하거나
`--channel ID`로 다른 채널을 선택할 수 있다. 기본 예제 채널은 `kcl-demo`다.
저널은 읽기 전용으로 열어 채널과 해시 체인을 검증한다 — 빈·잘못된 파일은 측정으로
통과하지 않는다. 읽기 전용이라도 SQLite는 WAL 인덱스(-shm)를 만들거나 갱신할 수
있다 — 저널 내용의 변경은 아니며 읽는 동안 입력이 바뀌지 않는 정지된 저장소라는
계약의 일부다. 출력은 `schema_version: 1`의 측정
기록이다 — `derived`(저널 파생)·`observed`(관찰 집계)·`window`(이벤트 범위)를 포함하고
각 합의의 시간 표본을 남긴다. `--out` 아티팩트는 다른 도구와 같은 안전 쓰기(심볼릭 링크·
FIFO·하드링크 거부, mode 0600)로 저장되며, 출력 디렉터리는 기존에 있어야 한다 —
저널·관찰 입력과 같은 경로나 그 하위는 거부된다.

### Fabric projection

운영 앱을 정상 종료하고 [오프라인 백업·복원](16-RUNTIME-BACKUP.md)으로 만든 새
디렉터리의 `fabric-projection.sqlite`를 측정한다. 선택적 `packages/fabric` 의존성이
필요하다. 키·인증서나 peer 연결은 사용하지 않는다.

```sh
npm run pilot:metrics -- \
  --mode fabric \
  --ledger ./pilot-restored/fabric-projection.sqlite \
  --channel YOUR_CHANNEL \
  --chaincode YOUR_CHAINCODE \
  --chaincode-version YOUR_CHAINCODE_VERSION \
  --genesis ./pilot/public-genesis.json \
  --observations ./pilot/observations.json \
  --out ./.artifacts/fabric-pilot-measurement.json
```

`--data DIR`를 쓰면 그 디렉터리의 `fabric-projection.sqlite`를 선택한다. Fabric
모드는 `--channel`·`--chaincode`·`--chaincode-version`·`--genesis`를 모두 요구한다.
`--genesis`는 해당 앱을 bootstrap한 공개 genesis 객체의 JSON이다. 프로젝트 설정을
사용했다면 그 설정의 `genesis` 객체를 별도 공개 파일로 준비한다. DB 안의 값을
자동으로 신뢰 기준으로 채우지 않으며, 저장된 schema/channel/chaincode/version/genesis
바인딩과 하나라도 다르면 거부한다. 로컬 모드에 Fabric 전용 옵션을 주는 것도 거부한다.

블록0부터 연속된 원시 블록의 바이트 digest·헤더 체인·data hash·최종 validation
filter·쓰기 schema·불변 값·참조 관계를 공통 `FabricBlockProjector`로 검증한다.
같은 블록의 여러 거래는 transaction index 순서대로 모두 집계하고 INVALID는 제외한다.
SQL의 `fabric_raw_transactions`, `result_json`, state/history 테이블은 지표 입력으로
사용하지 않는다. 검증된 말단과 저장 cursor가 다르거나 원시 저널이 비었으면 거부한다.
일반 projection 기동처럼 파생 테이블을 재구축하거나 파일 모드를 바꾸지 않는다.

검증·집계·cursor 확인은 하나의 읽기 트랜잭션에서 수행한다. 결과는 기존
`schema_version: 1`의 `derived`·`observed`를 유지하고 Fabric 모드에 다음 필드를 추가한다.

| 필드 | 의미 |
| --- | --- |
| `source.kind` / `source.verification` | `fabric-projection` / `offline-full-block-replay` |
| `source.channel_id`, `chaincode_name`, `chaincode_version`, `genesis_digest` | 호출자가 고정한 배포 바인딩 |
| `source.block_count`, `valid_transaction_count`, `invalid_transaction_count` | 읽은 전체 블록과 거래 수 |
| `source.checkpoint` | 빈 블록·INVALID 전용 말단도 포함한 마지막 전체 블록 번호·해시·data hash |
| `source.journal_digest` | 64자리0에서 시작해 각 원시 블록 SHA-256을 순서대로 이어 해시한 누적 digest |
| `window.first_checkpoint`, `window.last_checkpoint` | 처음/마지막 VALID 거래의 정확한 블록·transaction index·ID·해시 |

`window.first_sequence`·`last_sequence`는 Fabric에서는 해당 VALID 거래의 **블록 번호**다.
같은 번호에도 여러 거래가 있으므로 거래 식별에는 checkpoint 전체를 쓴다.
`window.tip_hash`는 마지막 집계 이벤트의 블록 해시이고, 뒤에 빈/INVALID 블록이 있으면
`source.checkpoint.block_hash`와 다를 수 있다. VALID 거래가 없는 정상 블록 저널도
지표는0건으로 만들되 `source`에 실제 읽은 범위를 남긴다.

누적 digest는 매 단계 `SHA256(hexDecode(previous_digest + raw_block_sha256))`로 계산해
Fabric 헤더 해시가 결속하지 않는 validation metadata까지 입력 신원에 포함한다.
이 값은 입력의 식별자이며 외부 서명이나 인증을 추가하지 않는다. 측정 결과는
원문 본문·관찰 상세를 싣지 않는다. 원시 블록/이벤트는 순차 소비하며 현재 원장 상태와
지표에 필요한 개정·제안·결정의 식별 정보는 메모리에 유지한다.

출력 보호에는 공개 genesis도 포함한다. DB, WAL/SHM/journal sidecar, 관찰·genesis와
같은 파일이나 그 별칭·하위 경로를 출력으로 지정하면 거부한다. 잘못된 바인딩·저널은
부분 결과를 stdout이나 아티팩트에 남기지 않는다.

## 해석 한계

이 측정은 한 파일럿의 기록이다. 팀·도메인 구성은 가설이며 일반화된 운영 지표나 SLA가 아니다.
저널 이벤트에는 파일럿 식별자가 없어 선택한 채널의 모든 기록이 이 파일럿에 귀속된다 —
파일럿 전용으로 처음부터 기록한 저널을 준비하고, `window` 필드로 실제 집계 범위를
확인한다 — 채널·시퀀스 경계와 검증된 말단 블록 해시가 어떤 저널 상태를 측정했는지
기록한다. 관찰 로그는 사람이 기록한 감사 입력이며 정규 파일·크기 제한으로 읽는다.
local-simulation 저널에서 계산한 지표는 Fabric 네트워크의 동일 이벤트를 대표하지 않는다 —
Fabric 모드를 선택해야 저장된 Fabric 블록을 측정한다. 이 모드도 **신뢰할 수 있는
인증된 peer 수신 경로에서 보존한 projection**을 입력으로 요구한다. 새 peer 조회,
MSP/endorsement 서명 검증, 현재 네트워크 tip·전체성 확인을 수행하지 않는다.
원시 블록·digest·cursor를 모두 일관되게 다시 쓴 파일이나 합성 블록을 실제 네트워크
커밋 증명과 구분해 인증할 수는 없다. 실행 근거에 projection 획득 경로와 독립적으로
보관한 tip/원시 저널 digest를 남긴다. 측정값은 그 입력 스냅샷에만 유효하다.

## 실제 실행의 완료 기준

1. 조직·배포 환경·책임자와 위 계획을 확정하고, 기존 운영 채널과 섞이지 않는
   파일럿 전용 원장 범위를 준비한다. 현재 CLI에는 기간 필터가 없으므로 기존
   원장 행을 잘라 해시 체인을 손상시키는 방법으로 기간을 만들지 않는다.
2. 실제 사람이 게시·검토·승인·이의 제기와 재사용 업무를 수행하고, 기존 절차의
   대조군도 동일한 정의로 관찰한다. 무관한 예제·벤치마크 이벤트를 포함하지 않는다.
3. 종료 시 앱 PID·명령·작업 경로를 확인해 정상 종료하고
   [오프라인 백업·복원](16-RUNTIME-BACKUP.md) 절차로 새 디렉터리에 복원한다.
   복원본에서 측정하고 `window`·관찰 digest·배포 커밋·환경을 결과에 붙인다.
4. 측정 표본 수·기간·완료 업무 수와 누락 관찰을 함께 회고한다. `review_effort`는
   노동 시간이 아니고 `reuse_rate`는 실제 업무 성공률이 아니므로 별도 관찰을
   보완한다. 담당자가 확대·반복·중단 결정을 기록해야 파일럿 완료다.

대상 조직·환경·실제 관찰이 없는 템플릿 작성이나 합성 저널 실행은 준비 검증이다.
독립 물리 호스트 장애 검증도 파일럿 측정과 별개로 남는다.
