# 릴리스와 의존성 운영

[로드맵](../ROADMAP.md) Track D의 운영 기준이다. 담당 maintainer가 릴리스마다
아래 근거를 남기며, 자동 태그·배포·의존성 자동 머지는 사용하지 않는다.

## 릴리스 주기와 버전

- 기본 점검 주기는 4주다. main의 변경이 하나의 설명 가능한 기능 묶음으로 모이고
  검증을 통과하면 릴리스한다. 변화가 없으면 점검만 기록하고 버전을 만들지 않는다.
- 호환 가능한 결함 수정은 patch, 기능 추가나 개발 알파의 호환성 변경은 minor로
  구분한다. 보안·데이터 무결성 결함 수정은 정기 점검일까지 기다리지 않는다.
- `0.x`라도 호환성이 저절로 보장된다고 가정하지 않는다. API, 설정, 저장 형식,
  승인·서명 정책의 변경은 영향 받는 배포와 이전 절차를 changelog에 명시한다.
- 모든 사용자 영향 변경은 같은 PR에서 [CHANGELOG.md](../CHANGELOG.md)의
  `Unreleased`에 기록한다. 변경 이유·새 동작·필요한 운영 조치가 우선이다.
- 릴리스 날짜는 실제 게시일로 기록한다. 버전만 올렸거나 로컬 검증만 끝난 상태는
  게시 완료로 표시하지 않는다. 이미 공개한 태그는 이동·재사용하지 않는다.

각 릴리스의 기능 범위와 서명·모델 egress 등 호환성 변경은 changelog의 해당
버전에서 확인한다. 후보 검증과 실제 게시 상태를 구분한다.

## 릴리스 준비

1. 대상 커밋과 직전 태그를 고정하고 작업 트리를 확인한다. 해당 범위의 변경만
   릴리스 노트로 옮기며 사용자 데이터·키·로컬 설정은 포함하지 않는다.
2. 루트, `packages/fabric`, `packages/auth`의 `package.json`과 각 lockfile의
   루트 버전을 함께 갱신한다. `packages/browser-tests`는 버전 없는 내부
   테스트 도구다. `infra/fabric`의 `0.1.0`과 배포 label `kcl_0.1.0`은 원장의
   배포 계약이므로 제품 릴리스 번호에 맞춰 바꾸지 않는다.
3. Node 24+와 잠긴 의존성으로 아래 검증을 실행한다. 이미 통과한 동일 커밋·동일
   환경의 근거는 재사용하되, 실행 명령·Node 버전·커밋·생략 이유를 남긴다.

   ```sh
   npm run check
   npm run check:types
   npm run demo
   npm run demo:kb
   npm run test:browser
   npm run test:backup
   npm run test:drill:multi-host
   ```

   [CI](../.github/workflows/ci.yml)는 Node 24/26, 선택 패키지를 설치하지 않는
   local runtime, Fabric/auth API 경계, Chromium, 성능·복구 드릴을 검사한다.
   Fabric 선택 의존성을 설치한 실행에서 관련 테스트가 skip 없이 실행됐는지
   확인한다. 성능 비교는 다른 테스트 부하와 분리한다.
4. Fabric SDK/proto/image/shim 또는 커밋 판정·인증 경계를 바꾼 운영 릴리스는
   유지보수 창에서 기존 네트워크의 `fabric:http-smoke`와 `configured:smoke`를
   순서대로 실행하고 full-block VALID 근거를 남긴다. 완료된 fixture에는
   최초 `fabric:smoke`를 재실행하지 않는다. 실망 검증이 없으면 릴리스 노트에
   그 경계를 명시하며 운영 검증 완료로 표시하지 않는다.
5. `Unreleased` 아래에 버전·날짜 섹션을 만들고 비교 링크, README 버전 표기,
   [ROADMAP.md](../ROADMAP.md), [HANDOFF.md](../HANDOFF.md)를 맞춘다.
   문서 링크·구조 검사를 통과시키고 변경 파일만 커밋한다.
6. 게시를 명시적으로 요청받은 경우에만 검증한 커밋에 태그를 만들고 원격에
   태그·릴리스를 게시한다. 원격 CI 성공, 태그의 커밋, 릴리스 페이지와 노트를
   다시 확인한 뒤 게시 완료로 기록한다.

게시 후 결함은 새 patch로 고친다. 앱 롤백도 데이터·저널 형식 호환성을 확인한
뒤 수행한다. 이미 커밋된 원장 거래를 코드 롤백으로 되돌릴 수 없다. 백업·복원은
[런타임 복원](16-RUNTIME-BACKUP.md) 절차에 따라 정지 상태에서 새 디렉터리로 한다.

