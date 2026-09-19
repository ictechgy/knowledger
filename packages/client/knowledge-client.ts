import { digestPayload, validateRevision, canonicalize, MODEL_ADAPTER_ID } from '../domain/index.ts';
import { parseStrictJson } from '../fabric/canonical.ts';

const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const USAGE = /^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export interface ResolveSelection {
  document_ids: [string];
  context_id: string;
  scope_id: string;
  usage_scope: string;
  query?: string;
}

export interface KnowledgerClientOptions {
  baseUrl: string;
  workspaceId: string;
  fetch?: typeof fetch;
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal;
}

export interface RawResolveResponse {
  status: 'provided' | 'withheld' | string;
  mode?: string;
  documents?: any[];
  manifest?: any;
  checkpoint?: any;
  reason?: string;
  [key: string]: unknown;
}

export interface ValidatedResolveResponse extends RawResolveResponse {
  status: 'provided';
  revision: ReturnType<typeof validateRevision>;
  manifest: any;
  documents: any[];
}

export class KnowledgerClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(code: string, message: string, status?: number, retryable = false) {
    super(message); this.name = 'KnowledgerClientError'; this.code = code; this.status = status; this.retryable = retryable;
  }
}

export class KnowledgerPendingError extends KnowledgerClientError {
  constructor() { super('PENDING', '요청이 접수되었지만 VALID 커밋으로 확인되지 않았습니다.', 202, true); this.name = 'KnowledgerPendingError'; }
}

export class KnowledgerTimeoutError extends KnowledgerClientError {
  constructor() { super('TIMEOUT', 'Knowledger 요청 시간이 초과되었습니다.', undefined, true); this.name = 'KnowledgerTimeoutError'; }
}

function invalid(message = 'Knowledger 응답 또는 요청이 올바르지 않습니다.'): never {
  throw new KnowledgerClientError('INVALID_CLIENT_DATA', message);
}

function assertId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) invalid();
  return value;
}

function assertDigest(value: unknown): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) invalid();
  return value;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function assertAdapterId(value: unknown): string {
  if (typeof value !== 'string' || !MODEL_ADAPTER_ID.test(value)) invalid();
  return value;
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, any>;
}

function safeCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : undefined;
}

async function readBounded(response: Response, signal?: AbortSignal): Promise<Uint8Array> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new KnowledgerClientError('RESPONSE_TOO_LARGE', 'Knowledger 응답이 너무 큽니다.', response.status, true);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new KnowledgerClientError('RESPONSE_TOO_LARGE', 'Knowledger 응답이 너무 큽니다.', response.status, true);
    return bytes;
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  if (signal) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new KnowledgerClientError('RESPONSE_TOO_LARGE', 'Knowledger 응답이 너무 큽니다.', response.status, true); }
      chunks.push(next.value);
    }
  } finally { signal?.removeEventListener('abort', cancel); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function parseResponse(bytes: Uint8Array): any {
  try { return parseStrictJson(bytes); } catch { throw new KnowledgerClientError('INVALID_RESPONSE', 'Knowledger 응답 형식이 올바르지 않습니다.'); }
}

function validateSelection(input: ResolveSelection): ResolveSelection {
  const value = object(input);
  const keys = Object.keys(value);
  if (keys.some(key => !['document_ids', 'context_id', 'scope_id', 'usage_scope', 'query'].includes(key))) invalid();
  if (!Array.isArray(value.document_ids) || value.document_ids.length !== 1) invalid();
  const documentId = assertId(value.document_ids[0]);
  const contextId = assertId(value.context_id);
  const scopeId = assertId(value.scope_id);
  if (typeof value.usage_scope !== 'string' || !USAGE.test(value.usage_scope)) invalid();
  if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 1000)) invalid();
  return { document_ids: [documentId], context_id: contextId, scope_id: scopeId, usage_scope: value.usage_scope, ...(value.query === undefined ? {} : { query: value.query }) };
}

function validateCheckpoint(value: unknown): any {
  const checkpoint = object(value);
  if(Object.keys(checkpoint).some(key=>!['mode','checkpoint_id','channel_id','block_number','transaction_index','transaction_id','block_hash','eligibility_epoch'].includes(key)))invalid();
  if (checkpoint.mode !== 'strict' || typeof checkpoint.checkpoint_id !== 'string' || !ID.test(checkpoint.checkpoint_id) || typeof checkpoint.channel_id !== 'string' || !ID.test(checkpoint.channel_id)
    || !Number.isSafeInteger(checkpoint.block_number) || checkpoint.block_number < 0 || !Number.isSafeInteger(checkpoint.transaction_index) || checkpoint.transaction_index < 0
    || typeof checkpoint.transaction_id !== 'string' || !/^[0-9a-f]{64}$/u.test(checkpoint.transaction_id)
    || typeof checkpoint.block_hash !== 'string' || !/^[0-9a-f]{64}$/u.test(checkpoint.block_hash)
    || !Number.isSafeInteger(checkpoint.eligibility_epoch) || checkpoint.eligibility_epoch < 0) invalid();
  return checkpoint;
}

