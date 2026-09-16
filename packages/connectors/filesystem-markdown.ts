import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { decodeMarkdownImport, MAX_MARKDOWN_BYTES } from '../import/markdown.ts';
import { parseStrictJson } from '../fabric/canonical.ts';
import {
  MAX_SOURCE_BYTES,
  SourceInputError,
  sourcePath,
  validateSourceManifest,
} from './source-contract.ts';
import type { MarkdownSourceManifest, SourceFileMapping } from './source-contract.ts';

const MAX_MANIFEST_BYTES = 128 * 1024;

export interface MarkdownSourceFile {
  mapping: SourceFileMapping;
  content_base64: string;
  sha256: string;
  byte_length: number;
}

export interface MarkdownSourceSnapshot {
  manifest: MarkdownSourceManifest;
  files: MarkdownSourceFile[];
  missing_paths: string[];
}

function invalid(message = '원본 Markdown 파일을 읽을 수 없습니다.'): never {
  throw new SourceInputError(message);
}

function absolutePath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) invalid();
  return resolve(value);
}

function fileStatChanged(before: any, after: any): boolean {
  return !after || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode
    || before.nlink !== after.nlink || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs;
}

function assertSafeComponents(path: string, allowMissingLeaf: boolean, anchor?: string): boolean {
  const absolute = resolve(path);
  if (!anchor) {
    let leaf: any;
    try { leaf = lstatSync(absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf) return false;
      invalid();
    }
    if (leaf.isSymbolicLink() || absolute.split(sep).at(-1)?.startsWith('.')) invalid();
    return true;
  }
  const base = resolve(anchor);
  const relativePath = relative(base, absolute);
  if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) invalid();
  let baseStat: any;
  try { baseStat = lstatSync(base); } catch { invalid(); }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory() || base.split(sep).at(-1)?.startsWith('.')) invalid();
  const parts = relativePath.split(sep).filter(Boolean);
  let current = base;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]);
    let stat: any;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingLeaf) return false;
      invalid();
    }
    if (stat.isSymbolicLink()) invalid();
    if (index < parts.length - 1 && !stat.isDirectory()) invalid();
    if (parts[index].startsWith('.')) invalid();
  }
  return true;
}

function readRegularSnapshot(path: string, maxBytes: number, anchor?: string, anchorBefore?: any): Buffer | undefined {
  const absolute = absolutePath(path);
  if (!anchor) {
    let parent: any;
    try { parent = lstatSync(dirname(absolute)); } catch { invalid(); }
    if (parent.isSymbolicLink() || !parent.isDirectory()) invalid();
  }
  if (!assertSafeComponents(absolute, true, anchor)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink > 1 || before.size > maxBytes) invalid();
    const bytes = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(fd, bytes, offset, before.size - offset, offset);
      if (count <= 0) invalid();
      offset += count;
    }
    const after = fstatSync(fd);
    let finalPathStat: any;
    try { finalPathStat = lstatSync(absolute); } catch { invalid(); }
    let anchorAfter: any;
    if (anchor) {
      try { anchorAfter = lstatSync(resolve(anchor)); } catch { invalid(); }
    }
    if (!finalPathStat.isFile() || finalPathStat.isSymbolicLink() || finalPathStat.nlink > 1
      || fileStatChanged(before, after) || fileStatChanged(after, finalPathStat) || (anchorBefore && fileStatChanged(anchorBefore, anchorAfter))
      || !assertSafeComponents(absolute, false, anchor)) invalid();
    return bytes;
  } catch (error) {
    if (error instanceof SourceInputError) throw error;
    invalid();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function decodeMarkdown(bytes: Buffer): void {
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) invalid();
  try {
    // Reuse the intake decoder so UTF-8, BOM, CRLF, and binary-control rules
    // remain identical between direct import and filesystem intake.
    decodeMarkdownImport('source.md', bytes.toString('base64'));
  } catch { invalid(); }
}

export function loadMarkdownSourceManifest(path: string): MarkdownSourceManifest {
  const bytes = readRegularSnapshot(path, MAX_MANIFEST_BYTES);
  if (!bytes) invalid();
  try { return validateSourceManifest(parseStrictJson(bytes)); }
  catch { invalid('원본 manifest 형식이 올바르지 않습니다.'); }
}

export async function readMarkdownSource(input: { root: string; manifest: MarkdownSourceManifest }): Promise<MarkdownSourceSnapshot> {
  const root = absolutePath(input?.root);
  let rootStat: any;
  try { rootStat = lstatSync(root); } catch { invalid(); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || root.split(sep).at(-1)?.startsWith('.')) invalid();
  const manifest = validateSourceManifest(input?.manifest);
  const files: MarkdownSourceFile[] = [];
  const missingPaths: string[] = [];
  let totalBytes = 0;
  for (const mapping of manifest.files) {
    const safePath = sourcePath(mapping.path);
    const path = resolve(join(root, safePath));
    const relativePath = relative(root, path);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) invalid();
    const bytes = readRegularSnapshot(path, MAX_MARKDOWN_BYTES, root, rootStat);
    if (!bytes) { missingPaths.push(safePath); continue; }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SOURCE_BYTES) invalid('원본 Markdown 전체 크기가 제한을 초과했습니다.');
    decodeMarkdown(bytes);
    files.push({ mapping, content_base64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.byteLength });
  }
  return { manifest, files, missing_paths: missingPaths };
}