## 의존성 기준

아래는 저장소에 잠긴 기준이며 최신 upstream 버전 목록이 아니다. lockfile은
직접·간접 의존성의 정확한 설치 입력이다.

| 범위 | 기준 파일 | 유지할 조건 |
| --- | --- | --- |
| 개발 도구 | [루트 manifest](../package.json), [lockfile](../package-lock.json) | Node 24+, TypeScript·Node 타입의 정확한 버전 |
| Fabric client | [manifest](../packages/fabric/package.json), [lockfile](../packages/fabric/package-lock.json) | Gateway 1.12.1, protos 0.3.7, gRPC 1.14.4, shim 2.5.8 |
| 인증 | [manifest](../packages/auth/package.json), [lockfile](../packages/auth/package-lock.json) | jose·openid-client·oidc-provider와 타입의 정확한 버전 |
| 브라우저 검사 | [manifest](../packages/browser-tests/package.json), [lockfile](../packages/browser-tests/package-lock.json) | Playwright와 같은 설치에서 제공하는 Chromium |
| Chaincode | [manifest](../infra/fabric/package.json), [lockfile](../infra/fabric/package-lock.json) | shim 2.5.8, 배포 계약 0.1.0; nodeenv의 Node 22.12.0은 앱의 Node 24+와 별도 |
| Fabric 이미지·도구 | [fixture 정의](../examples/order-workflow/test-network.py), [설치 기준](../infra/fabric/README.md) | peer/orderer 2.5.16, nodeenv는 SHA-256 digest로 고정; 다운로드한 도구는 Git 제외 |
| CI action | [workflow](../.github/workflows/ci.yml) | 전체 commit SHA 고정, 버전 주석과 함께 검토 |

직접 npm 의존성은 `^`, `~`, `latest` 없이 고정하며 각 manifest와 lockfile을 함께
변경한다. 통상 설치는 해당 디렉터리의 `npm ci --ignore-scripts --no-fund`를 쓴다.
패키지 설치 스크립트가 필요한 예외는 실행 이유와 영향을 PR에 명시한다.
로컬 시뮬레이션에 선택 Fabric/auth/browser 의존성을 강제로 추가하지 않는다.
새 외부 서비스·런타임 의존성은 필요한 사용 경로와 대체 가능성을 설명한다.

정기 의존성 검토는 릴리스 점검과 함께 한다. upstream 릴리스 노트와 보안 공지를
확인한 시점·대상 버전을 기록하며, 조회하지 않았으면 최신·취약점 없음이라고
주장하지 않는다. 한 PR은 관련된 의존성 묶음으로 제한하고 자동 머지하지 않는다.

## 갱신의 검증과 되돌리기

의존성 PR에는 이전/신규 버전·digest, 갱신 이유, upstream 근거, 호환성 영향,
검증 명령·결과, 롤백 가능 조건을 남긴다. lockfile의 예상 밖 registry/URL,
설치 스크립트, 플랫폼 패키지 변화도 검토한다. 실제 배포의 BOM과 이미지 digest는
그 배포에서 별도로 기록한다.

| 변경 경계 | 추가 확인 |
| --- | --- |
| TypeScript·Node | Node 24/26 CI, 타입 검사, erasable 구문과 무설치 local runtime |
| Fabric SDK/proto/shim | 전체 블록 해시·VALID 필터, 서명/attestation, exact checkpoint, 멱등 재시도, outbox 복구; 운영 릴리스 전 실제 VALID 거래 |
| 인증 | issuer/subject 바인딩, 세션 만료·권한 회수, CSRF, 거절·장애 경로 |
| 이미지·chaincode 런타임 | 기존 genesis·키 보존, 빌드·재생 호환성, 백업 복원 및 기존 네트워크의 유지보수 절차 |
| 브라우저·CI | 잠긴 Chromium의 UI 회귀, 최소 권한과 기존 CI 작업 실행 |

package rollback은 이전 manifest와 lockfile의 한 쌍으로 한다. 이미지 롤백은
이전 digest와 데이터 호환성 검증을 함께 요구한다. schema·정책 변경이 포함되면
[업그레이드 계약](07-DELIVERY-PLAN.md)의 reader 먼저 배포·replay 검증 원칙을 따른다.
네트워크나 키를 새로 만들거나 WAL/SHM을 삭제해 실패를 숨기지 않는다.
