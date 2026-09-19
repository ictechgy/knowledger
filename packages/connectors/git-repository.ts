import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { decodeMarkdownImport, MAX_MARKDOWN_BYTES } from '../import/markdown.ts';
import { MAX_SOURCE_BYTES, SourceInputError, sourcePath, validateSourceManifest } from './source-contract.ts';
import type { MarkdownSourceSnapshot } from './filesystem-markdown.ts';
import type { MarkdownSourceManifest } from './source-contract.ts';

const COMMIT_PATTERN = /^[a-f0-9]+$/u;
// ref 이름은 명령행 옵션·refspec·리비전 문법으로 해석될 수 없는 형태만 허용한다.
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u;
const REGULAR_BLOB = '100644';

/** 고정 커밋에서 읽은 source snapshot. files/missing_paths 계약은 filesystem connector와 같다. */
export interface GitSourceSnapshot extends MarkdownSourceSnapshot {
  ref: string;
  commit: string;
}

function invalid(message = '원본 Git 저장소를 읽을 수 없습니다.'): never {
  throw new SourceInputError(message);
}

/**
 * Git 하위 프로세스 환경 — 저장소 선택·행동을 바꾸는 GIT_* 변수(GIT_DIR, GIT_WORK_TREE,
 * GIT_OBJECT_DIRECTORY, GIT_CONFIG_* 등)를 상속에서 제거하고, promisor 원격의 lazy fetch와
 * refs/replace/* 치환 오브젝트를 끈다. 고정 커밋의 로컬 오브젝트만 읽기 위한 계약이다.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env.GIT_NO_LAZY_FETCH = '1';
  env.GIT_NO_REPLACE_OBJECTS = '1';
  return env;
}

function git(root: string, args: string[], maxBuffer: number): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], { maxBuffer, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    invalid();
  }
}

/** 저장소의 오브젝트 형식(sha1/sha256)에 맞는 16진 오브젝트 ID 길이를 확인한다. */
function objectIdLength(root: string): number {
  const format = git(root, ['rev-parse', '--show-object-format'], 1024).toString('utf8').trim();
  if (format === 'sha1') return 40;
  if (format === 'sha256') return 64;
  invalid();
}

function resolveCommit(root: string, ref: string, idLength: number): string {
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('/')
    || ref.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) invalid('올바른 Git ref가 필요합니다.');
  const inside = git(root, ['rev-parse', '--is-inside-work-tree'], 1024).toString('utf8').trim();
  if (inside !== 'true') invalid();
  const commit = git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], 1024).toString('utf8').trim();
  if (commit.length !== idLength || !COMMIT_PATTERN.test(commit)) invalid('Git ref를 고정 커밋으로 확인할 수 없습니다.');
  return commit;
}

/** ls-tree 한 줄에서 blob 모드·오브젝트 id를 얻는다. 일반 파일이 아니면 거부한다. */
function blobObject(root: string, commit: string, path: string, idLength: number): string | undefined {
  const output = git(root, ['ls-tree', '-z', commit, '--', path], 64 * 1024);
  const entry = output.toString('utf8').split('\0').find(Boolean);
  if (!entry) return undefined;
  const match = new RegExp(`^(\\d{6}) (\\w+) ([a-f0-9]{${idLength}})\\t(.+)$`, 'u').exec(entry);
  if (!match || match[4] !== path) invalid('원본 Git 응답이 올바르지 않습니다.');
  if (match[1] !== REGULAR_BLOB || match[2] !== 'blob') invalid('원본 경로는 일반 파일이어야 합니다.');
  return match[3];
}

function blobBytes(root: string, object: string): Buffer {
  const size = Number.parseInt(git(root, ['cat-file', '-s', object], 1024).toString('utf8').trim(), 10);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MARKDOWN_BYTES) invalid();
  return git(root, ['cat-file', 'blob', object], MAX_MARKDOWN_BYTES + 64);
}

/**
 * 로컬 Git 저장소의 고정 커밋에서 manifest allowlist 파일만 읽는다.
 * clone·fetch·인증정보는 이 커넥터의 책임이 아니다 — 호출자가 준비한 로컬 저장소와
 * 이미 체크아웃된 이력만 사용하며, 작업 트리 상태와 무관하게 커밋 내용만 본다.
 */
export async function readGitSource(input: { root: string; ref: string; manifest: MarkdownSourceManifest }): Promise<GitSourceSnapshot> {
  const root = resolve(input?.root ?? '');
  let rootStat: any;
  try { rootStat = lstatSync(root); } catch { invalid(); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root.split(sep).at(-1)?.startsWith('.')) invalid();
  const manifest = validateSourceManifest(input?.manifest);
  const idLength = objectIdLength(root);
  const commit = resolveCommit(root, input.ref, idLength);
  const files: MarkdownSourceSnapshot['files'] = [];
  const missingPaths: string[] = [];
  let totalBytes = 0;
  for (const mapping of manifest.files) {
    const safePath = sourcePath(mapping.path);
    const object = blobObject(root, commit, safePath, idLength);
    if (!object) { missingPaths.push(safePath); continue; }
    const bytes = blobBytes(root, object);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) invalid('원본 Markdown 전체 크기가 제한을 초과했습니다.');
    try {
      // filesystem connector와 같은 디코더로 UTF-8·BOM·제어문자 규칙을 맞춘다.
      decodeMarkdownImport(safePath.split('/').at(-1), bytes.toString('base64'));
    } catch { invalid(); }
    files.push({ mapping, content_base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.byteLength });
  }
  return { manifest, files, missing_paths: missingPaths, ref: input.ref, commit };
}
