import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonicalize } from '../domain/index.ts';
import { parseStrictJson } from '../fabric/canonical.ts';
import { boundedJson } from '../http/bounded-json.ts';
import { confluenceAdfToMarkdown } from './confluence-adf.ts';
import { ConfluenceOAuthError } from './confluence-oauth.ts';
import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES, SourceInputError, confluenceOrigin, sourceId, sourceMapping } from './source-contract.ts';
import type { ConfluenceOrigin, SourceState } from './source-contract.ts';
import type { MarkdownSourceFile, MarkdownSourceSnapshot } from './filesystem-markdown.ts';
import type { SyncClient, SyncMarkdownResult } from './sync-markdown.ts';
import { validateSourceState } from './source-store.ts';

export class ConfluenceError extends Error {
  readonly code: string; readonly status: number; readonly retryable: boolean;
  constructor(code: string, status = 400, retryable = false) { super('Confluence 원본의 접근 권한, 버전 또는 본문 형식을 확인할 수 없습니다.'); this.code = code; this.status = status; this.retryable = retryable; }
}
export interface ConfluencePageMapping { page_id: string; policy_id: string; policy_version: number }
export interface ConfluenceSourceOptions {
  source_id: string; cloud_id: string; pages: ConfluencePageMapping[];
  getAccessToken: (signal: AbortSignal) => string | Promise<string>;
  allows: (request: { cloud_id: string; page_id: string; phase: 'read' | 'verify'; signal: AbortSignal }) => boolean | Promise<boolean>;
  signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch;
}
export interface ConfluenceSourceSnapshot extends MarkdownSourceSnapshot {
  cloud_id: string; files: (MarkdownSourceFile & { origin: ConfluenceOrigin })[];
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function validateConfluenceSourceOptions(options: ConfluenceSourceOptions) {
  const id = sourceId(options.source_id); const cloud = options.cloud_id;
  if (typeof cloud !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(cloud)
    || !Array.isArray(options.pages) || options.pages.length > MAX_SOURCE_FILES || typeof options.getAccessToken !== 'function' || typeof options.allows !== 'function') throw new ConfluenceError('INVALID_CONFLUENCE_SOURCE');
  const pages = options.pages.map(page => {
    if (!page || Object.keys(page).sort().join(',') !== 'page_id,policy_id,policy_version' || typeof page.page_id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(page.page_id)) throw new ConfluenceError('INVALID_CONFLUENCE_SOURCE');
    sourceMapping({ path: `confluence/${page.page_id}.md`, title: 'Validation', policy_id: page.policy_id, policy_version: page.policy_version });
    return { ...page };
  });
  if (new Set(pages.map(page => page.page_id)).size !== pages.length) throw new ConfluenceError('INVALID_CONFLUENCE_SOURCE');
  const timeout = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120000) throw new ConfluenceError('INVALID_CONFLUENCE_SOURCE');
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new ConfluenceError('INVALID_CONFLUENCE_SOURCE');
  return { id, cloud, pages, timeout };
}

