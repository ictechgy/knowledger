import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createConfluenceOAuthProvider } from '../../packages/connectors/confluence-oauth.ts';

const ready = () => ({ version: 1, grant_id: 'grant-fixture', client_id: 'fixture-client', state: 'ready', access_token: 'FAKE_OLD_ACCESS', refresh_token: 'FAKE_OLD_REFRESH', expires_at: 0, scope: 'read:page:confluence offline_access' });
const response = () => new Response(JSON.stringify({ access_token: 'FAKE_NEW_ACCESS', refresh_token: 'FAKE_NEW_REFRESH', expires_in: 3600, scope: 'read:page:confluence offline_access' }), { headers: { 'content-type': 'application/json' } });
function fixture(overrides: any = {}) {
  let value: any = ready(); let calls = 0; const writes: any[] = [];
  const store = { load: async () => structuredClone(value), compareAndSwap: async (_id: string, version: number, next: any) => {
    if (value.version !== version) return false; value = structuredClone(next); writes.push(value); return true;
  } };
  const options = { grantId: 'grant-fixture', clientId: 'fixture-client', store, getClientSecret: () => 'FAKE_CLIENT_SECRET', allows: () => true,
    fetch: async (url: string, init: any) => { calls++; assert.equal(url, 'https://auth.atlassian.com/oauth/token'); assert.equal(init.redirect, 'error'); assert.equal(value.state, 'refreshing'); return response(); }, ...overrides };
  return { options, store, writes, get calls() { return calls; }, get value() { return value; }, set(value_: any) { value = value_; } };
}
const get = (f: any) => createConfluenceOAuthProvider(f.options).getAccessToken(new AbortController().signal);

test('refresh intent is persisted before one fixed-endpoint call and rotated tokens commit before use', async () => {
  const f = fixture(); assert.equal(await get(f), 'FAKE_NEW_ACCESS'); assert.equal(f.calls, 1);
  assert.equal(f.writes[0].state, 'refreshing'); assert.equal('refresh_token' in f.writes[0], false); assert.equal(f.value.version, 3);
  assert.equal(await get(f), 'FAKE_NEW_ACCESS'); assert.equal(f.calls, 1, 'a new provider uses the persisted rotation');
});

test('missing policy and credential failure do not send or expose secrets', async () => {
  const denied = fixture({ allows: undefined }); await assert.rejects(get(denied), (e: any) => e.code === 'OAUTH_ACCESS_DENIED'); assert.equal(denied.calls, 0);
  const failure = fixture({ getClientSecret: () => { throw new Error('FAKE_PRIVATE_DIAGNOSTIC'); } });
  await assert.rejects(get(failure), (e: any) => e.code === 'OAUTH_UNAVAILABLE' && !String(e).includes('PRIVATE')); assert.equal(failure.value.state, 'ready');
});

test('concurrent provider instances cannot reuse one rotating token', async () => {
  const f = fixture(); const result = await Promise.allSettled([get(f), get(f)]);
  assert.equal(f.calls, 1); assert.equal(result.filter(result => result.status === 'fulfilled').length, 1);
});

test('lost rotation response, invalid grant and malformed responses require reconnect without old-token reuse', async () => {
  for (const fetch of [async () => { throw new Error('FAKE_SECRET_FAILURE'); }, async () => new Response('PRIVATE', { status: 403 }),
    async () => new Response('{"access_token":"first","access_token":"second"}', { headers: { 'content-type': 'application/json' } }),
    async () => new Response(JSON.stringify({ access_token: 'FAKE', refresh_token: 'FAKE', expires_in: 0, scope: 'read:page:confluence' }), { headers: { 'content-type': 'application/json' } })]) {
    let calls = 0; const f = fixture({ fetch: async () => { calls++; return fetch(); } });
    await assert.rejects(get(f)); assert.equal(f.value.state, 'refreshing');
    await assert.rejects(get(f), (e: any) => e.code === 'OAUTH_REFRESH_UNCONFIRMED'); assert.equal(calls, 1);
  }
});

test('a new grant or failed durable save cannot be overwritten or return an uncommitted access token', async () => {
  const f = fixture(); f.options.fetch = async () => { f.set({ ...ready(), version: 4, expires_at: Date.now() + 3600000 }); return response(); };
  await assert.rejects(get(f), (e: any) => e.code === 'OAUTH_GRANT_CHANGED'); assert.equal(f.value.version, 4);
  const failed = fixture(); const save = failed.store.compareAndSwap;
  failed.store.compareAndSwap = async (id, version, next) => { if (next.state === 'ready') throw new Error('FAILED_SECRET_STORE'); return save(id, version, next); };
  await assert.rejects(get(failed), (e: any) => !String(e).includes('SECRET_STORE')); assert.equal(failed.value.state, 'refreshing');
});

test('timeout and close prevent late credential callbacks from rotating tokens', async () => {
  let release!: (value: string) => void; const f = fixture({ timeoutMs: 20, getClientSecret: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(get(f), (e: any) => e.code === 'OAUTH_CANCELLED'); release('FAKE_SECRET'); await delay(5); assert.equal(f.calls, 0); assert.equal(f.writes.length, 0);
  const closed = createConfluenceOAuthProvider(fixture().options); closed.close(); await assert.rejects(closed.getAccessToken(new AbortController().signal), (e: any) => e.code === 'OAUTH_CANCELLED');
});

test('fresh token reads still recheck grant replacement and authorization', async () => {
  const f = fixture(); f.set({ ...ready(), expires_at: Date.now() + 3600000 }); let permits = 0;
  f.options.allows = () => { if (++permits === 2) f.set({ ...ready(), version: 2, expires_at: Date.now() + 3600000 }); return true; };
  await assert.rejects(get(f), (e: any) => e.code === 'OAUTH_GRANT_CHANGED'); assert.equal(f.calls, 0);
});

test('a SQL CAS backend preserves rotation across provider reconstruction without a token cache', async () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE grants(version INTEGER,value TEXT)'); db.prepare('INSERT INTO grants VALUES(?,?)').run(1, JSON.stringify(ready()));
  const f = fixture({ store: { load: async () => JSON.parse((db.prepare('SELECT value FROM grants').get() as any).value),
    compareAndSwap: async (_id: string, expected: number, next: any) => db.prepare('UPDATE grants SET version=?,value=? WHERE version=?').run(next.version, JSON.stringify(next), expected).changes === 1 }, fetch: async () => response() });
  try { assert.equal(await get(f), 'FAKE_NEW_ACCESS'); assert.equal(await get(f), 'FAKE_NEW_ACCESS'); assert.equal((db.prepare('SELECT version FROM grants').get() as any).version, 3); } finally { db.close(); }
});
