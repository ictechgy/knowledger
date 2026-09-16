import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { ReadinessMonitor } from '../../apps/api/readiness.ts';

test('readiness has one nonblocking probe, a cooldown, and bounded sample age even if the peer hangs', async () => {
  let now = 0; let calls = 0; let release!: () => void;
  const monitor = new ReadinessMonitor(async () => { calls++; await new Promise<void>(resolve => { release = resolve; }); }, () => now);
  for (let n = 0; n < 100; n++) assert.equal(monitor.read().healthy, false);
  await setImmediate(); assert.equal(calls, 1);
  release(); await setImmediate();
  assert.equal(monitor.read().healthy, true);
  now = 999; for (let n = 0; n < 100; n++) assert.equal(monitor.read().healthy, true);
  await setImmediate(); assert.equal(calls, 1);
  now = 1000; assert.equal(monitor.read().healthy, true); await setImmediate(); assert.equal(calls, 2);
  now = 5001; assert.equal(monitor.read().healthy, false);
  now = 100000; for (let n = 0; n < 100; n++) assert.equal(monitor.read().healthy, false);
  await setImmediate(); assert.equal(calls, 2, 'a hung probe cannot accumulate queued work');
  release(); await setImmediate();
  assert.equal(monitor.read().healthy, false, 'slow replies retain their original observation age');
  monitor.close(); await setImmediate(); release(); await setImmediate(); assert.equal(monitor.read().healthy, false);
});

test('failed readiness probes cache only a generic unavailable state and recover after cooldown', async () => {
  let now = 0; let online = false; let calls = 0;
  const monitor = new ReadinessMonitor(async () => { calls++; if (!online) throw new Error('private diagnostic'); }, () => now);
  monitor.read(); await setImmediate();
  assert.equal(monitor.read().healthy, false); assert.equal(JSON.stringify(monitor.read()).includes('private'), false);
  online = true; now = 1000; monitor.read(); await setImmediate();
  assert.equal(monitor.read().healthy, true); assert.equal(calls, 2); monitor.close();
});

test('closing readiness before its scheduled probe runs does not start external work', async () => {
  let calls = 0; const monitor = new ReadinessMonitor(async () => { calls++; });
  monitor.read(); monitor.close(); await setImmediate();
  assert.equal(calls, 0); assert.equal(monitor.read().healthy, false);
});
