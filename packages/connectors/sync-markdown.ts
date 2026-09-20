import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalize } from '../domain/index.ts';
import { decodeMarkdownImport } from '../import/markdown.ts';
import { validateSourceState } from './source-store.ts';
import { MAX_SOURCE_BYTES, MAX_SOURCE_FILES, sourceId, sourceMapping, sourcePath, validateSourceManifest } from './source-contract.ts';
import type { MarkdownSourceManifest, SourceFileMapping, SourceState } from './source-contract.ts';
import type { MarkdownSourceSnapshot } from './filesystem-markdown.ts';

export interface SyncClient {
  request<T = unknown>(path: string, options: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T>;
}

export interface SyncCounts { imported: number; unchanged: number; skipped: number; removed: number }

export interface SyncMarkdownResult {
  source: SourceState;
  counts: SyncCounts;
}
export interface SyncMarkdownOptions { retries?: number }
export interface MarkdownSyncPlan {
  source_id: string; expected_version: number;
  added: string[]; changed: string[]; restored: string[]; unchanged: string[]; removed: string[];
}

export class MarkdownSyncError extends Error {
  readonly code = 'INVALID_SOURCE';
  constructor() { super('원본 동기화 응답이 올바르지 않습니다.'); this.name = 'MarkdownSyncError'; }
}

function operationId(kind: string, source: string, body: unknown): string {
  return `sync-${createHash('sha256').update(canonicalize({ kind, source, body })).digest('hex').slice(0, 48)}`;
}

function sameMapping(entry: any, mapping: SourceFileMapping): boolean {
  return entry.path === mapping.path && entry.policy_id === mapping.policy_id && entry.policy_version === mapping.policy_version && entry.title === mapping.title;
}

function validSnapshot(snapshot: MarkdownSourceSnapshot): { manifest: MarkdownSourceManifest; files: MarkdownSourceSnapshot['files'] } {
  const manifest = validateSourceManifest(snapshot?.manifest);
  if (!snapshot || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.missing_paths) || snapshot.files.length > MAX_SOURCE_FILES
    || snapshot.missing_paths.some(path => typeof path !== 'string') || new Set(snapshot.missing_paths).size !== snapshot.missing_paths.length) throw new MarkdownSyncError();
  const manifestPaths = new Set(manifest.files.map(file => file.path));
  const files = snapshot.files.map(file => {
    if (!file || Object.keys(file).sort().join(',') !== 'byte_length,content_base64,mapping,sha256') throw new MarkdownSyncError();
    const mapping = sourceMapping(file.mapping);
    if (!manifestPaths.has(mapping.path) || !sameMapping(manifest.files.find(entry=>entry.path===mapping.path),mapping) || typeof file.content_base64 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || !Number.isSafeInteger(file.byte_length) || file.byte_length < 1 || file.byte_length > 256 * 1024) throw new MarkdownSyncError();
    let decoded;
    try { decoded = decodeMarkdownImport(mapping.path.split('/').at(-1), file.content_base64); } catch { throw new MarkdownSyncError(); }
    if (decoded.byteLength !== file.byte_length || decoded.sha256 !== file.sha256) throw new MarkdownSyncError();
    return { ...file, mapping };
  });
  if (new Set(files.map(file => file.mapping.path)).size !== files.length || files.some(file => !manifestPaths.has(file.mapping.path))
    || files.some(file => snapshot.missing_paths.includes(file.mapping.path)) || files.reduce((sum, file) => sum + file.byte_length, 0) > MAX_SOURCE_BYTES
    || snapshot.missing_paths.some(path => !manifestPaths.has(path) || files.some(file => file.mapping.path === path))) throw new MarkdownSyncError();
  if(files.length+snapshot.missing_paths.length!==manifest.files.length)throw new MarkdownSyncError();
  return { manifest, files };
}

function stateFrom(value: unknown, source: string): SourceState {
  try { return validateSourceState(value, source); } catch { throw new MarkdownSyncError(); }
}

function importResult(value: unknown, source: string, mapping: SourceFileMapping): { status: 'imported' | 'unchanged'; source: SourceState } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarkdownSyncError();
  const result = value as Record<string, any>;
  if ((result.status !== 'imported' && result.status !== 'unchanged') || typeof result.draft_id !== 'string') throw new MarkdownSyncError();
  const state = stateFrom(result.source, source);
  const entry = state.entries.find(item => item.path === mapping.path && item.status === 'present');
  if (!entry || entry.draft_id !== result.draft_id || !sameMapping(entry, mapping)) throw new MarkdownSyncError();
  return { status: result.status, source: state };
}

function reconcileResult(value: unknown, source: string): { source: SourceState; removed: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MarkdownSyncError();
  const result = value as Record<string, any>;
  if (result.status !== 'reconciled' || !Number.isSafeInteger(result.removed_count) || result.removed_count < 0) throw new MarkdownSyncError();
  return { source: stateFrom(result.source, source), removed: result.removed_count };
}

