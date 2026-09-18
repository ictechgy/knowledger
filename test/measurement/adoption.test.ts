import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { measureAdoption, validateObservationLog } from '../../packages/measurement/adoption.ts';
import { readPilotMeasurement } from '../../tools/adoption-metrics.ts';
import { demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';

const log = {
  schema_version: 1, pilot_id: 'pilot-2026-order', concept: '주문 완료', workflow: '정산 조율',
  observations: [
    { kind: 'interpretation_mixing', subject: '주문 완료', at: '2026-09-16T02:00:00Z', detail: '영업 완료와 정산 완료가 혼합됨' },
    { kind: 'review_question', subject: '정산 기준', at: '2026-09-16T03:00:00Z' },
    { kind: 'review_question', subject: '정산 기준', at: '2026-09-16T04:00:00Z' },
    { kind: 'disclosure_burden', subject: '단가 정보', at: '2026-09-17T01:00:00Z', detail: '부서 외 공개 범위 협의 필요' },
  ],
};

async function seededLedger(t: any) {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  const service = new KnowledgerService(ledger, vault, demoDefinition());
  await service.initialize();
  await seedDemo(service);
  t.after(() => { ledger.close(); vault.close(); });
  return ledger;
}

test('observation log validation is strict', () => {
  const valid = validateObservationLog(log);
  assert.equal(valid.observations.length, 4);
  for (const bad of [
    { schema_version: 2, pilot_id: 'p', concept: 'c', workflow: 'w', observations: [] },
    { schema_version: 1, pilot_id: '', concept: 'c', workflow: 'w', observations: [] },
    { schema_version: 1, pilot_id: 'p', concept: 'c', workflow: 'w', observations: [{ kind: 'unknown', subject: 's', at: '2026-01-01T00:00:00Z' }] },
    { schema_version: 1, pilot_id: 'p', concept: 'c', workflow: 'w', observations: [{ kind: 'review_question', subject: 's', at: 'not-a-date' }] },
    { schema_version: 1, pilot_id: 'p', concept: 'c', workflow: 'w', observations: [{ kind: 'review_question', subject: 's', at: '2026-01-01T00:00:00Z', extra: 1 }] },
    { schema_version: 1, pilot_id: 'p', concept: 'c', workflow: 'w', observations: 'x' },
  ]) assert.throws(() => validateObservationLog(bad));
});

test('measurement derives agreement timings, review effort and reuse from the journal', async t => {
  const ledger = await seededLedger(t);
  const events = [];
  let after = 0;
  for (;;) {
    const page = ledger.events(after, 1000);
    events.push(...page);
    if (page.length < 1000) break;
    after = page[page.length - 1].checkpoint.block_number;
  }
  const measurement = measureAdoption({ events, log });
  assert.equal(measurement.schema_version, 1);
  assert.equal(measurement.pilot.pilot_id, 'pilot-2026-order');
  assert.ok(measurement.window.event_count > 0);
  // 시드는 문서마다 제안→승인→활성화를 수행하므로 파생 지표가 채워져야 한다.
  assert.ok(measurement.derived.time_to_agreement.count >= 1);
  assert.ok(measurement.derived.time_to_agreement.samples.every(sample => sample.seconds >= 0 && sample.activated_at >= sample.proposed_at));
  assert.ok(measurement.derived.review_effort.proposals >= 1);
  assert.ok(measurement.derived.review_effort.approvals >= 1);
  assert.ok(measurement.derived.review_effort.decisions >= measurement.derived.review_effort.approvals);
  assert.ok(measurement.derived.reuse_rate.revisions_published >= 1);
  if (measurement.derived.reuse_rate.dependency_references > 0) {
    assert.ok(measurement.derived.reuse_rate.revisions_with_dependencies >= 1);
    assert.ok(measurement.derived.reuse_rate.distinct_reused_digests >= 1);
    assert.ok(measurement.derived.reuse_rate.ratio! > 0 && measurement.derived.reuse_rate.ratio! <= 1);
  }
  assert.equal(measurement.observed.interpretation_mixing_incidents, 1);
  assert.equal(measurement.observed.review_questions, 2);
  assert.equal(measurement.observed.disclosure_burden_notes, 1);
});

test('readPilotMeasurement reads a ledger database from a stopped runtime directory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-adoption-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'shared-ledger.sqlite');
  const setup = new LocalLedger(path, 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  const service = new KnowledgerService(setup, vault, demoDefinition());
  await service.initialize();
  await seedDemo(service);
  setup.close();
  vault.close();
  const reopened = new LocalLedger(path, 'kcl-demo');
  t.after(() => reopened.close());
  const measurement = readPilotMeasurement({ ledger: reopened, observations: log });
  assert.ok(measurement.derived.time_to_agreement.count >= 1);
});

test('empty journal yields a measurement with no derived samples', () => {
  const measurement = measureAdoption({ events: [], log });
  assert.equal(measurement.derived.time_to_agreement.count, 0);
  assert.equal(measurement.derived.time_to_agreement.median_seconds, undefined);
  assert.equal(measurement.derived.reuse_rate.ratio, undefined);
  assert.equal(measurement.observed.review_questions, 2);
});
