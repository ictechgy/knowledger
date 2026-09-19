import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { readGitSource } from '../../packages/connectors/git-repository.ts';
import type { MarkdownSourceManifest } from '../../packages/connectors/source-contract.ts';

let gitAvailable = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { gitAvailable = false; }

function commit(root: string, message: string): string {
  execFileSync('git', ['-C', root, 'add', '-A'], { stdio: 'ignore' });
  execFileSync('git', ['-C', root, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '--allow-empty', '-m', message], { stdio: 'ignore' });
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-git-source-test-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  execFileSync('git', ['-C', repo, 'init', '-q'], { stdio: 'ignore' });
  const content = Buffer.from('# 가이드\n\n원문\n', 'utf8');
  writeFileSync(join(repo, 'docs', 'guide.md'), content);
  writeFileSync(join(repo, 'docs', 'draft.md'), Buffer.from('초안\n', 'utf8'));
  const head = commit(repo, 'first');
  writeFileSync(join(repo, 'docs', 'guide.md'), Buffer.from('# 가이드 v2\n', 'utf8'));
  commit(repo, 'second');
  const manifest: MarkdownSourceManifest = {
    version: 1, source_id: 'kb-source-001',
    files: [
      { path: 'docs/guide.md', policy_id: 'policy-v1', policy_version: 1, title: '가이드' },
      { path: 'docs/missing.md', policy_id: 'policy-v1', policy_version: 1, title: '누락' },
    ],
  };
  return { root, repo, head, content, manifest };
}

test('git connector reads only allowlisted files at the pinned commit', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const snapshot = await readGitSource({ root: item.repo, ref: item.head, manifest: item.manifest });
  assert.equal(snapshot.commit, item.head);
  assert.equal(snapshot.ref, item.head);
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].content_base64, item.content.toString('base64'));
  assert.equal(snapshot.files[0].sha256, createHash('sha256').update(item.content).digest('hex'));
  assert.equal(snapshot.files[0].byte_length, item.content.byteLength);
  assert.deepEqual(snapshot.missing_paths, ['docs/missing.md']);
  // 첫 커밋 고정이라 이후 작업 트리의 v2 내용이 섞이지 않는다.
  const branch = execFileSync('git', ['-C', item.repo, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  const headRef = await readGitSource({ root: item.repo, ref: branch, manifest: item.manifest });
  assert.notEqual(headRef.commit, item.head);
  assert.equal(headRef.files[0].content_base64, Buffer.from('# 가이드 v2\n', 'utf8').toString('base64'));
});

test('git connector resolves branch and tag refs to a pinned commit', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  execFileSync('git', ['-C', item.repo, 'tag', 'release-1', item.head], { stdio: 'ignore' });
  execFileSync('git', ['-C', item.repo, 'checkout', '-q', '-b', 'topic'], { stdio: 'ignore' });
  const tagged = await readGitSource({ root: item.repo, ref: 'release-1', manifest: item.manifest });
  assert.equal(tagged.commit, item.head);
  const branched = await readGitSource({ root: item.repo, ref: 'topic', manifest: item.manifest });
  assert.notEqual(branched.commit, item.head);
  // heads/tags 완전한 이름도 받는다.
  const qualified = await readGitSource({ root: item.repo, ref: 'refs/tags/release-1', manifest: item.manifest });
  assert.equal(qualified.commit, item.head);
});

test('git connector rejects ambiguous refs, pseudorefs and nested roots', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  // heads와 tags에 같은 이름이 있으면 짧은 이름은 모호하다 — 명시하면 해석된다.
  execFileSync('git', ['-C', item.repo, 'tag', 'dual', item.head], { stdio: 'ignore' });
  execFileSync('git', ['-C', item.repo, 'branch', 'dual', item.head], { stdio: 'ignore' });
  await assert.rejects(() => readGitSource({ root: item.repo, ref: 'dual', manifest: item.manifest }), /모호|ref/);
  const explicit = await readGitSource({ root: item.repo, ref: 'refs/tags/dual', manifest: item.manifest });
  assert.equal(explicit.commit, item.head);
  // 작업 트리 종속 pseudoref와 약식·다른 네임스페이스 ref는 받지 않는다.
  for (const ref of ['HEAD', 'ORIG_HEAD', item.head.slice(0, 12), 'refs/remotes/origin/main', 'refs/bisect/x']) {
    await assert.rejects(() => readGitSource({ root: item.repo, ref, manifest: item.manifest }));
  }
  // refs/heads/<pseudoref 이름>이 실제로 있어도 짧은 철자는 거부한다 — 명시할 때만 해석된다.
  execFileSync('git', ['-C', item.repo, 'update-ref', 'refs/heads/MERGE_HEAD', item.head], { stdio: 'ignore' });
  await assert.rejects(() => readGitSource({ root: item.repo, ref: 'MERGE_HEAD', manifest: item.manifest }));
  const qualifiedPseudo = await readGitSource({ root: item.repo, ref: 'refs/heads/MERGE_HEAD', manifest: item.manifest });
  assert.equal(qualifiedPseudo.commit, item.head);
  // 저장소 안의 일반 하위 디렉터리는 root로 받지 않는다 — worktree top만 허용한다.
  await assert.rejects(() => readGitSource({ root: join(item.repo, 'docs'), ref: item.head, manifest: item.manifest }));
});

