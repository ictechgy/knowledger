import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPerformanceSmoke } from '../../tools/performance-smoke.ts';
import { runResilienceSmoke } from '../../tools/resilience-smoke.ts';

test('performance smoke reports measured local workload and functional assertions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-test-'));
  try {
    const result = await runPerformanceSmoke({ dataDir: join(root, 'runtime'), documents: 51, samples: 2, bodyBytes: 128 });
    assert.equal(result.mode, 'local-simulation');
    assert.equal(result.dataset.documents_requested, 51);
    assert.equal(result.dataset.read_workload, 'all_pages_summary');
    assert.equal(result.dataset.body_bytes, 128);
    assert.equal(result.assessment.fabric_sla_proven, false);
    assert.equal(result.functional_assertions.documents_generated, 51);
    assert.equal(result.functional_assertions.search_matches, 51);
    assert.equal(result.functional_assertions.replay_documents_retrieved, 51);
    assert.ok(result.metrics.publish.p95_ms >= result.metrics.publish.p50_ms);
    assert.ok(result.metrics.replay_restart_ms >= 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('performance smoke refuses to reuse a non-empty data directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-preserve-test-'));
  const dataDir = join(root, 'runtime');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'sentinel.txt'), 'preserve');
  try {
    await assert.rejects(() => runPerformanceSmoke({ dataDir, documents: 1, samples: 1, bodyBytes: 64 }), /new or empty/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resilience smoke verifies restart, snapshot restore, idempotency, and peer outage recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-resilience-test-'));
  try {
    const result = await runResilienceSmoke({ rootDir: root });
    assert.equal(result.mode, 'local-simulation');
    assert.equal(result.functional_assertions.forced_restart_recovered, true);
    assert.equal(result.functional_assertions.idempotent_retry_no_duplicate_event, true);
    assert.equal(result.functional_assertions.snapshot_restore_same_state, true);
    assert.equal(result.functional_assertions.peer_unavailable_strict_503, true);
    assert.equal(result.functional_assertions.peer_recovery_no_duplicate_event, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('experiment CLIs start from a clean checkout and accept relative output paths', async t=>{
  const {spawnSync}=await import('node:child_process');
  const root=mkdtempSync(join(tmpdir(),'knowledger-clean-cli-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  for(const [script,flags,out] of [['performance-smoke.ts',['--documents','2','--samples','1','--body-bytes','1'],'performance.json'],['resilience-smoke.ts',[],'resilience.json']] as const){
    const result=spawnSync(process.execPath,[join(process.cwd(),'tools',script),...flags,'--out',out],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.equal(result.status,0,result.stderr);
    const data=JSON.parse(result.stdout);assert.equal(data.mode,'local-simulation');
  }
});

test('resilience smoke refuses a nonempty root directory',async()=>{
  const root=mkdtempSync(join(tmpdir(),'knowledger-resilience-preserve-'));
  writeFileSync(join(root,'sentinel.txt'),'preserve');
  try {await assert.rejects(runResilienceSmoke({rootDir:root}),/new or empty/);}finally{rmSync(root,{recursive:true,force:true});}
});
