# 로컬 런타임 DB 백업과 복원

앱을 종료한 상태에서 로컬 런타임의 SQLite DB를 한 묶음으로 백업하고 새 데이터 폴더로 복원한다.
비공개 초안·preview·run·명령 기록, 로컬 원장 또는 Fabric projection·outbox를 함께 보존한다.

## 실행

Node 24 이상에서 앱을 실행한 터미널의 Ctrl+C로 종료한 뒤 사용한다. 같은 데이터 폴더를
사용하는 다른 프로세스도 종료해야 한다. WAL·SHM·journal 파일이 남아 있으면 백업을 거부한다.
앱의 정상 시작·종료로 정리하며, journal 파일을 수동으로 삭제하지 않는다.

```sh
npm run data:backup -- --data .data/fabric-login --out .data/login-backup-20260916
npm run data:restore -- --snapshot .data/login-backup-20260916 --out .data/login-restored-20260916
npm run start:login -- --data .data/login-restored-20260916
```

복원 위치는 존재하지 않는 새 폴더여야 한다. 원래 데이터나 기존 백업 폴더를 덮어쓰지 않는다.
원본과 출력은 서로 안에 두지 않는다. 상위 경로의 실제 위치로 중첩을 판정하고, 대상 폴더와 DB의 symlink를 거부한다.
현재 지원 한도는 **DB 파일당 512 MiB**다.

## 포함되는 파일

| 프로필 | DB |
| --- | --- |
| 로컬 시뮬레이션 | `shared-ledger.sqlite`, `private-local.sqlite` |
| Fabric 테스트/개발 로그인 | `fabric-projection.sqlite`, `private-local.sqlite`, Sales·Fulfillment·Settlement의 세 actor outbox DB |

정확한 프로필의 DB 파일이 모두 있어야 한다. 빠진 파일·섞인 프로필·알 수 없는 SQLite 파일은
거부한다. 인증서·개인키·환경 파일·브라우저 세션은 읽거나 복사하지 않는다.
DB 안에는 비공개 본문과 실행 기록이 들어 있으므로 백업 폴더도 해당 데이터의 비공개 경계를 유지한다.
새 폴더는0700, 파일은0600으로 만든다. 암호화된 원격 백업 서비스는 별도 운영 구성이다.

## 검증과 복원 범위

백업은 복사 전후 원본 파일의 식별자·크기·변경 시각·SHA-256을 비교하고, 복사본과 원본의
SQLite 무결성을 검사한다. 완성된 백업의 `manifest.json`에는 프로필·버전·작성 시각·파일명·크기·hash만 기록한다.
복원은 manifest 형식과 정확한 파일 목록·hash·SQLite 무결성을 검사한 뒤 새 폴더를 완성한다.
손상된 백업은 복원하지 않는다. hash는 우발적인 손상 검출용이며 백업 발행자의 서명을 뜻하지 않는다.

Fabric 프로필은 **애플리케이션의 projection·private store·outbox**를 복원한다.
peer/orderer 원장, CA, 인증서와 서명 키는 각각 별도의 보존 대상이다. 실제 Fabric 네트워크와
승인된 테스트 신원이 있어야 앱이 재연결하고 현재 VALID 블록까지 동기화할 수 있다.
복원된 DB 파일만으로 최신 VALID commit을 확인했다고 취급하지 않는다.

로그인 세션과 IdP 메모리 상태는 백업하지 않는다. 복원 후 다시 로그인한다.
이전 프로세스의 run은 새 실행으로 재검토하고, 저장된 초안은 본인 계정으로 다시 열 수 있다.

```sh
npm run check
npm run check:types
npm run auth:smoke
```

`auth:smoke`는 별도 fixture에서 실제 승인·철회 후 앱을 종료하고 백업→새 폴더 복원→다시 로그인한다.
초안 목록·원문·수정 재시도와 철회 상태를 다시 확인한다. 독립 조직·호스트의 전체 Fabric 재해 복구나
운영 RTO/RPO 측정으로 해석하지 않는다. 실행 근거는 [검증 기록](VALIDATION.md)에 남긴다.
