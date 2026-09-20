import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createOpenAIEmbeddingProvider } from '../../packages/embeddings/openai.ts';

const context = () => ({ signal: new AbortController().signal, beforeSend: async () => {} });
const reply = (extra: any = {}) => ({ object: 'list', model: 'text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 1, total_tokens: 1 }, ...extra });
const options = (fetch: any, extra: any = {}) => ({ profileId: 'openai-test-v1', dimensions: 2, countTokens: (text: string) => text.length, getApiKey: () => 'FIXTURE_KEY_CANARY', fetch, ...extra });

test('OpenAI adapter pins endpoint/model/dimensions and sends only the exact text after permission', async () => {
  let authorized = false; let calls = 0;
  const provider = createOpenAIEmbeddingProvider(options(async (url: string, request: any) => {
    calls++; assert.equal(authorized, true); assert.equal(url, 'https://api.openai.com/v1/embeddings'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, 'Bearer FIXTURE_KEY_CANARY');
    assert.deepEqual(JSON.parse(request.body), { model: 'text-embedding-3-small', dimensions: 2, encoding_format: 'float', input: '정확한\n원문😀' });
    return new Response(JSON.stringify(reply()), { headers: { 'Content-Type': 'application/json' } });
  }));
  assert.deepEqual(await provider.embed('정확한\n원문😀', { signal: new AbortController().signal, beforeSend: async () => { authorized = true; } }), [1, 0]);
  assert.equal(calls, 1); assert.ok(Object.isFrozen(provider.profile));
  const defaults = createOpenAIEmbeddingProvider(options(async () => new Response(), { dimensions: undefined })); assert.equal(defaults.profile.dimensions, 1536);
});

test('token overflow, malformed input and invalid credentials fail without a provider request or truncation', async () => {
  let calls = 0; let keys = 0; const fetch = async () => { calls++; return new Response(); };
  const tooLong = createOpenAIEmbeddingProvider(options(fetch, { countTokens: () => 8193, getApiKey: () => { keys++; return 'key'; } }));
  await assert.rejects(tooLong.embed('input', context()), (e: any) => e.code === 'EMBEDDING_INPUT_TOO_LARGE'); assert.equal(keys, 0);
  const normal = createOpenAIEmbeddingProvider(options(fetch));
  for (const value of ['', '  ', '\ud800']) await assert.rejects(normal.embed(value, context()));
  const noToken = createOpenAIEmbeddingProvider(options(fetch, { getApiKey: () => 'bad\nsecret' }));
  await assert.rejects(noToken.embed('query', context()), (e: any) => e.code === 'EMBEDDING_CREDENTIAL_UNAVAILABLE' && !String(e).includes('secret'));
  assert.equal(calls, 0);
});

test('model/index/count/shape/finite-vector mismatches and oversized responses are rejected', async () => {
  for (const value of [reply({ model: 'other-model' }), reply({ data: [] }), reply({ data: [{ object: 'embedding', index: 1, embedding: [1, 0] }] }),
    reply({ data: [{ object: 'embedding', index: 0, embedding: [1] }] }), reply({ data: [{ object: 'embedding', index: 0, embedding: [0, 0] }] }),
    reply({ usage: { prompt_tokens: 1, total_tokens: 2 } }), reply({ usage: { prompt_tokens: 10000, total_tokens: 10000 } })]) {
    const provider = createOpenAIEmbeddingProvider(options(async () => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })));
    await assert.rejects(provider.embed('query', context()), (e: any) => e.code === 'EMBEDDING_INVALID_RESPONSE');
  }
  for (const raw of ['{"object":"list","object":"list"}', JSON.stringify(reply()).replace('[1,0]', '[1e999,0]'), 'x'.repeat(256 * 1024 + 1)]) {
    const provider = createOpenAIEmbeddingProvider(options(async () => new Response(raw, { headers: { 'Content-Type': 'application/json' } })));
    await assert.rejects(provider.embed('query', context()), (e: any) => e.code === 'EMBEDDING_INVALID_RESPONSE');
  }
});

test('HTTP errors expose safe classifications without remote bodies or automatic retries', async () => {
  for (const [status, code] of [[401, 'EMBEDDING_PROVIDER_REJECTED'], [429, 'EMBEDDING_RATE_LIMITED'], [503, 'EMBEDDING_UNAVAILABLE']] as const) {
    let calls = 0; const provider = createOpenAIEmbeddingProvider(options(async () => { calls++; return new Response('PRIVATE_REMOTE_DIAGNOSTIC FIXTURE_KEY_CANARY', { status }); }));
    await assert.rejects(provider.embed('PRIVATE_QUERY_CANARY', context()), (e: any) => e.code === code && !JSON.stringify(e).includes('CANARY') && !String(e).includes('PRIVATE'));
    assert.equal(calls, 1);
  }
});

test('a credential callback that ignores cancellation cannot start a late request', async () => {
  let release!: (key: string) => void; let calls = 0;
  const provider = createOpenAIEmbeddingProvider(options(async () => { calls++; return new Response(); }, { timeoutMs: 20, getApiKey: () => new Promise(resolve => { release = resolve; }) }));
  await assert.rejects(provider.embed('query', context()), (e: any) => e.code === 'EMBEDDING_TIMEOUT');
  release('FIXTURE_KEY_CANARY'); await delay(10); assert.equal(calls, 0);
});

test('an unfinished response body respects the adapter deadline', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } });
  const provider = createOpenAIEmbeddingProvider(options(async () => new Response(stream, { headers: { 'Content-Type': 'application/json' } }), { timeoutMs: 20 }));
  await assert.rejects(provider.embed('query', context()), (e: any) => e.code === 'EMBEDDING_TIMEOUT');
  assert.equal(cancelled, true);
});
