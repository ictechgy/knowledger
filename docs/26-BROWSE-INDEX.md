# 검증된 조회 참조 인덱스

목록·검색의 HTTP 응답과 cursor 계약을 유지하면서, 페이지마다 모든 개정/제안/합의 본문과
최초 쓰기 checkpoint를 다시 읽던 경로를 바꿨다. Local/Fabric 어댑터가 공유하는
`VerifiedBrowseIndex`가 후보와 순서를 선택하고, 서비스는 선택된 key만 원장에서 읽는다.

## 인덱스가 보관하는 것

- revision: key, digest, 전체 slot, 최초 게시 checkpoint
- proposal: key/ID, revision digest, 전체 slot, 생성 시각, 최초 checkpoint
- agreement: key/ID, revision digest, 전체 slot, 활성 시각, 최초 checkpoint

본문·비공개 source/초안·현재 승인 상태·eligibility는 인덱스에 넣지 않는다.
제안·합의의 상태가 바뀌면 서비스가 해당 snapshot의 canonical 값을 읽는다.
최종 지식 사용 판정은 기존 domain resolver, fence, 권한 및 최신성 검증을 그대로 거친다.

Local은 검증한 local journal, Fabric은 peer 전체 블록에서 검증한 **VALID transaction**의 write로 구성한다.
메모리 인덱스의 존재를 Fabric 커밋 증명으로 취급하지 않는다.

## 원자성과 재시작

1. 검증된 write-set에서 새 메타데이터를 준비한다. 이후 proposal/agreement 쓰기가 최초의 ID·digest·slot·정렬 시각을 바꾸면 거부한다.
2. SQLite transaction을 커밋한다. 실패하면 준비한 인덱스 변경을 버린다.
3. 성공한 뒤 인덱스를 교체한다. 공개되기 전의 후보 인덱스는 요청에서 볼 수 없다.

시작/복원 시에는 기존 journal 검증과 같은 pass에서 다시 만든다. generator로 write를 순서대로 소비하고
작은 참조만 추가한 뒤 변경된 배열을 한 번 정렬한다. 전체 과거 본문을 배열에 모으지 않는다.
인덱스용 DB 파일이나 SQL schema migration은 추가하지 않았다. 기존 snapshot 복원 형식을 유지한다.

Fabric의 INVALID 거래는 제외하고 같은 블록 안에서도 transaction index까지 비교한다.
빈 블록의 `transaction_index: -1` checkpoint도 기존 상태를 조회할 수 있다.
중복 블록, 동일 명령 재시도, SQL rollback에서 참조가 중복되거나 앞서 나가지 않는다.

## 조회와 무결성

전체 슬롯별 최신 게시본, 문서별/슬롯별 이력, revision별 제안/합의 참조를 정렬된 배열과 Map으로 찾는다.
반환한 참조는 복제해서 호출 측 변경이 인덱스에 영향을 주지 않게 한다.

cursor는 기존 actor·조회 조건·정확한 checkpoint 결속을 유지한다. 어댑터의 `assertCheckpoint`를 먼저 거치고,
해당 시점까지 생성된 참조만 반환한다. 선택된 canonical record의 key·ID·slot·정렬 필드도 다시 대조한다.
SQL 파생 행을 삭제/변조해서 참조의 순서나 전체 개수를 조용히 바꾸는 방식은 허용하지 않는다.
선택한 canonical record가 없거나 다르면 요청을 중단한다.

최신 슬롯 집합 등 revision 메타데이터 결과는 exact checkpoint·모드·필터 기준으로 캐시한다.
상한은 **8개 결과 집합, 총16,384 refs, 추정512KiB**다. 참조 포인터 배열만 보관하고 본문을 복제하지 않는다.
캐시에서 밀린 과거 시점은 작은 메타데이터에서 다시 계산한다.

