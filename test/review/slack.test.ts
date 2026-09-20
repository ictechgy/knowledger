import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createSlackAdapter } from '../../packages/review/slack.ts';

const address = { team_id: 'TTEST123', user_id: 'UTEST123', dm_id: 'DTEST123' };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json; charset=utf-8' } });
function fixture(change: any = {}) {
  const calls: { url: string; input: any; body: any }[] = [];
  const fetch = async (url: string, input: any) => {
    calls.push({ url, input, body: JSON.parse(input.body) });
    if (url.endsWith('auth.test')) return json({ ok: true, team_id: address.team_id, bot_id: 'BBOT123' });
    if (url.endsWith('conversations.open')) return json({ ok: true, channel: { id: address.dm_id, user: address.user_id, is_im: true } });
    return json({ ok: true, channel: address.dm_id, ts: '1726839000.000001', message: { text: 'PRIVATE_RESPONSE_TEXT' } });
  };
  return { calls, fetch, options: { address, appUrl: 'https://knowledger.example/', getBotToken: () => 'xoxb-FIXTURE-TOKEN', fetch, ...change } };
}
const send = (options: any, guard = async () => true, signal = new AbortController().signal) => createSlackAdapter(options).send('due', guard, signal);

test('Slack checks workspace and exact one-person DM before sending minimal text to fixed endpoints', async () => {
  const f = fixture(); const result = await send(f.options);
  assert.equal(result.status, 'provider_accepted'); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls.map(call => call.url), ['auth.test', 'conversations.open', 'chat.postMessage'].map(method => 'https://slack.com/api/' + method));
  assert.deepEqual(f.calls[1].body, { users: address.user_id, return_im: true });
  const posted = f.calls[2].body;
  assert.deepEqual(Object.keys(posted).sort(), ['channel', 'mrkdwn', 'parse', 'text', 'unfurl_app_links', 'unfurl_links', 'unfurl_media']);
  assert.equal(posted.unfurl_links, false); assert.equal(posted.unfurl_app_links, false); assert.equal(posted.mrkdwn, true);
  assert.match(posted.text, /<https:\/\/knowledger.example\/\|Knowledger 열기>/);
  assert.match(posted.text, /https:\/\/knowledger.example\//);
  assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE_TEXT'), false); assert.equal(JSON.stringify(result).includes('TOKEN'), false);
  for (const call of f.calls) { assert.equal(call.input.redirect, 'error'); assert.equal(call.input.method, 'POST'); }
});

test('missing or revoked authorization prevents credentials and later Slack calls', async () => {
  let keys = 0; const f = fixture({ getBotToken: () => { keys++; return 'xoxb-FIXTURE'; } });
  assert.equal((await send(f.options, async () => false)).status, 'blocked'); assert.equal(keys, 0); assert.equal(f.calls.length, 0);
  let allowed = true; f.options.getBotToken = () => { allowed = false; return 'xoxb-FIXTURE'; };
  assert.equal((await send(f.options, async () => allowed)).status, 'blocked'); assert.equal(f.calls.length, 0);
});

test('wrong Slack workspace, non-bot token identity and mismatched DM never post a message', async () => {
  for (const response of [{ ok: true, team_id: 'TOTHER', bot_id: 'BBOT123' }, { ok: true, team_id: address.team_id }]) {
    const f = fixture({ fetch: async () => json(response) }); assert.equal((await send(f.options)).status, 'blocked');
  }
  for (const channel of [{ id: 'DOTHER', user: address.user_id, is_im: true }, { id: address.dm_id, user: 'UOTHER', is_im: true }, { id: address.dm_id, user: address.user_id, is_im: false }]) {
    const f = fixture(); let posts = 0; f.options.fetch = async (url: string, input: any) => {
      if (url.endsWith('chat.postMessage')) posts++; if (url.endsWith('conversations.open')) return json({ ok: true, channel }); return f.fetch(url, input);
    };
    assert.equal((await send(f.options)).status, 'blocked'); assert.equal(posts, 0);
  }
});

