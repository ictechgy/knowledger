/**
 * 성능 결과 비교 헬퍼. performance-smoke와 performance-fabric이 공유하는
 * baseline 로드·검증·호환성 검사·임계값 비교·CLI 결과 보고 로직이다. 비교
 * 불가능 조건(mode/environment/dataset 불일치)은 명확한 오류로 거절하고,
 * regression은 임계값 대비 명시적 비율로 판정한다.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';

/** 성능 결과 JSON의 스키마 버전 — 비교 대상 필드가 바뀌면 올려 구 baseline을 명확히 거절한다. */
export const RESULT_SCHEMA_VERSION = 2;

/**
 * 비교 입력 오류 — 잘못된 baseline 파일·임계값·호환성 등 사용자 입력 문제와
 * 측정 자체의 실패를 구분한다. CLI는 이 타입에 일반 측정 안내를 붙이지 않는다.
 */
export class ComparisonInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComparisonInputError';
  }
}

/**
 * Baseline 대비 현재 값의 증가율. baseline이 0이면 현재 값이 0일 때만 통과한다.
 */
export function increaseRatio(current: number, baseline: number): number {
  if (baseline === 0) return current === 0 ? 0 : Number.POSITIVE_INFINITY;
  return current / baseline - 1;
}

/**
 * Baseline JSON이 이 도구의 결과 스키마인지 확인한다. schema_version, mode,
 * environment, dataset, metrics, functional_assertions가 없으면 비교가 불가능하다.
 */
export function validateBaselineShape(baseline: unknown, expectedMode: string): void {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new ComparisonInputError('baseline must be a JSON object produced by the same performance tool');
  }
  const record = baseline as Record<string, unknown>;
  if (record.schema_version !== RESULT_SCHEMA_VERSION) {
    throw new ComparisonInputError(`baseline schema_version ${JSON.stringify(record.schema_version)} is not supported (expected ${RESULT_SCHEMA_VERSION}); regenerate the baseline with the same tool version`);
  }
  if (record.mode !== expectedMode) {
    throw new ComparisonInputError(`baseline mode ${JSON.stringify(record.mode)} does not match this run's mode ${JSON.stringify(expectedMode)}; use a baseline produced by the same tool`);
  }
  for (const section of ['environment', 'dataset', 'metrics', 'functional_assertions'] as const) {
    if (!record[section] || typeof record[section] !== 'object' || Array.isArray(record[section])) {
      throw new ComparisonInputError(`baseline is missing the "${section}" section; regenerate the baseline with the same tool`);
    }
  }
  const environment = record.environment as Record<string, unknown>;
  for (const field of ['node', 'platform', 'arch'] as const) {
    if (typeof environment[field] !== 'string') {
      throw new ComparisonInputError(`baseline environment.${field} is missing or is not a string; regenerate the baseline with the same tool`);
    }
  }
  if (typeof environment.cpu_count !== 'number' || !Number.isFinite(environment.cpu_count)) {
    throw new ComparisonInputError('baseline environment.cpu_count must be a finite number');
  }
}

/**
 * 특정 메트릭 값의 유효성을 검증한다. 비교와 판정은 유한한 음수가 아닌 수에서만 의미가 있다.
 * label은 "baseline.metrics.search"처럼 어느 쪽 값인지를 포함해 오류 원인을 오도하지 않는다.
 */
export function validateMetricValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ComparisonInputError(`metric value for ${label} must be a finite nonnegative number, got ${JSON.stringify(value)}; for baseline values regenerate the baseline with the same tool`);
  }
  return value;
}

/** 현재 실행 환경 정보 — baseline 호환성 검사는 측정 전에도 계산 가능한 이 값으로 한다. */
export function currentEnvironment(): { node: string; platform: string; arch: string; cpu_count: number } {
  return { node: process.version, platform: process.platform, arch: process.arch, cpu_count: cpus().length };
}

/**
 * Baseline과 현재 실행의 environment가 같은지 확인한다. 다른 머신·Node 버전에서
 * 측정한 수치 비교는 무의미하므로 측정 전에도 호출할 수 있다.
 */
export function assertEnvironmentComparable(baseline: Record<string, any>, current: Record<string, any>): void {
  const mismatches: string[] = [];
  for (const field of ['node', 'platform', 'arch', 'cpu_count'] as const) {
    if (baseline[field] !== current[field]) {
      mismatches.push(`${field} ${JSON.stringify(baseline[field])} -> ${JSON.stringify(current[field])}`);
    }
  }
  if (mismatches.length) {
    throw new ComparisonInputError(`baseline environment is not comparable with this run — comparison is only valid on the same environment. Differences: ${mismatches.join('; ')}. Re-measure the baseline on this machine.`);
  }
}

/**
 * 같은 조건에서 측정한 결과인지 확인한다. mode·environment·dataset이 다르면
 * 수치 비교 자체가 무의미하므로 명확한 오류로 거절한다.
 */
