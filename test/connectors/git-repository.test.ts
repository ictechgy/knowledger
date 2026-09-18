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
  const headRef = await readGitSource({ root: item.repo, ref: 'HEAD', manifest: item.manifest });
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

test('git connector enforces markdown decoding and manifest validation', { skip: !gitAvailable }, async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  writeFileSync(join(item.repo, 'docs', 'binary.md'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
  const head = commit(item.repo, 'binary');
  const binaryManifest: MarkdownSourceManifest = { version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/binary.md', policy_id: 'policy-v1', policy_version: 1, title: '바이너리' }] };
  await assert.rejects(() => readGitSource({ root: item.repo, ref: head, manifest: binaryManifest }));
  await assert.rejects(() => readGitSource({ root: item.repo, ref: head, manifest: { version: 2 } as any }));
});