function validateManifest(value: unknown, selection: ResolveSelection, digest: string, agreementId: string): any {
  const manifest = object(value);
  const fields=['contract_type','contract_version','manifest_id','run_id','context_id','scope_id','usage_scope','policy_id','policy_version','membership_epoch','checkpoint','provided_revisions','approval_decisions','private_sources','retrieval_profile_id','authorization_snapshot_id','model_egress_policy_version'];
  if(Object.keys(manifest).some(key=>!fields.includes(key)))invalid();
  if (manifest.contract_type !== 'RunContextManifest' || manifest.contract_version !== 1 || typeof manifest.manifest_id !== 'string' || !ID.test(manifest.manifest_id) || typeof manifest.run_id !== 'string' || !ID.test(manifest.run_id)
    || manifest.context_id !== selection.context_id || manifest.scope_id !== selection.scope_id || manifest.usage_scope !== selection.usage_scope
    || typeof manifest.policy_id !== 'string' || !ID.test(manifest.policy_id) || !Number.isSafeInteger(manifest.policy_version) || manifest.policy_version < 1
    || !Number.isSafeInteger(manifest.membership_epoch) || manifest.membership_epoch < 1 || !Array.isArray(manifest.provided_revisions) || manifest.provided_revisions.length !== 1
    || !Array.isArray(manifest.approval_decisions) || manifest.approval_decisions.length===0 || manifest.approval_decisions.length>32 || !Array.isArray(manifest.private_sources) || manifest.private_sources.length !== 0 || typeof manifest.retrieval_profile_id !== 'string' || !ID.test(manifest.retrieval_profile_id)
    || typeof manifest.authorization_snapshot_id !== 'string' || !ID.test(manifest.authorization_snapshot_id) || !Number.isSafeInteger(manifest.model_egress_policy_version) || manifest.model_egress_policy_version < 1) invalid();
  const reference = object(manifest.provided_revisions[0]);
  if(Object.keys(reference).some(key=>!['revision_digest','purpose','reference_kind','target_context_id','target_scope_id','usage_scope','agreement_id'].includes(key)))invalid();
  if (reference.revision_digest !== digest || reference.reference_kind !== 'normative' || reference.target_context_id !== selection.context_id
    || reference.target_scope_id !== selection.scope_id || reference.usage_scope !== selection.usage_scope || reference.agreement_id !== agreementId
    || typeof reference.purpose !== 'string' || !ID.test(reference.purpose)) invalid();
  const decisionIds = new Set<string>();
  for (const decisionValue of manifest.approval_decisions) {
    const decision = object(decisionValue);
    if(Object.keys(decision).some(key=>!['decision_id','revision_digest','proposal_id'].includes(key)))invalid();
    if (typeof decision.decision_id !== 'string' || !ID.test(decision.decision_id) || typeof decision.revision_digest !== 'string' || !DIGEST.test(decision.revision_digest)
      || typeof decision.proposal_id !== 'string' || !ID.test(decision.proposal_id) || decision.revision_digest !== digest || decisionIds.has(decision.decision_id)) invalid();
    decisionIds.add(decision.decision_id);
  }
  if(new Set(manifest.approval_decisions.map((decision:any)=>decision.proposal_id)).size!==1)invalid();
  validateCheckpoint(manifest.checkpoint);
  return manifest;
}

function validateSharedCheckpoint(raw: unknown, manifest: any): void {
  const checkpoint = object(raw);
  const expected = manifest.checkpoint;
  for (const field of ['channel_id', 'block_number', 'transaction_index', 'transaction_id', 'block_hash']) {
    if (checkpoint[field] !== expected[field]) invalid();
  }
}

/** A refreshed fence may get new run IDs; the knowledge and policy binding must stay fixed. */
export function validateRefreshedManifest(previousValue:unknown,nextValue:unknown):any {
  const previous=object(previousValue);const reference=object(previous.provided_revisions?.[0]);
  const selection=validateSelection({document_ids:['doc-manifest-validation'],context_id:previous.context_id,scope_id:previous.scope_id,usage_scope:previous.usage_scope});
  const digest=assertDigest(reference.revision_digest),agreement=assertId(reference.agreement_id);
  validateManifest(previous,selection,digest,agreement);
  const next=validateManifest(nextValue,selection,digest,agreement);
  for(const field of ['policy_id','policy_version','membership_epoch','model_egress_policy_version','retrieval_profile_id'])if(previous[field]!==next[field])invalid();
  const before=previous.checkpoint,after=next.checkpoint;
  if(after.channel_id!==before.channel_id||after.block_number<before.block_number||(after.block_number===before.block_number&&after.transaction_index<=before.transaction_index))invalid();
  if(canonicalize(previous.provided_revisions)!==canonicalize(next.provided_revisions))invalid();
  const decisions=(manifest:any)=>[...manifest.approval_decisions].sort((a,b)=>a.decision_id.localeCompare(b.decision_id));
  if(canonicalize(decisions(previous))!==canonicalize(decisions(next)))invalid();
  return next;
}