export function assertComparable(
  baseline: Record<string, any>,
  current: { mode: string; environment: Record<string, any>; dataset: Record<string, any> },
  datasetFields: readonly string[],
): void {
  // compareMetrics가 validateBaselineShape를 먼저 호출하지만, 단독 호출에도 스스로 검증한다.
  if (baseline.mode !== current.mode) {
    throw new ComparisonInputError(`baseline mode ${JSON.stringify(baseline.mode)} does not match this run's mode ${JSON.stringify(current.mode)}; use a baseline produced by the same tool`);
  }
  assertEnvironmentComparable(baseline.environment as Record<string, any>, current.environment);
  const baselineDataset = baseline.dataset;
  if (!baselineDataset || typeof baselineDataset !== 'object' || Array.isArray(baselineDataset)) {
    throw new ComparisonInputError('baseline is missing the "dataset" section; regenerate the baseline with the same tool');
  }
  const baselineRecord = baselineDataset as Record<string, any>;
  const mismatches: string[] = [];
  for (const field of datasetFields) {
    if (!current.dataset || !(field in current.dataset)) {
      throw new ComparisonInputError(`current result is missing dataset.${field}; this tool version is incompatible with the baseline`);
    }
    if (baselineRecord[field] !== current.dataset[field]) {
      mismatches.push(`dataset.${field} ${JSON.stringify(baselineRecord[field])} -> ${JSON.stringify(current.dataset[field])}`);
    }
  }
  if (mismatches.length) {
    throw new ComparisonInputError(`baseline is not comparable with this run — same mode, environment, and dataset are required. Differences: ${mismatches.join('; ')}. Re-measure both runs with identical dataset options or keep baselines separate.`);
  }
}

/**
 * Baseline 파일을 읽어 JSON으로 파싱한다. 파일이 없거나 JSON이 아니면
 * 해결 방법을 안내하는 ComparisonInputError로 변환한다.
 */
export function loadBaselineJson(baselinePath: string): Record<string, any> {
  let raw: string;
  try {
    raw = readFileSync(baselinePath, 'utf8');
  } catch (cause) {
    throw new ComparisonInputError(`cannot read baseline file "${baselinePath}": ${(cause as Error).message}. Create one first with the same tool and dataset flags, e.g. node tools/performance-smoke.ts --documents 8 --samples 3 --out baseline.json, then pass --baseline baseline.json`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new ComparisonInputError(`baseline file "${baselinePath}" is not valid JSON: ${(cause as Error).message}. Regenerate the baseline with --out baseline.json`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ComparisonInputError(`baseline file "${baselinePath}" must contain a JSON object produced by the same performance tool`);
  }
  return parsed as Record<string, any>;
}

/**
 * --threshold 플래그의 "metric=ratio" 쌍(쉼표 구분)을 파싱한다. 이 도구가
 * 측정하지 않는 메트릭·중복 메트릭·숫자가 아닌 비율은 ComparisonInputError로
 * 거절한다. allowedMetrics는 도구별 비교 대상 메트릭 목록이다.
 */
export function parseThresholds(text: string, allowedMetrics: readonly string[]): Record<string, number> {
  const thresholds: Record<string, number> = {};
  for (const part of text.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0 || separator === part.length - 1) {
      throw new ComparisonInputError(`invalid --threshold pair "${part}"; expected metric=ratio pairs separated by commas, e.g. --threshold "search=0.25,overview=0.5"`);
    }
    const metric = part.slice(0, separator).trim();
    const ratio = part.slice(separator + 1).trim();
    if (!allowedMetrics.includes(metric)) {
      throw new ComparisonInputError(`unknown threshold metric "${metric}"; this tool measures: ${allowedMetrics.join(', ')}`);
    }
    if (metric in thresholds) {
      throw new ComparisonInputError(`duplicate threshold metric "${metric}"`);
    }
    // 빈 문자열은 Number('')===0으로 조용히 임계값 0이 되므로 명시적으로 거절한다.
    const parsed = ratio === '' ? Number.NaN : Number(ratio);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ComparisonInputError(`threshold ${metric}="${ratio}" is not a finite nonnegative ratio (e.g. 0.25 = allow up to 25% slower)`);
    }
    thresholds[metric] = parsed;
  }
  return thresholds;
}

/** 메트릭 하나의 비교 결과 — baseline·현재 p95/ms 값, 증가율, 적용된 임계값.
 * baseline이 0이고 현재 값이 양수면 증가율은 무한대이므로 JSON에는 null로 기록한다. */
export interface MetricComparison {
  metric: string;
  baseline_ms: number;
  current_ms: number;
  ratio: number | null;
  threshold: number | null;
}