/** Explicit allowlist only. Credentials belong to the caller's delegated account. No discovery or link fetch. */
export async function readConfluenceSource(options: ConfluenceSourceOptions): Promise<ConfluenceSourceSnapshot> {
  const { id, cloud, pages, timeout } = validateConfluenceSourceOptions(options);
  const fetchImpl = options.fetch ?? fetch; const allows = options.allows; const getToken = options.getAccessToken;
  const controller = new AbortController(); const deadline = performance.now() + timeout; let expired = false;
  const check = () => { if (expired || performance.now() >= deadline) throw new ConfluenceError('CONFLUENCE_TIMEOUT', 503, true); if (controller.signal.aborted) throw new ConfluenceError('CONFLUENCE_ABORTED', 503, true); };
  const abort = () => controller.abort(); let reject!: (error: ConfluenceError) => void;
  const cancelled = new Promise<never>((_, fail) => { reject = fail; });
  const onAbort = () => reject(new ConfluenceError(expired ? 'CONFLUENCE_TIMEOUT' : 'CONFLUENCE_ABORTED', 503, true));
  controller.signal.addEventListener('abort', onAbort, { once: true }); options.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { expired = true; controller.abort(); }, timeout); if (options.signal?.aborted) controller.abort();
  const read = async (page: ConfluencePageMapping, phase: 'read' | 'verify') => {
    check();
    if (await allows({ cloud_id: cloud, page_id: page.page_id, phase, signal: controller.signal }) !== true) throw new ConfluenceError('CONFLUENCE_ACCESS_DENIED', 403);
    check(); const token = await getToken(controller.signal); check();
    if (typeof token !== 'string' || !/^[!-~]{1,8192}$/.test(token)) throw new ConfluenceError('CONFLUENCE_CREDENTIAL_UNAVAILABLE', 503);
    if (await allows({ cloud_id: cloud, page_id: page.page_id, phase, signal: controller.signal }) !== true) throw new ConfluenceError('CONFLUENCE_ACCESS_DENIED', 403); check();
    const url = `https://api.atlassian.com/ex/confluence/${cloud}/wiki/api/v2/pages/${page.page_id}?body-format=atlas_doc_format`;
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    try { check(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ConfluenceError([401, 403, 404].includes(response.status) ? 'CONFLUENCE_NOT_ACCESSIBLE' : 'CONFLUENCE_UNAVAILABLE',
        [401, 403, 404].includes(response.status) ? 403 : 503, response.status === 429 || response.status >= 500);
    }
    let value: any;
    try { value = await boundedJson(response, 1024 * 1024, controller.signal); }
    catch { check(); throw new ConfluenceError('INVALID_CONFLUENCE_RESPONSE', 502); }
    check();
    if (await allows({ cloud_id: cloud, page_id: page.page_id, phase, signal: controller.signal }) !== true) throw new ConfluenceError('CONFLUENCE_ACCESS_DENIED', 403); check();
    if (value?.id !== page.page_id || value.status !== 'current' || typeof value.body?.atlas_doc_format?.value !== 'string'
      || (value.body.atlas_doc_format.representation !== undefined && value.body.atlas_doc_format.representation !== 'atlas_doc_format')) throw new ConfluenceError('INVALID_CONFLUENCE_PAGE');
    const mapping = sourceMapping({ path: `confluence/${page.page_id}.md`, title: value.title, policy_id: page.policy_id, policy_version: page.policy_version });
    if (/[\uD800-\uDFFF]/u.test(mapping.title) || /[\u007f-\u009f]/u.test(mapping.title)) throw new ConfluenceError('INVALID_CONFLUENCE_PAGE', 502);
    let content: string; let adfDigest: string;
    try { const adf = parseStrictJson(Buffer.from(value.body.atlas_doc_format.value, 'utf8')); content = confluenceAdfToMarkdown(adf); adfDigest = hash(canonicalize(adf)); }
    catch { throw new ConfluenceError('CONFLUENCE_UNSUPPORTED_CONTENT', 422); }
    const origin = confluenceOrigin({ kind: 'confluence', cloud_id: cloud, page_id: page.page_id, page_version: value.version?.number, adf_sha256: adfDigest });
    return { mapping, origin, content_base64: Buffer.from(content).toString('base64'), sha256: hash(content), byte_length: Buffer.byteLength(content) };
  };
  const collect = async () => {
    const files: ConfluenceSourceSnapshot['files'] = []; let bytes = 0;
    for (const page of pages) { const file = await read(page, 'read'); bytes += file.byte_length; if (bytes > MAX_SOURCE_BYTES) throw new ConfluenceError('CONFLUENCE_SOURCE_TOO_LARGE', 413); files.push(file); }
    for (let i = 0; i < pages.length; i++) {
      const current = await read(pages[i], 'verify'); check();
      if (canonicalize(current) !== canonicalize(files[i])) throw new ConfluenceError('CONFLUENCE_SOURCE_CHANGED', 409);
    }
    check();
    return { cloud_id: cloud, manifest: { version: 1 as const, source_id: id, files: files.map(file => file.mapping) }, files, missing_paths: [] };
  };
  try { return await Promise.race([collect(), cancelled]); }
  catch (error) { if (error instanceof ConfluenceError) throw error; check(); if (error instanceof ConfluenceOAuthError) throw new ConfluenceError(error.code, 503); if (error instanceof SourceInputError) throw new ConfluenceError('INVALID_CONFLUENCE_PAGE', 502); throw new ConfluenceError('CONFLUENCE_UNAVAILABLE', 503, true); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); controller.abort(); }
}

