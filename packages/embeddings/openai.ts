import { performance } from 'node:perf_hooks';
import { parseStrictJson } from '../fabric/canonical.ts';
import { EmbeddingError, embeddingBound, embeddingProfile, validateEmbedding } from './contract.ts';
import type { EmbeddingProvider } from './contract.ts';

const ENDPOINT = 'https://api.openai.com/v1/embeddings';
export interface OpenAIEmbeddingOptions {
  profileId: string;
  model?: 'text-embedding-3-small' | 'text-embedding-3-large'; dimensions?: number;
  /** Caller-owned tokenizer for the selected model. Required to reject token overflow before egress. */
  countTokens: (input: string) => number;
  /** Supplied by deployment secret storage; never read from files or logged by this adapter. */
  getApiKey: (signal: AbortSignal) => string | Promise<string>;
  timeoutMs?: number; maxInputBytes?: number; fetch?: typeof fetch;
}
/** One input per call, no truncation/automatic retry/redirect, no new SDK dependency. */
export function createOpenAIEmbeddingProvider(options: OpenAIEmbeddingOptions): EmbeddingProvider {
  const model = options.model ?? 'text-embedding-3-small';
  if (!['text-embedding-3-small', 'text-embedding-3-large'].includes(model) || typeof options.countTokens !== 'function' || typeof options.getApiKey !== 'function') throw new TypeError('Invalid OpenAI embedding options');
  const dimensions = embeddingBound(options.dimensions ?? (model === 'text-embedding-3-small' ? 1536 : 3072), 1, model === 'text-embedding-3-small' ? 1536 : 3072);
  const profile = embeddingProfile({ id: options.profileId, provider: 'openai', model, dimensions, endpoint: ENDPOINT, preprocessing: 'title-newline-body/v1' });
  const timeoutMs = embeddingBound(options.timeoutMs ?? 10000, 10, 60000);
  const maxInputBytes = embeddingBound(options.maxInputBytes ?? 512 * 1024, 1, 512 * 1024);
  const countTokens = options.countTokens; const getApiKey = options.getApiKey; const fetchImpl = options.fetch ?? fetch;
  if (typeof fetchImpl !== 'function') throw new TypeError('Invalid embedding HTTP transport');
  return Object.freeze({ profile, async embed(text: string, context: Parameters<EmbeddingProvider['embed']>[1]) {
    if (!context?.signal || typeof context.beforeSend !== 'function') throw new EmbeddingError('EMBEDDING_EGRESS_DENIED');
    const deadline = performance.now() + timeoutMs;
    if (context.signal.aborted) throw new EmbeddingError('EMBEDDING_ABORTED');
    if (typeof text !== 'string' || !text.trim() || /[\uD800-\uDFFF]/u.test(text)) throw new EmbeddingError('EMBEDDING_INVALID_INPUT');
    if (Buffer.byteLength(text) > maxInputBytes) throw new EmbeddingError('EMBEDDING_INPUT_TOO_LARGE');
    let tokens; try { tokens = countTokens(text); } catch { throw new EmbeddingError('EMBEDDING_INVALID_INPUT'); }
    if (!Number.isSafeInteger(tokens) || tokens < 1) throw new EmbeddingError('EMBEDDING_INVALID_INPUT');
    if (tokens > 8192) throw new EmbeddingError('EMBEDDING_INPUT_TOO_LARGE');
    if (performance.now() >= deadline) throw new EmbeddingError('EMBEDDING_TIMEOUT');
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false; let fail!: (error: EmbeddingError) => void;
    const interrupted = new Promise<never>((_, reject) => { fail = reject; });
    const abort = () => controller.abort();
    const check = () => { if (expired || performance.now() >= deadline) throw new EmbeddingError('EMBEDDING_TIMEOUT'); if (controller.signal.aborted) throw new EmbeddingError('EMBEDDING_ABORTED'); };
    const onAbort = () => {
      void activeReader?.cancel().catch(() => undefined);
      fail(new EmbeddingError(expired ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_ABORTED'));
    };
    controller.signal.addEventListener('abort', onAbort, { once: true }); context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { expired = true; controller.abort(); }, Math.max(0, deadline - performance.now()));
    if (context.signal.aborted) controller.abort();
    const send = async () => {
      check(); let key;
      try { key = await getApiKey(controller.signal); } catch { check(); throw new EmbeddingError('EMBEDDING_CREDENTIAL_UNAVAILABLE'); }
      check();
      if (typeof key !== 'string' || !/^[!-~]{1,4096}$/.test(key)) throw new EmbeddingError('EMBEDDING_CREDENTIAL_UNAVAILABLE');
      await context.beforeSend(); check();
      const response = await fetchImpl(ENDPOINT, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input: text, dimensions, encoding_format: 'float' }) });
      try { check(); } catch (error) { void response.body?.cancel().catch(() => undefined); throw error; }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new EmbeddingError(response.status === 429 ? 'EMBEDDING_RATE_LIMITED' : response.status >= 500 ? 'EMBEDDING_UNAVAILABLE' : 'EMBEDDING_PROVIDER_REJECTED');
      }
      if (!response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
        || Number(response.headers.get('content-length') ?? 0) > 256 * 1024) {
        void response.body?.cancel().catch(() => undefined); throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE');
      }
      const reader = response.body.getReader(); activeReader = reader; const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          check(); const next = await reader.read(); check(); if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 256 * 1024) { void reader.cancel().catch(() => undefined); throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE'); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); if (activeReader === reader) activeReader = undefined; }
      let result: any; try { result = parseStrictJson(Buffer.concat(chunks)); } catch { throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE'); }
      if (!result || result.object !== 'list' || result.model !== model || !Array.isArray(result.data) || result.data.length !== 1
        || result.data[0]?.object !== 'embedding' || result.data[0]?.index !== 0 || !Number.isSafeInteger(result.usage?.prompt_tokens)
        || result.usage.prompt_tokens < 1 || result.usage.prompt_tokens > 8192 || result.usage.total_tokens !== result.usage.prompt_tokens) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE');
      check(); return validateEmbedding(result.data[0].embedding, dimensions);
    };
    try { return await Promise.race([send(), interrupted]); }
    catch (error) { if (error instanceof EmbeddingError) throw error; check(); throw new EmbeddingError('EMBEDDING_UNAVAILABLE'); }
    finally { clearTimeout(timer); context.signal.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); controller.abort(); }
  } });
}
