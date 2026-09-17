import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('performance smoke measures multi-query and cold searches with real result counts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-multiquery-'));
  try {
    const result = await runPerformanceSmoke({ dataDir: join(root, 'runtime'), documents: 51, samples: 2, bodyBytes: 128 });
    assert.equal(result.dataset.search_probes, 'multi_query');
    assert.ok(Array.isArray(result.dataset.search_queries) && result.dataset.search_queries.length >= 2);
    const totalQueryMatches = Object.values(result.functional_assertions.search_query_matches).reduce((sum, count) => sum + count, 0);
    assert.ok(totalQueryMatches >= 51, `every generated document must match its own digit query, got ${totalQueryMatches}`);
    for (const count of Object.values(result.functional_assertions.search_query_matches)) assert.ok(Number.isInteger(count) && count >= 0);
    assert.equal(result.functional_assertions.cold_search_matches, 51);
    assert.ok(result.metrics.search_cold.samples >= 1);
    assert.ok(result.metrics.search_warm.samples >= 1);
    assert.ok(result.metrics.search.p95_ms >= 0);
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

test('performance smoke CLI compares against a baseline and exits nonzero on regression', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flags = ['--documents', '2', '--samples', '1', '--body-bytes', '1'];
  const baseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), ...flags, '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  const rerun = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), ...flags, '--baseline', 'baseline.json', '--threshold', 'search=10,overview=10,publish=10,search_warm=10,search_cold=10,replay_restart_ms=10', '--out', 'comparison.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(rerun.status, 0, rerun.stderr);
  const compared = JSON.parse(rerun.stdout);
  assert.equal(compared.comparison.baseline, 'baseline.json');
  assert.deepEqual(compared.comparison.regressions, []);
  assert.equal(compared.comparison.metrics.length, 6);
  assert.ok(existsSync(join(root, 'comparison.json')));
});

test('performance smoke CLI keeps the result file and exits nonzero on threshold regression', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-regress-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flags = ['--documents', '2', '--samples', '1', '--body-bytes', '1'];
  const baseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), ...flags, '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  const regression = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), ...flags, '--baseline', 'baseline.json', '--threshold', 'publish=0,search=0,search_warm=0,search_cold=0,overview=0,replay_restart_ms=0', '--out', 'comparison.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(regression.status, 1, `expected regression exit, stderr: ${regression.stderr}`);
  assert.match(regression.stderr, /performance regression detected/);
  const preserved = JSON.parse(readFileSync(join(root, 'comparison.json'), 'utf8'));
  assert.equal(preserved.comparison.regressions.length >= 1, true);
  assert.equal(preserved.mode, 'local-simulation');
});

test('performance smoke CLI rejects incomparable baselines with actionable errors', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-incomparable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const baseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--samples', '1', '--body-bytes', '1', '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  const mismatched = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '3', '--samples', '1', '--body-bytes', '1', '--baseline', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /not comparable/);
  assert.match(mismatched.stderr, /dataset\.documents_requested/);
  const missing = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--baseline', 'missing.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Create one first/);
  const badThreshold = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--baseline', 'baseline.json', '--threshold', 'unknown=0.1'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(badThreshold.status, 1);
  assert.match(badThreshold.stderr, /unknown threshold metric/);
  const duplicateThreshold = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--baseline', 'baseline.json', '--threshold', 'search=0.1,search=0.2'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(duplicateThreshold.status, 1);
  assert.match(duplicateThreshold.stderr, /duplicate threshold metric/);
  const thresholdWithoutBaseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--threshold', 'search=0.1'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(thresholdWithoutBaseline.status, 1);
  assert.match(thresholdWithoutBaseline.stderr, /--threshold requires --baseline/);
});