export class KnowledgerClient {
  readonly baseUrl: string;
  readonly workspaceId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headersProvider?: KnowledgerClientOptions['headers'];
  private readonly timeoutMs: number;

  constructor(options: KnowledgerClientOptions) {
    let url: URL;
    try { url = new URL(options.baseUrl); } catch { throw new KnowledgerClientError('INVALID_ORIGIN', 'Knowledger base URL origin is invalid.'); }
    if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !isLoopback(url.hostname)) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new KnowledgerClientError('INVALID_ORIGIN', 'Knowledger base URL origin is invalid.');
    this.baseUrl = url.origin;
    this.workspaceId = assertId(options.workspaceId);
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS)) throw new KnowledgerClientError('INVALID_TIMEOUT', 'Knowledger timeout 설정이 올바르지 않습니다.');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fallbackFetch = globalThis.fetch;
    if (!options.fetch && typeof fallbackFetch !== 'function') throw new KnowledgerClientError('FETCH_UNAVAILABLE', 'A fetch implementation is required.');
    this.fetchImpl = options.fetch ?? fallbackFetch.bind(globalThis);
    this.headersProvider = options.headers;
  }

  async request<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.startsWith('/v1/workspaces/') || path.includes('\\') || path.includes('\u0000') || /%(?:2e|2f|5c|00)/iu.test(path) || path.split(/[/?#]/u).includes('..')) throw new KnowledgerClientError('INVALID_PATH', 'Knowledger 경로가 올바르지 않습니다.');
    const method = options.method ?? 'GET';
    if (method !== 'GET' && method !== 'POST') throw new KnowledgerClientError('INVALID_METHOD', 'Knowledger method가 올바르지 않습니다.');
    const url = `${this.baseUrl}/v1/workspaces/${encodeURIComponent(this.workspaceId)}${path}`;
    const controller = new AbortController();
    if (options.signal?.aborted) throw new KnowledgerClientError('ABORTED', 'Knowledger 요청이 취소되었습니다.', undefined, true);
    let rejectDeadline!: (error: KnowledgerClientError) => void;
    const deadline = new Promise<never>((_, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => { controller.abort(); rejectDeadline(new KnowledgerTimeoutError()); }, this.timeoutMs);
    const abort = () => { controller.abort(options.signal?.reason); rejectDeadline(new KnowledgerClientError('ABORTED', 'Knowledger 요청이 취소되었습니다.', undefined, true)); };
    if (options.signal) {
      if (options.signal.aborted) abort();
      else options.signal.addEventListener('abort', abort, { once: true });
    }
    const run = (async () => {
      let headers: Record<string, string> = { Accept: 'application/json' };
      try {
        const provided = this.headersProvider ? await this.headersProvider() : {};
        if (!provided || typeof provided !== 'object' || Array.isArray(provided) || Object.entries(provided).some(([key, value]) => typeof key !== 'string' || typeof value !== 'string')) throw new Error('headers');
        headers = { ...headers, ...provided };
        if (options.body !== undefined) headers['Content-Type'] ??= 'application/json';
      } catch { throw new KnowledgerClientError('INVALID_HEADERS', 'Knowledger 요청 인증 헤더를 준비할 수 없습니다.'); }
      if(controller.signal.aborted)throw new KnowledgerClientError('ABORTED','Knowledger 요청이 취소되었습니다.',undefined,true);
      let body: string | undefined;
      if (options.body !== undefined) { try { body = JSON.stringify(options.body); } catch { throw new KnowledgerClientError('INVALID_BODY', 'Knowledger 요청 본문을 준비할 수 없습니다.'); } }
      let response: Response;
      try { response = await this.fetchImpl(url, { method, headers, body, redirect: 'error', signal: controller.signal }); }
      catch (error) { if (options.signal?.aborted) throw new KnowledgerClientError('ABORTED', 'Knowledger 요청이 취소되었습니다.', undefined, true); throw new KnowledgerClientError('NETWORK_ERROR', 'Knowledger 서버에 연결할 수 없습니다.', undefined, true); }
      const bytes = await readBounded(response, controller.signal);
      if (response.status === 202) throw new KnowledgerPendingError();
      const parsed = parseResponse(bytes);
      if (!response.ok) {
        const bodyValue = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
        const code = safeCode(bodyValue.code) ?? `HTTP_${response.status}`;
        throw new KnowledgerClientError(code, 'Knowledger 요청을 처리하지 못했습니다.', response.status, bodyValue.retryable === true || response.status >= 500);
      }
      return parsed as T;
    })();
    run.catch(() => undefined);
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }

  rawResolve(selection: ResolveSelection, options: { signal?: AbortSignal; modelAdapterId?: string } = {}): Promise<RawResolveResponse> {
    const body: Record<string, unknown> = { ...validateSelection(selection) };
    if (options.modelAdapterId !== undefined) body.model_adapter_id = assertAdapterId(options.modelAdapterId);
    return this.request<RawResolveResponse>('/resolve', { method: 'POST', body, signal: options.signal });
  }

  async revision(digest: string, options: { signal?: AbortSignal } = {}): Promise<ReturnType<typeof validateRevision>> {
    const expected = assertDigest(digest);
    const value = object(await this.request(`/revisions/${expected}`, { signal: options.signal }));
    if (Object.keys(value).some(key => !['revision_digest', 'payload'].includes(key)) || value.revision_digest !== expected) invalid();
    try { return validateRevision(value); } catch { invalid(); }
  }

  async resolve(selection: ResolveSelection, options: { allowDevelopment?: boolean; signal?: AbortSignal; modelAdapterId?: string } = {}): Promise<RawResolveResponse | ValidatedResolveResponse> {
    const started=performance.now();
    const normalized = validateSelection(selection);
    const raw = object(await this.rawResolve(normalized, options)) as RawResolveResponse;
    if (raw.status === 'withheld') return {status:'withheld',reason:safeCode(raw.reason)??'KNOWLEDGE_UNAVAILABLE',documents:[]};
    if (raw.status !== 'provided') invalid();
    if (!['fabric', ...(options.allowDevelopment ? ['local-simulation', 'fabric-test-network'] : [])].includes(raw.mode ?? '')) throw new KnowledgerClientError('DEVELOPMENT_MODE_REJECTED', 'Development ledger mode requires explicit allowDevelopment.');
    const documents = Array.isArray(raw.documents) && raw.documents.length === 1 ? raw.documents : invalid();
    const document = object(documents[0]);
    if(Object.keys(document).some(key=>!['revision_digest','title','body_markdown','agreement_id'].includes(key)))invalid();
    const digest = assertDigest(document.revision_digest);
    const agreementId = assertId(document.agreement_id);
    const manifestValue = validateManifest(raw.manifest, normalized, digest, agreementId);
    validateSharedCheckpoint(raw.checkpoint, manifestValue);
    const full = await this.revision(digest, options);
    if (manifestValue.checkpoint.channel_id !== full.payload.channel_id) invalid();
    if (full.payload.document_id !== normalized.document_ids[0] || full.payload.context_id !== normalized.context_id || full.payload.scope_id !== normalized.scope_id || full.payload.usage_scope !== normalized.usage_scope
      || document.title !== full.payload.title || document.body_markdown !== full.payload.body_markdown || digestPayload(full.payload) !== digest) invalid();
    if(performance.now()-started>30_000)throw new KnowledgerClientError('FRESHNESS_EXPIRED','신선한 원장 응답의 유효 시간이 지났습니다.',503,true);
    return { ...raw, status: 'provided', documents, manifest: manifestValue, revision: full };
  }

  async revalidate(runId: string, options: { signal?: AbortSignal; modelAdapterId?: string } = {}): Promise<any> {
    const started=performance.now();
    const body: Record<string, unknown> = { action: 'use-context' };
    if (options.modelAdapterId !== undefined) body.model_adapter_id = assertAdapterId(options.modelAdapterId);
    const result = object(await this.request(`/runs/${encodeURIComponent(assertId(runId))}/revalidate`, { method: 'POST', body, signal: options.signal }));
    if(result.status==='valid'){
      const manifest=object(result.refreshed_manifest);const reference=object(manifest.provided_revisions?.[0]);
      const selection=validateSelection({document_ids:['doc-manifest-validation'],context_id:manifest.context_id,scope_id:manifest.scope_id,usage_scope:manifest.usage_scope});
      validateManifest(manifest,selection,assertDigest(reference.revision_digest),assertId(reference.agreement_id));
      validateSharedCheckpoint(result.checkpoint,manifest);
      if(performance.now()-started>30_000)throw new KnowledgerClientError('FRESHNESS_EXPIRED','신선한 원장 응답의 유효 시간이 지났습니다.',503,true);
    }
    if (result.status !== 'valid' && result.status !== 'withheld') invalid();
    return result;
  }
}

export { validateSelection };