test('429 respects Retry-After, known refusal blocks, and all ambiguous post results remain unknown', async () => {
  const cases: [() => Response, string][] = [
    [() => new Response('', { status: 429, headers: { 'retry-after': '17' } }), 'retry_wait'],
    [() => new Response('', { status: 429, headers: { 'retry-after': 'garbage' } }), 'blocked'],
    [() => json({ ok: false, error: 'missing_scope' }), 'blocked'],
    [() => json({ ok: false, error: 'internal_error', detail: 'SECRET' }), 'unknown'],
    [() => json({ ok: false, error: 'new_unrecognized_error' }), 'unknown'],
    [() => new Response('SECRET', { status: 503 }), 'unknown'],
    [() => json({ ok: true, channel: 'DOTHER', ts: '1726839000.000001' }), 'unknown'],
    [() => new Response('{"ok":true,"ok":false}', { headers: { 'content-type': 'application/json' } }), 'unknown'],
    [() => json({ ok: true, channel: address.dm_id, ts: 'wrong' }), 'unknown'],
    [() => json({ ok: true, channel: address.dm_id, ts: 1.123456 }), 'unknown'],
    [() => json({ ok: true, large: 'x'.repeat(65536) }), 'unknown'],
  ];
  for (const [reply, status] of cases) {
    const f = fixture(); let posts = 0; f.options.fetch = async (url: string, input: any) => {
      if (url.endsWith('chat.postMessage')) { posts++; return reply(); } return f.fetch(url, input);
    };
    const result = await send(f.options); assert.equal(result.status, status); assert.equal(posts, 1);
    assert.equal(JSON.stringify(result).includes('SECRET'), false);
    if (result.status === 'retry_wait') assert.equal(result.retry_after_ms, 17000);
  }
});

test('timeout includes token lookup, stops late calls and preserves unknown post outcome', async () => {
  let release!: (value: string) => void;
  const f = fixture({ timeoutMs: 20, getBotToken: () => new Promise(resolve => { release = resolve; }) });
  assert.equal((await send(f.options)).status, 'retry_wait'); release('xoxb-FIXTURE'); await delay(5); assert.equal(f.calls.length, 0);
  const slow = fixture({ timeoutMs: 20 }); let cancelled = false;
  slow.options.fetch = async (url: string, input: any) => url.endsWith('chat.postMessage')
    ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }) : slow.fetch(url, input);
  assert.equal((await send(slow.options)).status, 'unknown'); assert.equal(cancelled, true);
});

test('caller cancellation and throwing credential callbacks never leak diagnostics or continue sending', async () => {
  const controller = new AbortController(); const f = fixture({ getBotToken: () => { controller.abort(); return 'xoxb-FIXTURE'; } });
  assert.equal((await send(f.options, async () => true, controller.signal)).status, 'retry_wait'); assert.equal(f.calls.length, 0);
  const failure = fixture({ getBotToken: () => { throw { result: { status: 'provider_accepted', receipt: 'SECRET_FAKE_RECEIPT' } }; } });
  const result = await send(failure.options); assert.equal(result.status, 'retry_wait'); assert.equal(JSON.stringify(result).includes('SECRET'), false);
});

test('invalid address, private URL data and non-bot credentials are rejected without network', async () => {
  for (const change of [{ appUrl: 'http://example.test/' }, { appUrl: 'https://user:secret@example.test/' }, { appUrl: 'https://example.test/?token=secret' },
    { address: { ...address, dm_id: 'CPUBLIC' } }, { address: { ...address, user_id: 'UONE,UTWO' } }, { timeoutMs: 0 }]) assert.throws(() => createSlackAdapter(fixture(change).options));
  const f = fixture({ getBotToken: () => 'xoxp-not-a-bot' }); assert.equal((await send(f.options)).status, 'blocked'); assert.equal(f.calls.length, 0);
});