test('git connector rejects symlink entries, non-repositories and unsafe refs', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  symlinkSync('guide.md', join(item.repo, 'docs', 'link.md'));
  const linked = commit(item.repo, 'link');
  const linkManifest: MarkdownSourceManifest = { version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/link.md', policy_id: 'policy-v1', policy_version: 1, title: '링크' }] };
  await assert.rejects(() => readGitSource({ root: item.repo, ref: linked, manifest: linkManifest }), /일반 파일|읽을 수 없습니다/);
  const plain = join(item.root, 'plain');
  mkdirSync(plain);
  await assert.rejects(() => readGitSource({ root: plain, ref: 'HEAD', manifest: item.manifest }));
  for (const ref of ['--all', '-f', 'HEAD@{0}', 'HEAD..HEAD~1', 'a/b/', '.hidden', 'a//b', 'a.lock/b']) {
    await assert.rejects(() => readGitSource({ root: item.repo, ref, manifest: item.manifest }));
  }
});

test('git connector ignores replace objects and inherited GIT_* variables', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  // refs/replace/* 치환이 커밋 고정을 우회하지 못한다 — 고정 커밋의 원본 내용만 읽는다.
  const second = execFileSync('git', ['-C', item.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', item.repo, 'replace', second, item.head], { stdio: 'ignore' });
  const replaced = await readGitSource({ root: item.repo, ref: second, manifest: item.manifest });
  assert.equal(replaced.commit, second);
  assert.equal(replaced.files[0].content_base64, Buffer.from('# 가이드 v2\n', 'utf8').toString('base64'));
  // 주입된 GIT_DIR/GIT_WORK_TREE가 검증된 root 밖의 저장소로 읽기를 돌리지 못한다.
  const foreign = join(item.root, 'foreign');
  mkdirSync(foreign);
  execFileSync('git', ['-C', foreign, 'init', '-q'], { stdio: 'ignore' });
  const previous = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(foreign, '.git');
  process.env.GIT_WORK_TREE = foreign;
  t.after(() => {
    if (previous.GIT_DIR === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous.GIT_DIR;
    if (previous.GIT_WORK_TREE === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous.GIT_WORK_TREE;
  });
  const isolated = await readGitSource({ root: item.repo, ref: item.head, manifest: item.manifest });
  assert.equal(isolated.commit, item.head);
  assert.equal(isolated.files[0].content_base64, item.content.toString('base64'));
});

test('git connector reads SHA-256 object-format repositories', { skip: !gitAvailable }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-git-sha256-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  try {
    execFileSync('git', ['-C', repo, 'init', '-q', '--object-format=sha256'], { stdio: 'ignore' });
  } catch {
    t.skip('git does not support sha256 object format');
    return;
  }
  const content = Buffer.from('# sha256 문서\n', 'utf8');
  writeFileSync(join(repo, 'docs', 'guide.md'), content);
  const head = commit(repo, 'sha256');
  assert.equal(head.length, 64);
  const manifest: MarkdownSourceManifest = { version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/guide.md', policy_id: 'policy-v1', policy_version: 1, title: '가이드' }] };
  const snapshot = await readGitSource({ root: repo, ref: head, manifest });
  assert.equal(snapshot.commit, head);
  assert.equal(snapshot.files[0].content_base64, content.toString('base64'));
});

test('git connector enforces markdown decoding and manifest validation', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  writeFileSync(join(item.repo, 'docs', 'binary.md'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const head = commit(item.repo, 'binary');
  const binaryManifest: MarkdownSourceManifest = { version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/binary.md', policy_id: 'policy-v1', policy_version: 1, title: '바이너리' }] };
  await assert.rejects(() => readGitSource({ root: item.repo, ref: head, manifest: binaryManifest }));
  await assert.rejects(() => readGitSource({ root: item.repo, ref: head, manifest: { version: 2 } as any }));
});
