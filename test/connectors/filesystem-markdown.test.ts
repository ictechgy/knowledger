import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadMarkdownSourceManifest, readMarkdownSource } from '../../packages/connectors/filesystem-markdown.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'kcl-filesystem-source-test-'));
  const source = join(root, 'source');
  mkdirSync(join(source, 'docs'), { recursive: true });
  const content = Buffer.from('\uFEFF# 계약\r\n\r\n원문\r\n', 'utf8');
  writeFileSync(join(source, 'docs', 'contract.md'), content, { mode: 0o600 });
  writeFileSync(join(root, 'source-manifest.json'), JSON.stringify({ version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/contract.md', policy_id: 'policy-sales-v1', policy_version: 1, title: '계약 원문' }, { path: 'docs/missing.md', policy_id: 'policy-sales-v1', policy_version: 1, title: '누락 원문' }] }), { mode: 0o600 });
  return { root, source, manifestPath: join(root, 'source-manifest.json'), content };
}

test('loads only a strict manifest and reads listed Markdown snapshots with exact bytes', async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const manifest = loadMarkdownSourceManifest(item.manifestPath);
  const snapshot = await readMarkdownSource({ root: item.source, manifest });
  assert.equal(snapshot.files.length, 1);
  assert.deepEqual(snapshot.files[0].mapping, manifest.files[0]);
  assert.equal(snapshot.files[0].content_base64, item.content.toString('base64'));
  assert.equal(snapshot.files[0].byte_length, item.content.byteLength);
  assert.equal(snapshot.files[0].sha256, createHash('sha256').update(item.content).digest('hex'));
  assert.deepEqual(snapshot.missing_paths, ['docs/missing.md']);
  rmSync(join(item.source, 'docs'), { recursive: true, force: true });
  const afterDirectoryRemoval = await readMarkdownSource({ root: item.source, manifest });
  assert.deepEqual(afterDirectoryRemoval.missing_paths, ['docs/contract.md', 'docs/missing.md']);
});

test('rejects traversal, hidden paths, symlinks, hardlinks, non-files, oversized files, and unsafe errors', async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const badManifest = (path: string) => ({ version: 1, source_id: 'kb-source-001', files: [{ path, policy_id: 'policy-sales-v1', policy_version: 1, title: 'bad' }] });
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('../outside.md') as any }));
  writeFileSync(join(item.root, 'outside.md'), 'CANARY', { mode: 0o600 });
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('../outside.md') as any }));
  symlinkSync(join(item.source, 'docs'), join(item.source, 'linked-dir'));
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('linked-dir/contract.md') as any }));
  symlinkSync(item.source, join(item.root, 'root-link'));
  await assert.rejects(() => readMarkdownSource({ root: join(item.root, 'root-link'), manifest: badManifest('docs/contract.md') as any }));
  symlinkSync(join(item.source, 'docs', 'contract.md'), join(item.source, 'docs', 'linked.md'));
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('docs/linked.md') as any }));
  linkSync(join(item.source, 'docs', 'contract.md'), join(item.source, 'docs', 'hard.md'));
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('docs/hard.md') as any }));
  mkdirSync(join(item.source, 'docs', 'directory.md'));
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('docs/directory.md') as any }));
  writeFileSync(join(item.source, 'docs', 'large.md'), Buffer.alloc(256 * 1024 + 1, 0x61), { mode: 0o600 });
  await assert.rejects(() => readMarkdownSource({ root: item.source, manifest: badManifest('docs/large.md') as any }), error => {
    assert.equal(String((error as Error).message).includes('large.md'), false);
    return true;
  });
});

test('does not read manifest references, rejects malformed JSON and bounded aggregate input', async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const noSource = join(item.root, 'no-source.json');
  writeFileSync(noSource, JSON.stringify({ version: 1, source_id: 'kb-source-001', files: [{ path: 'docs/not-present.md', policy_id: 'policy-sales-v1', policy_version: 1, title: 'no source read' }] }), { mode: 0o600 });
  assert.doesNotThrow(() => loadMarkdownSourceManifest(noSource));
  symlinkSync(item.root, join(item.root, 'manifest-link'));
  assert.throws(() => loadMarkdownSourceManifest(join(item.root, 'manifest-link', 'source-manifest.json')));
  writeFileSync(noSource, '{"version":1,"version":1,"source_id":"kb-source-001","files":[]}');
  assert.throws(() => loadMarkdownSourceManifest(noSource));
  writeFileSync(noSource, 'x'.repeat(128 * 1024 + 1));
  assert.throws(() => loadMarkdownSourceManifest(noSource));
  chmodSync(noSource, 0o600);
});

test('enforces the aggregate source byte limit after per-file bounds', async t => {
  const root = mkdtempSync(join(tmpdir(), 'kcl-filesystem-source-total-test-'));
  const source = join(root, 'source');
  mkdirSync(source, { recursive: true });
  const files = Array.from({ length: 65 }, (_, index) => {
    const path = `file-${index}.md`;
    writeFileSync(join(source, path), Buffer.alloc(256 * 1024, 0x61), { mode: 0o600 });
    return { path, policy_id: 'policy-sales-v1', policy_version: 1, title: `file ${index}` };
  });
  try {
    await assert.rejects(() => readMarkdownSource({ root: source, manifest: { version: 1, source_id: 'kb-source-total', files } }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a leaf replacement observed after the fd snapshot', async t => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const path = join(item.source, 'docs', 'contract.md');
  const manifest = { version: 1 as const, source_id: 'kb-source-race', files: [{ path: 'docs/contract.md', policy_id: 'policy-sales-v1', policy_version: 1, title: 'race' }] };
  const originalReadSync = fs.readSync;
  let replaced = false;
  (fs as any).readSync = (...args: any[]) => {
    const result = originalReadSync(...args);
    if (!replaced) {
      replaced = true;
      renameSync(path, `${path}.old`);
      writeFileSync(path, item.content, { mode: 0o600 });
    }
    return result;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => readMarkdownSource({ root: item.source, manifest }));
  } finally {
    (fs as any).readSync = originalReadSync;
    syncBuiltinESMExports();
  }
});
