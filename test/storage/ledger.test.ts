import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { DatabaseSync } from 'node:sqlite';
import { keyFor } from '../../packages/domain/index.ts';

const actor = { org_id: 'SalesMSP', actor_id: 'person-sales', kind: 'human' as const };
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-ledger-test-'));
  const ledger = new LocalLedger(join(directory, 'ledger.sqlite'), 'channel-test');
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return ledger;
}

test('a failed command leaves no partial state or committed transaction', async t => {
  const ledger = fixture(t);
  await assert.rejects(ledger.transact(actor, async ctx => {
    await ctx.put('kcl:v1:eligibility_epoch', 1);
    throw new Error('deliberate refusal');
  }), /deliberate refusal/);
  assert.equal(ledger.read('kcl:v1:eligibility_epoch'), undefined);
  assert.equal(ledger.events().length, 0);
});

test('concurrent local commands serialize and reads see earlier writes in the same transaction', async t => {
  const ledger = fixture(t);
  await Promise.all(Array.from({ length: 12 }, () => ledger.transact(actor, async ctx => {
    const before = (await ctx.get('kcl:v1:eligibility_epoch')) ?? 0;
    await ctx.put('kcl:v1:eligibility_epoch', before + 1);
    assert.equal(await ctx.get('kcl:v1:eligibility_epoch'), before + 1);
    return before + 1;
  })));
  assert.equal(ledger.read('kcl:v1:eligibility_epoch'), 12);
  assert.equal(ledger.events().length, 12);
});

test('exact checkpoint reads survive later withdrawal-like writes and projection rebuild', async t => {
  const ledger = fixture(t);
  const first = await ledger.transact(actor, async ctx => {
    await ctx.put('kcl:v1:eligibility_epoch', 1);
  });
  await ledger.transact(actor, async ctx => { await ctx.put('kcl:v1:eligibility_epoch', 2); });
  assert.equal(ledger.read('kcl:v1:eligibility_epoch', first.checkpoint), 1);
  assert.equal(ledger.read('kcl:v1:eligibility_epoch'), 2);
  ledger.rebuildProjection();
  assert.equal(ledger.read('kcl:v1:eligibility_epoch', first.checkpoint), 1);
  assert.equal(ledger.read('kcl:v1:eligibility_epoch'), 2);
  assert.throws(() => ledger.read('kcl:v1:eligibility_epoch', { ...first.checkpoint, block_hash: 'forged' }), /checkpoint/i);
});

test('unknown write-set prefix stops commit and does not advance the checkpoint', async t => {
  const ledger = fixture(t);
  await assert.rejects(ledger.transact(actor, async ctx => {
    await ctx.put('kcl:v999:unknown', { value: true });
  }), /write-set/i);
  assert.equal(ledger.checkpoint(), null);
});

test('a known revision prefix with an invalid body or key cannot advance projection', async t => {
  const ledger = fixture(t);
  await assert.rejects(ledger.transact(actor, async ctx => {
    await ctx.put('kcl:v1:revision:forged', { revision_digest: 'forged', payload: { body_markdown: 'unvalidated' } });
  }), /write-set/i);
  assert.equal(ledger.checkpoint(), null);
});

test('a revision ID index cannot point to a missing immutable revision', async t => {
  const ledger = fixture(t);
  await assert.rejects(ledger.transact(actor, async ctx => {
    await ctx.put(keyFor.revisionId('revision-missing'), { revision_digest: `sha256:${'a'.repeat(64)}` });
  }), /write-set/i);
  assert.equal(ledger.checkpoint(), null);
});

test('readMany matches individual reads, keeps checkpoint bounds, and tolerates missing keys', async t => {
  const ledger = fixture(t);
  const first = await ledger.transact(actor, async ctx => { await ctx.put('kcl:v1:eligibility_epoch', 1); });
  const second = await ledger.transact(actor, async ctx => {
    await ctx.put('kcl:v1:eligibility_epoch', 2);
    await ctx.put(keyFor.fence('nonce-0123456789abcdef'), { nonce: 'nonce-0123456789abcdef', eligibility_epoch: 2, tx_id: 'tx-test' });
  });
  const keys = [keyFor.eligibilityEpoch(), keyFor.fence('nonce-0123456789abcdef'), keyFor.fence('nonce-absent00000000')];
  const current = ledger.readMany(keys);
  assert.equal(current.get(keyFor.eligibilityEpoch()), 2);
  assert.equal(current.get(keyFor.fence('nonce-0123456789abcdef'))?.nonce, 'nonce-0123456789abcdef');
  assert.equal(current.has(keyFor.fence('nonce-absent00000000')), false);
  // 배치 결과는 키별 read()와 정확히 같은 값이어야 한다.
  for (const key of keys) assert.deepEqual(current.get(key), ledger.read(key));
  // 빈 묶음이어도 위조 체크포인트는 거부된다.
  assert.throws(() => ledger.readMany([], { ...first.checkpoint, block_hash: 'forged' }), /checkpoint/i);
  const atFirst = ledger.readMany(keys, first.checkpoint);
  assert.equal(atFirst.get(keyFor.eligibilityEpoch()), 1);
  assert.equal(atFirst.has(keyFor.fence('nonce-0123456789abcdef')), false);
  const atSecond = ledger.readMany(keys, second.checkpoint);
  assert.equal(atSecond.get(keyFor.eligibilityEpoch()), 2);
  assert.throws(() => ledger.readMany(keys, { ...first.checkpoint, block_hash: 'forged' }), /checkpoint/i);
});

test('readMany keeps the projection/history divergence check', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-readmany-test-'));
  const path = join(directory, 'ledger.sqlite');
  const ledger = new LocalLedger(path, 'channel-test');
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  await ledger.transact(actor, async ctx => { await ctx.put(keyFor.eligibilityEpoch(), 1); });
  const external = new DatabaseSync(path);
  external.prepare('UPDATE projection SET value_json = ? WHERE state_key = ?').run('999', keyFor.eligibilityEpoch());
  external.close();
  assert.throws(() => ledger.readMany([keyFor.eligibilityEpoch()]), /projection.*integrity/i);
});

test('current reads detect projection divergence from the historical write-set view', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledger-projection-test-'));
  const path = join(directory, 'ledger.sqlite');
  const ledger = new LocalLedger(path, 'channel-test');
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  await ledger.transact(actor, async ctx => { await ctx.put(keyFor.eligibilityEpoch(), 1); });
  const external = new DatabaseSync(path);
  external.prepare('UPDATE projection SET value_json = ? WHERE state_key = ?').run('999', keyFor.eligibilityEpoch());
  external.close();
  assert.throws(() => ledger.read(keyFor.eligibilityEpoch()), /projection.*integrity/i);
  assert.throws(() => ledger.entries('kcl:v1:eligibility'), /projection.*integrity/i);
  ledger.rebuildProjection();
  assert.equal(ledger.read(keyFor.eligibilityEpoch()), 1);
  assert.deepEqual(ledger.entries('kcl:v1:eligibility'), [[keyFor.eligibilityEpoch(), 1]]);
  const removed = new DatabaseSync(path);
  removed.prepare('DELETE FROM projection WHERE state_key = ?').run(keyFor.eligibilityEpoch()); removed.close();
  assert.throws(() => ledger.entries('kcl:v1:eligibility'), /projection.*integrity/i);
});
