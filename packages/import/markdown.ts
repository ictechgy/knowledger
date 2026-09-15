import { createHash } from 'node:crypto';

export const MAX_MARKDOWN_BYTES = 256 * 1024;
export const MAX_FILENAME_BYTES = 255;
const MAX_BASE64_CHARS = Math.ceil(MAX_MARKDOWN_BYTES / 3) * 4;

export interface DecodedMarkdownImport {
  filename: string;
  content: string;
  byteLength: number;
  sha256: string;
}

export class MarkdownImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MarkdownImportError';
    this.code = code;
  }
}

function invalid(message: string): never {
  throw new MarkdownImportError('INVALID_INPUT', message);
}

function hasControlCharacters(value: string): boolean {
  // Markdown may contain tab, LF, and CR. Other C0/C1 controls and DEL are
  // treated as binary data so they cannot be smuggled into a document body.
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value);
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BASE64_CHARS || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    invalid('content_base64는 패딩된 표준 Base64여야 합니다.');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0) invalid('Markdown 본문은 비어 있을 수 없습니다.');
  if (bytes.toString('base64') !== value) invalid('content_base64는 표준 Base64 정규형이어야 합니다.');
  if (bytes.length > MAX_MARKDOWN_BYTES) invalid('Markdown 본문은 256 KiB 이하여야 합니다.');
  return bytes;
}

export function validateMarkdownFilename(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > MAX_FILENAME_BYTES || value.includes('/') || value.includes('\\') || /[\u0000-\u001F\u007F-\u009F]/u.test(value) || !/\.(?:md|markdown)$/iu.test(value)) {
    invalid('파일명은 경로가 아닌 .md 또는 .markdown 파일이어야 합니다.');
  }
  return value;
}

export function decodeMarkdownImport(filename: unknown, contentBase64: unknown): DecodedMarkdownImport {
  const safeFilename = validateMarkdownFilename(filename);
  const bytes = decodeCanonicalBase64(contentBase64);
  let content: string;
  try {
    // ignoreBOM=true preserves a valid UTF-8 BOM as U+FEFF in the revision.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    invalid('Markdown 본문은 올바른 UTF-8이어야 합니다.');
  }
  if (content.length === 0 || hasControlCharacters(content)) invalid('Markdown 본문에 허용되지 않은 제어 문자가 있습니다.');
  return {
    filename: safeFilename,
    content,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
