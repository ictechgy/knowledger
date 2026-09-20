import { parseStrictJson } from '../fabric/canonical.ts';

/** Provider-body parsing with byte and cancellation bounds; no remote diagnostic text escapes. */
export async function boundedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const check = () => { if (signal.aborted) throw new Error('HTTP_ABORTED'); };
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('Invalid response bound');
  if (signal.aborted || !response.body || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(response.headers.get('content-type') ?? '')
    || Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    void response.body?.cancel().catch(() => undefined); throw new Error('HTTP_JSON_UNAVAILABLE');
  }
  const reader = response.body.getReader(); const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const chunks: Uint8Array[] = []; let bytes = 0;
    for (;;) {
      check(); const part = await reader.read(); check(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => undefined); throw new Error('HTTP_JSON_UNAVAILABLE'); }
      chunks.push(part.value);
    }
    return parseStrictJson(Buffer.concat(chunks));
  } catch { throw new Error('HTTP_JSON_UNAVAILABLE'); }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}
