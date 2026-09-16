# Markdown 파일을 비공개 초안으로 가져오기

로컬 repo나 KB에서 내보낸 Markdown 파일 한 개를 현재 사용자의 비공개 초안으로 저장한다.
기존 [로컬 앱](11-RUNTIME.md), [Fabric 웹](12-FABRIC-WEB.md),
[개발 로그인 앱](13-DEVELOPMENT-LOGIN.md)에서 같은 흐름을 사용한다.

## 화면에서 사용하기

1. 새 지식 문서를 작성하거나 기존 문서의 새 개정본 작성을 연다.
2. 제목·Context ID·Scope ID·Usage scope를 확인한다. 기존 문서 개정은 원래 slot과 의존성을 유지한다.
3. **Markdown 파일 가져오기**에서 `.md` 또는 `.markdown` 파일 한 개를 선택한다.
4. **파일로 비공개 초안 저장**을 누른다. 가져온 본문이 작성창에 표시된다.
5. 원문을 검토하고 **공유 게시 미리보기 생성**으로 수신 조직·본문을 확인한다.
   명시적인 공유 확인과 게시 후에도 별도의 제안·사람 승인·채택이 필요하다.

파일을 가져오면 현재 편집 중인 원문 대신 해당 파일로 새 초안을 저장한다.
편집창의 제목·범위 변경은 파일을 가져오기 전에 반영한다. 저장 뒤 내용을 수정하면
기존 미리보기를 지우며, 다시 저장하고 검토해야 한다.
저장된 초안은 [내 비공개 초안](15-PRIVATE-DRAFTS.md)에서 다시 열 수 있다. 수정본은 원래
문서의 범위를 유지한 새 초안으로 저장하며, 원본 파일의 hash를 수정한 본문의 hash로 복사하지 않는다.

지원 입력은 **UTF-8, 최대 256 KiB(262,144 bytes), 비어 있지 않은 파일**이다.
가져온 snapshot은 BOM·CRLF를 포함한 원본 UTF-8 바이트를 보존한다. 후속 수동 편집은
새 초안을 만든다. 이미지나 첨부파일은 가져오지 않는다.

## 기밀과 문서 의미

- 원본 파일명·바이트 수·SHA-256·가져오기 요청 기록은 actor별 비공개 저장소에 둔다.
  공유 revision payload나 공용 거래에 자동 첨부하지 않는다.
- 가져오기와 공개 미리보기는 원장 쓰기를 만들지 않는다. 공유는 별도 확인 요청으로만 수행한다.
- frontmatter, HTML, 링크와 문서 속 명령은 본문 그대로 저장한다. 파일 내용이 actor·scope·정책·의존성·승인을 설정하지 않는다.
- 파일 시스템 경로·원격 URL·폴더·다른 파일을 따라 읽지 않는다. 브라우저가 선택한 파일 바이트만 API에 보낸다.
- `source_kind: approved_import`는 사용자가 가져오기를 요청한 생성 출처다. 합의 승인 상태가 아니다.
  AI actor가 가져온 초안도 사람 승인을 대신할 수 없다.

private 저장소는 공용 원장과 분리되어 있지만, 현재 로컬 개발 환경의 OS 관리자에 대한
강제 격리를 제공하지 않는다. 공유 확인 후에는 본문 전체가 channel 운영자에게 보이는
기존 공개 경계가 적용된다.

## HTTP 계약

`POST /v1/workspaces/{workspace.id}/draft-imports/markdown` (order-workflow 예제: `demo`)

기존 세션·동일 출처·`X-KNOWLEDGER-CSRF` 검사를 사용한다. OIDC 모드에서는 현재 계정 권한도
요청 전후에 확인한다. 본문은 JSON이며 아래 필드만 받는다.

| 필드 | 의미 |
| --- | --- |
| `import_id` | 필수. 재시도 시 유지하는 요청 ID. 일반 API 식별자 형식 |
| `filename` | 필수. 경로를 제외한 `.md`/`.markdown` 파일명, 최대 255 UTF-8 bytes |
| `content_base64` | 필수. 원본 파일 바이트의 표준 padded base64 |
| `title` | 필수. 사용자가 검토할 문서 제목 |
| `context_id`, `scope_id`, `usage_scope` | 새 문서의 slot. 기존 개정에서는 원래 값을 유지 |
| `document_id` | 선택. 새 문서 ID; 생략하면 서버가 생성 |
| `base_revision_digest` | 선택. 기존 공유 개정본으로부터 새 초안을 작성 |

응답은 `{ draft_id, revision, import }`다. `import`에는 `kind: local_markdown`,
`filename`, `byte_length`, `sha256`이 들어간다. 이는 private draft 응답에만 포함된다.
내부 요청 digest는 응답하지 않는다.

같은 actor·`import_id`·동일 입력은 재시작 뒤에도 같은 초안을 반환한다. 같은 ID의 입력을
바꾸면 409로 거부한다. 다른 actor의 같은 ID는 서로 독립된 비공개 초안이다.
재시도할 때는 ID와 원래 입력을 유지하고, 다른 파일이나 내용을 가져올 때 새 ID를 사용한다.
잘못된 인코딩·파일명·초과 크기·추가 필드는 저장 전에 거부한다.

## 검증

```sh
npm run check
npm run check:types
npm run demo
npm run auth:smoke
```

API 회귀 검사는 원본 보존·잘못된 입력·재시도·재시작·actor 격리와 명시적 공개 경계를
확인한다. `auth:smoke`는 실제 로그인·Fabric에서 가져오기 전후 같은 checkpoint,
동일 요청 재시도, 명시적 게시 뒤 파일명 비공개와 후속 승인·철회를 검사한다.
실행 결과는 [검증 기록](VALIDATION.md)에 남긴다.
