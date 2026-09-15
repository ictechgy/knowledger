import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';

const actor = { org_id: 'SalesMSP', actor_id: 'person-sales', kind: 'human' as const };
function fixture(t: any) {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-ledger-test-'));
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
