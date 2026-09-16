# KB source connector

Knowledger의 source connector는 로컬 Markdown 저장소를 먼저 비공개 초안으로 가져온다. 이 단계는 공유 원장에 쓰거나 문서를 게시하지 않는다. 정책에 연결된 파일만 private source 상태에 기록하고, 사용자가 별도로 공개 미리보기와 게시를 요청해야 한다.

## 빠른 실행

개발용 로컬 실행에서는 먼저 짧은 session handshake를 수행한다. 이 handshake는 실제 회사 SSO가 아니며, loopback의 local-simulation 서버와 선택한 개발 actor를 확인한다.

```sh
npm run kb:sync -- \
  --server http://127.0.0.1:4317 \
  --workspace knowledge \
  --org OrgOneMSP \
  --actor maintainer \
  --root ./examples/markdown-kb \
  --manifest ./examples/markdown-kb/manifest.json
```

모든 인자는 필수다. `--root`와 `--manifest`를 읽기 전에 `GET /api/session`과 actor 선택 handshake가 성공해야 한다. 운영 OIDC에서는 브라우저의 로그인 세션이나 caller가 소유한 인증 transport를 사용한다. 개발 CLI에 회사 인증정보를 넣는 방식은 지원하지 않는다.

선택형 예제는 [Markdown KB manifest](../examples/markdown-kb/manifest.json), [kb-sync CLI](../tools/kb-sync.ts), [KB demo](../tools/kb-demo.ts)를 참조한다.

## Manifest

manifest는 파일 경로와 승인 정책을 연결한다.

```json
{
  "version": 1,
  "source_id": "repository-guidelines",
  "files": [
    {
      "path": "guides/shared-guideline.md",
      "policy_id": "policy-shared-guideline",
      "policy_version": 1,
      "title": "공동 지식 작성 가이드"
    }
  ]
}
```

`source_id`, `policy_id`, 정책 버전, 제목, 파일 경로는 서버와 filesystem connector가 모두 검증한다. 경로는 상대 Markdown 경로여야 하며 숨김 디렉터리, `..`, 절대 경로, 백슬래시와 경로 traversal을 허용하지 않는다.

제한은 다음과 같다.

- manifest 최대 128 KiB, 최대 100개 파일
- Markdown 파일별 최대 256 KiB
- 한 source의 present 파일 합계 최대 16 MiB
- source state는 present 최대 100개, removed를 합한 항목 최대 200개를 보존
- Node filesystem 경로는 UTF-8 Markdown을 읽고 symlink·hardlink·변경 중인 파일·중복 경로를 거부

filesystem connector는 manifest의 allowlist에 없는 폴더 파일을 읽지 않는다. 허용 파일은 열린 descriptor에서 읽은 뒤 파일과 root의 변경 여부를 다시 확인한다. 누락 파일은 동기화 입력에 `missing_paths`로 남는다. 이는 관측한 파일 변경 검사이며 악의적인 동일 OS 프로세스를 격리하는 filesystem sandbox는 아니다. 브라우저 업로드는 사용자가 선택한 File 객체의 allowlist·형식·크기·actor 검사를 수행한다.

## 동기화 순서

`syncMarkdownSource`는 한 번의 동기화 입력을 먼저 검증한 뒤 source의 현재 버전을 읽는다.

1. 현재 source가 있으면, 이번 snapshot에도 있는 현재 경로만 남기도록 stale 경로를 먼저 reconcile한다.
2. 변경된 파일을 한 개씩 `POST /sources/{source_id}/markdown`으로 가져온다. 각 응답의 새 `source.version`을 다음 요청의 `expected_version`으로 사용한다.
3. 마지막에 실제 present 경로 전체를 reconcile한다. manifest에서 빠진 파일은 private source의 `removed` 상태가 되며 공유 문서나 기존 합의를 철회하지 않는다.

각 import는 private vault의 draft와 source metadata만 만든다. 원문 provenance와 source mapping은 private 영역에 남고, 공유 payload·검색·원장 event에 자동으로 첨부되지 않는다. 같은 파일 bytes와 mapping을 다시 보내면 기존 draft를 재사용하는 `unchanged` 결과가 될 수 있다.

중간 import가 실패하면 그 지점에서 멈춘다. 앞에서 성공한 private import를 전체 rollback한다고 가정하지 않으며, 실패한 요청 뒤에 자동 reconcile도 수행하지 않는다. 다시 시도할 때는 source detail을 다시 읽어 최신 version을 얻는다. operation ID가 같은 내용으로 재사용되면 서버가 안정적인 receipt를 반환하고, 다른 내용으로 재사용하면 충돌한다.

## HTTP API

모든 source 경로는 `/v1/workspaces/{workspace.id}` 아래에 있고 현재 actor의 private 범위로 보호된다.

| 경로 | 동작 |
| --- | --- |
| `POST /source-manifests/validate` | `manifest_json`을 검증하고 정규화된 manifest 반환 |
| `GET /sources` | actor의 source 요약과 present/removed 개수 반환 |
| `GET /sources/{source_id}` | source version과 파일별 private 상태 반환 |
| `POST /sources/{source_id}/markdown` | 정책에 연결된 Markdown 한 개를 private draft로 import |
| `POST /sources/{source_id}/reconcile` | 실제 present 경로 집합과 비교해 누락 파일을 tombstone 처리 |

새 source의 detail이 404이면 client는 version 0에서 시작할 수 있다. 이후 모든 쓰기는 `expected_version`을 요구한다. 다른 actor, 잘못된 정책, 오래된 version, 다른 operation 내용은 거부된다. source API에는 publish나 ledger write가 없다.

source entry의 `present`와 `removed`는 원본 수집 상태다. `removed`는 마지막 동기화에서 파일이 누락됐다는 뜻이며, 공유 revision의 철회·정지와 별개다. 공유 지식 사용은 여전히 policy, 사람 승인, VALID commit, fresh resolver 검사를 거친다.

## 브라우저 가져오기

웹 화면의 **저장소 가져오기**는 manifest JSON과 폴더를 선택한 뒤 사용자가 버튼을 눌렀을 때만 작동한다. 먼저 manifest allowlist를 서버에서 검증하고, 폴더의 첫 root segment를 제거해 manifest 경로와 매칭한다. 허용된 파일의 bytes를 모두 UTF-8·256 KiB·source 16 MiB 한도 안에서 확인한 뒤 첫 mutation을 보낸다.

누락 파일이 모두 없어도 **비공개 동기화**를 명시적으로 눌러 removed 상태를 반영할 수 있다. 실패한 actor의 늦은 응답은 버리고, 브라우저 storage에는 원문·세션·인증정보를 저장하지 않는다.

개발 handshake는 local-simulation만 허용한다. 실제 OIDC와 cloud KMS/HSM의 공급자 선택은 이 connector의 필수 조건이 아니다. 운영 환경에서는 caller가 인증된 transport와 secret 보관 경계를 제공해야 한다.
