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

test('performance smoke CLI accepts a non-regressed rerun against a baseline', async t => {
  const { spawnSync } = await import('node:child_process');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-performance-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flags = ['--documents', '2', '--samples', '1', '--body-bytes', '1'];
  const baseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), ...flags, '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  // 실제 타이밍 지터에 의존하지 않도록 baseline 메트릭을 큰 값으로 덮어써 비회귀를 결정적으로 만든다.
  const baselineData = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
  for (const name of Object.keys(baselineData.metrics)) {
    const metric = baselineData.metrics[name];
    baselineData.metrics[name] = metric && typeof metric === 'object' ? { ...metric, p95_ms: 1e12 } : 1e12;
  }
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baselineData));
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
  // baseline 메트릭을 0으로 덮어쓰면 양수 측정값이 항상 회귀로 판정된다 — 타이밍에 의존하지 않는다.
  const baselineData = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
  for (const name of Object.keys(baselineData.metrics)) {
    const metric = baselineData.metrics[name];
    baselineData.metrics[name] = metric && typeof metric === 'object' ? { ...metric, p95_ms: 0 } : 0;
  }
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baselineData));
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
  const emptyRatio = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--baseline', 'baseline.json', '--threshold', 'search= '], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(emptyRatio.status, 1);
  assert.match(emptyRatio.stderr, /not a finite nonnegative ratio/);
  const thresholdWithoutBaseline = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--threshold', 'search=0.1'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(thresholdWithoutBaseline.status, 1);
  assert.match(thresholdWithoutBaseline.stderr, /--threshold requires --baseline/);
  // --out이 --baseline과 같은 파일이면 측정 전에 거절해 baseline을 보존한다.
  const sameFile = spawnSync(process.execPath, [join(process.cwd(), 'tools', 'performance-smoke.ts'), '--documents', '2', '--samples', '1', '--body-bytes', '1', '--baseline', 'baseline.json', '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.equal(sameFile.status, 1);
  assert.match(sameFile.stderr, /same file as --baseline/);
  assert.equal(JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8')).mode, 'local-simulation');
});

test('compareMetrics handles boundary ratios, baseline zero, and invalid baselines deterministically', async () => {
  const { compareMetrics, RESULT_SCHEMA_VERSION } = await import('../../tools/performance-compare.ts');
  const environment = { node: 'v24.test', platform: 'test', arch: 'x64', cpu_count: 8, cpu_model: 'test-cpu' };
  const dataset = { documents_requested: 2 };
  const fields = ['documents_requested'] as const;
  const metrics = ['search'] as const;
  const baseline = (ms: number) => ({ schema_version: RESULT_SCHEMA_VERSION, mode: 'local-simulation', environment, dataset, metrics: { search: { p95_ms: ms } }, functional_assertions: {} });
  const current = (ms: number) => ({ mode: 'local-simulation', environment, dataset, metrics: { search: { p95_ms: ms } } });
  // 정확히 +10% 경계는 부동소수점 오차로 회귀 판정되면 안 된다.
  assert.deepEqual(compareMetrics(baseline(100), current(110), fields, metrics, { search: 0.1 }).regressions, []);
  // 경계를 넘는 값은 회귀다.
  assert.equal(compareMetrics(baseline(100), current(111), fields, metrics, { search: 0.1 }).regressions.length, 1);
  // baseline 0 + 양수 현재값은 명시 문구와 null ratio를 기록한다.
  const zeroBase = compareMetrics(baseline(0), current(5), fields, metrics, { search: 0 });
  assert.equal(zeroBase.regressions.length, 1);
  assert.match(zeroBase.regressions[0], /baseline 0 -> nonzero/);
  assert.equal(zeroBase.entries[0].ratio, null);
  // 빠진 메트릭·구 스키마·다른 mode는 명확한 입력 오류다.
  assert.throws(() => compareMetrics({ schema_version: RESULT_SCHEMA_VERSION, mode: 'local-simulation', environment, dataset, metrics: {}, functional_assertions: {} }, current(1), fields, metrics, {}), /metric baseline\.metrics\.search is missing/);
  assert.throws(() => compareMetrics({ ...baseline(1), schema_version: 1 }, current(1), fields, metrics, {}), /schema_version/);
  assert.throws(() => compareMetrics({ ...baseline(1), mode: 'fabric-adapter-synthetic' }, current(1), fields, metrics, {}), /mode/);
  // 현재 결과에 비교 대상 dataset 필드가 없으면 호환 불가 오류다.
  assert.throws(() => compareMetrics(baseline(1), { ...current(1), dataset: {} }, fields, metrics, {}), /missing dataset\.documents_requested/);
  // environment 섹션이 없는 baseline도 ComparisonInputError로 거절한다(TypeError가 아니다).
  assert.throws(() => compareMetrics({ ...baseline(1), environment: undefined }, current(1), fields, metrics, {}), /missing the "environment" section/);
});

test('assertDistinctOutputPath rejects --out aliases of the baseline file', async () => {
  const { assertDistinctOutputPath, ComparisonInputError } = await import('../../tools/performance-compare.ts');
  const { linkSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-out-collision-'));
  try {
    const baseline = join(root, 'baseline.json');
    writeFileSync(baseline, '{}');
    // 같은 파일·심볼릭링크·하드링크 별칭은 모두 거절한다 — 결과가 baseline을 덮어쓰면 안 된다.
    assert.throws(() => assertDistinctOutputPath(baseline, baseline), ComparisonInputError);
    const { symlinkSync } = await import('node:fs');
    const symlink = join(root, 'baseline-link.json');
    symlinkSync(baseline, symlink);
    assert.throws(() => assertDistinctOutputPath(symlink, baseline), ComparisonInputError);
    const hardlink = join(root, 'baseline-alias.json');
    linkSync(baseline, hardlink);
    assert.throws(() => assertDistinctOutputPath(hardlink, baseline), ComparisonInputError);
    // 다른 경로와 아직 존재하지 않는 출력 경로는 통과한다.
    assertDistinctOutputPath(join(root, 'out.json'), baseline);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reportCliResult preserves the measured result when comparison input fails', async () => {
  const { reportCliResult, RESULT_SCHEMA_VERSION, ComparisonInputError } = await import('../../tools/performance-compare.ts');
  const root = mkdtempSync(join(tmpdir(), 'knowledger-report-preserve-'));
  try {
    const outPath = join(root, 'out.json');
    const environment = { node: 'v24.test', platform: 'test', arch: 'x64', cpu_count: 8, cpu_model: 'test-cpu' };
    const result = { mode: 'local-simulation', environment, dataset: { documents_requested: 2 }, metrics: { search: { p95_ms: 1 } } };
    const baseline = { schema_version: RESULT_SCHEMA_VERSION, mode: 'local-simulation', environment, dataset: { documents_requested: 3 }, metrics: { search: { p95_ms: 1 } }, functional_assertions: {} };
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalExitCode = process.exitCode;
    try {
      process.stdout.write = (() => true) as typeof process.stdout.write;
      assert.throws(
        () => reportCliResult({ result, baseline: { path: 'baseline.json', data: baseline }, thresholds: {}, datasetFields: ['documents_requested'], metricNames: ['search'], outPath }),
        ComparisonInputError,
      );
    } finally {
      process.stdout.write = originalWrite;
      process.exitCode = originalExitCode;
    }
    const written = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(written.mode, 'local-simulation');
    assert.equal(written.comparison, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('performance-fabric CLI compares against a baseline when optional deps are installed', async t => {
  const { spawnSync } = await import('node:child_process');
  const { createRequire } = await import('node:module');
  const requireFabric = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
  try {
    requireFabric.resolve('@hyperledger/fabric-protos');
  } catch {
    t.skip('optional packages/fabric dependencies are not installed');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'knowledger-fabric-compare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const tool = join(process.cwd(), 'tools', 'performance-fabric.ts');
  const flags = ['--documents', '2', '--samples', '1', '--body-bytes', '1'];
  const baseline = spawnSync(process.execPath, [tool, ...flags, '--out', 'baseline.json'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(baseline.status, 0, baseline.stderr);
  // 실제 타이밍 지터에 의존하지 않도록 baseline 메트릭을 큰 값으로 덮어쓴다.
  const baselineData = JSON.parse(readFileSync(join(root, 'baseline.json'), 'utf8'));
  for (const name of Object.keys(baselineData.metrics)) {
    const metric = baselineData.metrics[name];
    baselineData.metrics[name] = metric && typeof metric === 'object' ? { ...metric, p95_ms: 1e12 } : 1e12;
  }
  writeFileSync(join(root, 'baseline.json'), JSON.stringify(baselineData));
  const rerun = spawnSync(process.execPath, [tool, ...flags, '--baseline', 'baseline.json', '--threshold', 'ingest_total_ms=10,search=10,overview=10,replay_restart_ms=10', '--out', 'comparison.json'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.equal(rerun.status, 0, rerun.stderr);
  const compared = JSON.parse(rerun.stdout);
  assert.equal(compared.mode, 'fabric-adapter-synthetic');
  assert.deepEqual(compared.comparison.regressions, []);
});