/** A read-only change preview. The subsequent sync reads state again and still uses CAS. */
export async function planMarkdownSync(client: SyncClient, input: MarkdownSourceSnapshot): Promise<MarkdownSyncPlan> {
  const snapshot = validSnapshot(input); const source = sourceId(snapshot.manifest.source_id);
  let state: SourceState | undefined;
  try { state = stateFrom(await client.request(`/sources/${source}`, {}), source); }
  catch (error: any) { if (error?.status !== 404) throw error; }
  const plan: MarkdownSyncPlan = { source_id: source, expected_version: state?.version ?? 0, added: [], changed: [], restored: [], unchanged: [], removed: [] };
  const paths = new Set(snapshot.files.map(file => file.mapping.path));
  for (const file of snapshot.files) {
    const current = state?.entries.find(entry => entry.path === file.mapping.path);
    const kind = !current ? 'added' : current.status === 'removed' ? 'restored' : current.sha256 === file.sha256 && sameMapping(current, file.mapping) ? 'unchanged' : 'changed';
    plan[kind].push(file.mapping.path);
  }
  plan.removed = (state?.entries ?? []).filter(entry => entry.status === 'present' && !paths.has(entry.path)).map(entry => entry.path);
  return plan;
}

/** Opt-in retries preserve exact request IDs, versions and bytes. Authorization and CAS errors stop immediately. */
function retryClient(client: SyncClient, options: SyncMarkdownOptions): SyncClient {
  const retries = options.retries ?? 0;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 3) throw new MarkdownSyncError();
  return { request: async <T>(path: string, request: { method?: 'GET' | 'POST'; body?: unknown }): Promise<T> => {
    const original = structuredClone(request);
    for (let attempt = 0; ; attempt++) {
      try { return await client.request<T>(path, structuredClone(original)); }
      catch (error: any) {
        const transient = error?.retryable === true && (['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) || [429, 500, 502, 503, 504].includes(error.status));
        if (attempt >= retries || !transient) throw error;
        await delay(100 * 2 ** attempt);
      }
    }
  } };
}

export async function syncMarkdownSource(originalClient: SyncClient, input: MarkdownSourceSnapshot, options: SyncMarkdownOptions = {}): Promise<SyncMarkdownResult> {
  const client = retryClient(originalClient, options);
  const snapshot = validSnapshot(input);
  const source = sourceId(snapshot.manifest.source_id);
  let state: SourceState | undefined;
  try { state = stateFrom(await client.request(`/sources/${source}`, {}), source); }
  catch (error: any) {
    if (error?.status !== 404) throw error;
  }
  const snapshotPaths = new Set(snapshot.files.map(file => file.mapping.path));
  const counts: SyncCounts = { imported: 0, unchanged: 0, skipped: 0, removed: 0 };
  if (state) {
    const retain = state.entries.filter(entry => entry.status === 'present' && snapshotPaths.has(entry.path)).map(entry => entry.path);
    const stale = state.entries.some(entry => entry.status === 'present' && !snapshotPaths.has(entry.path));
    if (stale) {
      const body = { operation_id: operationId('reconcile', source, { expected_version: state.version, present_paths: retain }), expected_version: state.version, present_paths: retain };
      const reconciled = reconcileResult(await client.request(`/sources/${source}/reconcile`, { method: 'POST', body }), source);
      state = reconciled.source; counts.removed += reconciled.removed;
    }
  }
  for (const file of snapshot.files) {
    const current = state?.entries.find(entry => entry.path === file.mapping.path);
    if (current?.status === 'present' && current.sha256 === file.sha256 && sameMapping(current, file.mapping)) { counts.skipped += 1; continue; }
    const body = { operation_id: operationId('markdown', source, { mapping: file.mapping, content_base64: file.content_base64, expected_version: state?.version ?? 0 }), expected_version: state?.version ?? 0, path: file.mapping.path, policy_id: file.mapping.policy_id, policy_version: file.mapping.policy_version, title: file.mapping.title, content_base64: file.content_base64 };
    const imported = importResult(await client.request(`/sources/${source}/markdown`, { method: 'POST', body }), source, file.mapping);
    state = imported.source;
    counts[imported.status] += 1;
  }
  const expectedVersion = state?.version ?? 0;
  const finalBody = { operation_id: operationId('reconcile', source, { expected_version: expectedVersion, present_paths: [...snapshotPaths] }), expected_version: expectedVersion, present_paths: [...snapshotPaths] };
  const final = reconcileResult(await client.request(`/sources/${source}/reconcile`, { method: 'POST', body: finalBody }), source);
  counts.removed += final.removed;
  return { source: final.source, counts };
}