/** 메트릭 값은 단순 ms 숫자이거나 p95_ms를 담은 LatencyMetric이다. */
function metricMs(value: unknown, label: string): number {
  return typeof value === 'number'
    ? validateMetricValue(value, label)
    : validateMetricValue((value as { p95_ms?: unknown } | undefined)?.p95_ms, `${label}.p95_ms`);
}

function formatIncrease(ratio: number): string {
  return Number.isFinite(ratio) ? `+${(ratio * 100).toFixed(1)}%` : 'baseline 0 -> nonzero';
}

/**
 * Baseline과 현재 결과를 비교해 회귀 판정을 돌려준다. 스키마·환경·dataset이
 * 다르면 ComparisonInputError로 거절하고, 임계값을 넘은 메트릭은 regressions에
 * 사람이 읽을 수 있는 메시지로 모은다.
 */
export function compareMetrics(
  baseline: Record<string, any>,
  current: { mode: string; environment: Record<string, any>; dataset: Record<string, any>; metrics: Record<string, unknown> },
  datasetFields: readonly string[],
  metricNames: readonly string[],
  thresholds: Record<string, number>,
): { regressions: string[]; entries: MetricComparison[] } {
  validateBaselineShape(baseline, current.mode);
  assertComparable(baseline, current, datasetFields);
  const regressions: string[] = [];
  const entries: MetricComparison[] = [];
  for (const metric of metricNames) {
    const baselineMs = metricMs((baseline.metrics as Record<string, unknown>)[metric], `baseline.metrics.${metric}`);
    const currentMs = metricMs(current.metrics[metric], `current.metrics.${metric}`);
    const ratio = increaseRatio(currentMs, baselineMs);
    const threshold = thresholds[metric] ?? null;
    if (threshold !== null && ratio > threshold) {
      regressions.push(`${metric}: ${baselineMs.toFixed(3)} -> ${currentMs.toFixed(3)} (${formatIncrease(ratio)} > ${(threshold * 100).toFixed(1)}% allowed)`);
    }
    entries.push({ metric, baseline_ms: baselineMs, current_ms: currentMs, ratio: Number.isFinite(ratio) ? ratio : null, threshold });
  }
  return { regressions, entries };
}

/**
 * Baseline 파일을 로드하고 스키마·mode·environment 호환성까지 검증한다.
 * dataset 필드는 측정 결과가 있어야 비교할 수 있지만, 파일 부재·스키마 오류·
 * 다른 머신의 baseline은 측정 전에 잡아 긴 벤치마크 실행을 낭비하지 않는다.
 */
export function loadValidatedBaseline(
  baselinePath: string,
  expectedMode: string,
  environment: Record<string, any> = currentEnvironment(),
): Record<string, any> {
  const baseline = loadBaselineJson(baselinePath);
  validateBaselineShape(baseline, expectedMode);
  assertEnvironmentComparable(baseline.environment as Record<string, any>, environment);
  return baseline;
}

/** reportCliResult가 요구하는 결과 형태 — 두 성능 도구의 결과 타입이 구조적으로 만족한다. */
interface ComparableResult {
  mode: string;
  environment: Record<string, any>;
  dataset: Record<string, any>;
  metrics: Record<string, unknown>;
}

/**
 * 측정 결과에 baseline 비교를 붙여 stdout과 --out 파일로 보고한다.
 * 비교 입력 오류(호환성·메트릭 값)가 나도 측정 결과는 먼저 보존한 뒤 오류를 다시 던지고,
 * regression은 결과를 출력한 뒤 exit code 1로 보고한다.
 */
export function reportCliResult<T extends ComparableResult>(spec: {
  result: T;
  baseline?: { path: string; data: Record<string, any> };
  thresholds: Record<string, number>;
  datasetFields: readonly string[];
  metricNames: readonly string[];
  outPath?: string;
}): void {
  const { result, baseline, thresholds, datasetFields, metricNames, outPath } = spec;
  let comparison: { baseline: string; regressions: string[]; metrics: MetricComparison[] } | undefined;
  let comparisonError: unknown;
  if (baseline) {
    try {
      const verdict = compareMetrics(baseline.data, result, datasetFields, metricNames, thresholds);
      comparison = { baseline: baseline.path, regressions: verdict.regressions, metrics: verdict.entries };
    } catch (error) {
      comparisonError = error;
    }
  }
  const output = JSON.stringify(comparison ? { ...result, comparison } : result, null, 2);
  if (outPath) { mkdirSync(resolve(outPath, '..'), { recursive: true, mode: 0o700 }); writeFileSync(outPath, `${output}\n`, { mode: 0o600 }); }
  process.stdout.write(`${output}\n`);
  if (comparisonError) throw comparisonError;
  if (comparison && comparison.regressions.length) {
    process.stderr.write(`performance regression detected (${comparison.regressions.length} metric(s) exceeded thresholds):\n  ${comparison.regressions.join('\n  ')}\n`);
    process.exitCode = 1;
  }
}