/** Fetch/recheck the whole source before the first private write. No publication or approval. */
export async function syncConfluenceSource(client: SyncClient, options: ConfluenceSourceOptions): Promise<SyncMarkdownResult> {
  const snapshot = await readConfluenceSource(options); const id = snapshot.manifest.source_id;
  const check = () => { if (options.signal?.aborted) throw new ConfluenceError('CONFLUENCE_ABORTED', 503, true); };
  let state: SourceState | undefined;
  check();
  try { state = validateSourceState(await client.request(`/sources/${id}`, {}), id); }
  catch (error: any) { if (error?.status !== 404) throw error; }
  if (state?.entries.some(entry => !entry.origin || entry.origin.cloud_id !== snapshot.cloud_id)) throw new ConfluenceError('SOURCE_ORIGIN_CONFLICT', 409);
  for (const file of snapshot.files) {
    const old = state?.entries.find(entry => entry.path === file.mapping.path)?.origin;
    if (old && (file.origin.page_version < old.page_version || file.origin.page_version === old.page_version && file.origin.adf_sha256 !== old.adf_sha256)) throw new ConfluenceError('CONFLUENCE_VERSION_CONFLICT', 409);
  }
  const counts = { imported: 0, unchanged: 0, skipped: 0, removed: 0 };
  const paths = new Set(snapshot.files.map(file => file.mapping.path));
  const reconcile = async (present: string[]) => {
    check(); const input = { expected_version: state?.version ?? 0, present_paths: present };
    const result: any = await client.request(`/sources/${id}/reconcile`, { method: 'POST', body: { ...input, operation_id: `confluence-${hash(canonicalize({ id, ...input })).slice(0, 48)}` } });
    if (result?.status !== 'reconciled' || !Number.isSafeInteger(result.removed_count) || result.removed_count < 0) throw new ConfluenceError('INVALID_SOURCE_RESPONSE', 502);
    const next = validateSourceState(result.source, id);
    if (next.version < input.expected_version || next.version > input.expected_version + 1
      || canonicalize(next.entries.filter(entry => entry.status === 'present').map(entry => entry.path).sort()) !== canonicalize([...present].sort())
      || next.entries.some(entry => !entry.origin || entry.origin.cloud_id !== snapshot.cloud_id)) throw new ConfluenceError('INVALID_SOURCE_RESPONSE', 502);
    state = next; counts.removed += result.removed_count;
  };
  if (state?.entries.some(entry => entry.status === 'present' && !paths.has(entry.path))) await reconcile(state.entries.filter(entry => entry.status === 'present' && paths.has(entry.path)).map(entry => entry.path));
  for (const file of snapshot.files) {
    check(); const before = state?.entries.find(entry => entry.path === file.mapping.path);
    if (before?.status === 'present' && before.sha256 === file.sha256 && before.title === file.mapping.title && before.policy_id === file.mapping.policy_id
      && before.policy_version === file.mapping.policy_version && canonicalize(before.origin) === canonicalize(file.origin)) { counts.skipped++; continue; }
    const input = { expected_version: state?.version ?? 0, ...file.mapping, content_base64: file.content_base64, origin: file.origin };
    const result: any = await client.request(`/sources/${id}/confluence`, { method: 'POST', body: { ...input, operation_id: `confluence-${hash(canonicalize({ id, ...input })).slice(0, 48)}` } });
    if (!['imported', 'unchanged'].includes(result?.status)) throw new ConfluenceError('INVALID_SOURCE_RESPONSE', 502);
    const next = validateSourceState(result.source, id); const entry = next.entries.find(entry => entry.path === file.mapping.path && entry.status === 'present');
    if (next.version < input.expected_version || next.version > input.expected_version + 1 || result.status === 'imported' && next.version !== input.expected_version + 1
      || !entry || entry.draft_id !== result.draft_id || entry.sha256 !== file.sha256 || entry.byte_length !== file.byte_length || canonicalize(entry.origin) !== canonicalize(file.origin)
      || entry.policy_id !== file.mapping.policy_id || entry.policy_version !== file.mapping.policy_version || entry.title !== file.mapping.title) throw new ConfluenceError('INVALID_SOURCE_RESPONSE', 502);
    state = next; if (result.status === 'imported') counts.imported++; else counts.unchanged++;
  }
  await reconcile([...paths]); return { source: state!, counts };
}