서비스는 선택된 페이지 안에서만 config, revision, slot eligibility 계산을 재사용한다.
외부/테스트 어댑터가 선택적 `queryBrowse`를 제공하지 않으면 `ScanningBrowseQueries`가 그 어댑터의
검증된 `entries`/최초 checkpoint로 같은 메타데이터 인덱스를 만든다. 이 호환 경로는 최초 scan 비용이 든다.

실제 canonical 값의 SQL 조회는 기존 `(state_key, sequence)` 인덱스를 사용한다.
`EXPLAIN QUERY PLAN`에서도 `projection_history`의 해당 key/sequence 범위 `SEARCH`를 확인했다.

## 검색 의미와 캐시

검색은 기존 `${title}\n${body_markdown}`의 `toLocaleLowerCase().includes()` 규칙을 유지한다.
빈 문자열, 한 글자, 한글, emoji, `%_` 같은 문자열을 그대로 처리하며 기존 잘못된 Unicode 거부도 유지한다.
context/scope/usage 조건은 인덱스 후보 단계에서 적용한다.

첫 검색은 scope에 맞는 참조를 최대1,000개씩 순회하며 검증된 원문을 읽는다. 이후 페이지는 동일 actor/조건/
checkpoint에서 찾은 **digest ID 목록**을 재사용한다. 검색 캐시는 **8개, 총20,000 IDs, UTF-8 key/ID bytes 2MiB**로
제한하고 본문·원래 검색어를 보관하지 않는다. 빈 결과도 캐시하며, 큰 결과는 캐시하지 않고 다시 계산한다.
checkpoint가 달라지면 새 검색이므로 철회·변경 후에도 옛 eligibility를 제공하지 않는다.

## 전후 측정

Node24, 1,000개1KiB 문서, 같은5회 표본과 **모든50개 요약 페이지 순회** 조건이다.
`de3e953`의 별도 source copy와 수정본을 다른 테스트 부하 없이 순서대로 실행했다.

| 항목 | 수정 전 | 수정 후 |
| --- | ---: | ---: |
| 목록 전 페이지 p95 | 1,071.24ms | 176.56ms |
| 검색 전 페이지 p95 | 995.32ms | 209.72ms |
| 게시 p95 | 1.43ms | 1.58ms |
| 재시작 replay | 248.99ms | 268.17ms |

읽기는 이 표본에서 약84%/79% 줄었다. 참조 인덱스 유지 비용으로 게시와 재시작 비용은 소폭 증가했다.
짧은 로컬 표본이며 운영 SLA나 모든 workload의 개선 보장은 아니다.

10,000개1KiB 문서도 전체 목록·검색·재시작 전후 개수가 일치했다.
단일 순회는 목록 약1.71초, 검색 약2.05초, 재시작 약2.69초였다. 이는 비교 baseline이나 안정적인 p95 측정이 아니다.

측정 근거는 Git 제외 `.artifacts/browse-index/{baseline-final,after-final,comparison,scale-10000,query-plan}.json`이다.
반복 명령과 기본 workload는 [자동 실험](22-AUTOMATED-EXPERIMENTS.md)에 있다.

## 남는 비용

현재 참조는 entity 수에 비례해 유지한다. 새 metadata ref 생성 시 정렬 배열과 Map을 copy-on-write하므로
쓰기 비용은 기존 참조 수의 영향을 받는다. 캐시가 없는 snapshot 집합 계산은 메타데이터를 순회하고,
새 substring 검색은 후보 원문을 읽는다. 전체 이력 검증과 Fabric의 cold snapshot replay도 계속 수행한다.
무관한 fence/상태 갱신은 인덱스를 복사하지 않는다.

회귀 검사는 다음을 포함한다.

- 페이지 크기에 비례한 canonical read와 전체 prefix scan 제거
- 인덱스/검증 scan 호환 경로의 응답·순서 동일성
- 과거 cursor, 새 게시, 합의 활성·철회, 최신 resolver의 withheld
- scope/Unicode 검색, 캐시 상한·eviction
- 다중 거래 블록, INVALID 제외, SQL 실패/재시작, 파생 SQL 변조 거부
