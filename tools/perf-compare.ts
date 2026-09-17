#!/usr/bin/env node
/**
 * 성능 결과 비교 헬퍼. performance-smoke와 performance-fabric이 공유하는
 * baseline 로드·검증·호환성 검사·임계값 비교 로직이다. 비교 불가능 조건
 * (mode/environment/dataset 불일치)은 명확한 오류로 거절하고, regression은
 * 임계값 대비 명시적 비율로 판정한다.
 */

import { readFileSync } from 'node:fs';

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
 * environment, dataset, metrics가 없으면 비교가 불가능하다.
 */
export function validateBaselineShape(baseline: unknown, expectedMode: string): void {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) {
    throw new ComparisonInputError('baseline must be a JSON object produced by the same performance tool');
  }
  const record = baseline as Record<string, unknown>;
  if (record.schema_version !== 1) {
    throw new ComparisonInputError(`baseline schema_version ${JSON.stringify(record.schema_version)} is not supported (expected 1); regenerate the baseline with the same tool version`);
  }
  if (record.mode !== expectedMode) {
    throw new ComparisonInputError(`baseline mode ${JSON.stringify(record.mode)} does not match this run's mode ${JSON.stringify(expectedMode)}; use a baseline produced by the same tool`);
  }
  for (const section of ['environment', 'dataset', 'metrics', 'functional_assertions'] as const) {
    if (!record[section] || typeof record[section] !== 'object' || Array.isArray(record[section])) {
      throw new ComparisonInputError(`baseline is missing the "${section}" section; regenerate the baseline with the same tool`);
    }
  }
  for (const field of ['node', 'platform', 'arch', 'cpu_count'] as const) {
    if (typeof (record.environment as Record<string, unknown>)[field] !== 'string' && typeof (record.environment as Record<string, unknown>)[field] !== 'number') {
      throw new ComparisonInputError(`baseline environment.${field} is missing or invalid; regenerate the baseline with the same tool`);
    }
  }
  if (!Number.isFinite((record.environment as Record<string, unknown>).cpu_count)) {
    throw new ComparisonInputError('baseline environment.cpu_count must be a finite number');
  }
}

/**
 * 특정 메트릭 값의 유효성을 검증한다. 비교와 판정은 유한한 음수가 아닌 수에서만 의미가 있다.
 */
export function validateMetricValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ComparisonInputError(`baseline metric ${label} must be a finite nonnegative number, got ${JSON.stringify(value)}; regenerate the baseline`);
  }
  return value;
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
  const baselineEnvironment = baseline.environment as Record<string, any>;
  const baselineDataset = baseline.dataset as Record<string, any>;
  const mismatches: string[] = [];
  if (baselineEnvironment.node !== current.environment.node) mismatches.push(`node ${baselineEnvironment.node} -> ${current.environment.node}`);
  if (baselineEnvironment.platform !== current.environment.platform) mismatches.push(`platform ${baselineEnvironment.platform} -> ${current.environment.platform}`);
  if (baselineEnvironment.arch !== current.environment.arch) mismatches.push(`arch ${baselineEnvironment.arch} -> ${current.environment.arch}`);
  if (baselineEnvironment.cpu_count !== current.environment.cpu_count) mismatches.push(`cpu_count ${baselineEnvironment.cpu_count} -> ${current.environment.cpu_count}`);
  for (const field of datasetFields) {
    if (!current.dataset || !(field in current.dataset)) {
      throw new ComparisonInputError(`current result is missing dataset.${field}; this tool version is incompatible with the baseline`);
    }
    if (baselineDataset[field] !== current.dataset[field]) {
      mismatches.push(`dataset.${field} ${JSON.stringify(baselineDataset[field])} -> ${JSON.stringify(current.dataset[field])}`);
    }
  }
  if (mismatches.length) {
    throw new ComparisonInputError(`baseline is not comparable with this run — same mode, environment, and dataset are required. Differences: ${mismatches.join('; ')}. Re-measure the baseline on this machine with the same dataset flags.`);
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
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new ComparisonInputError(`baseline file "${baselinePath}" is not valid JSON: ${(cause as Error).message}. Regenerate the baseline with --out baseline.json`);
  }
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
    const parsed = Number(ratio);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new ComparisonInputError(`threshold ${metric}="${ratio}" is not a finite nonnegative ratio (e.g. 0.25 = allow up to 25% slower)`);
    }
    thresholds[metric] = parsed;
  }
  return thresholds;
}

/** 메트릭 하나의 비교 결과 — baseline·현재 p95/ms 값, 증가율, 적용된 임계값. */
export interface MetricComparison {
  metric: string;
  baseline_ms: number;
  current_ms: number;
  ratio: number;
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
    const baselineMs = metricMs((baseline.metrics as Record<string, unknown>)[metric], `metrics.${metric}`);
    const currentMs = metricMs(current.metrics[metric], `metrics.${metric}`);
    const ratio = increaseRatio(currentMs, baselineMs);
    const threshold = thresholds[metric] ?? null;
    if (threshold !== null && ratio > threshold) {
      regressions.push(`${metric}: ${baselineMs.toFixed(3)} -> ${currentMs.toFixed(3)} (${formatIncrease(ratio)} > ${(threshold * 100).toFixed(1)}% allowed)`);
    }
    entries.push({ metric, baseline_ms: baselineMs, current_ms: currentMs, ratio, threshold });
  }
  return { regressions, entries };
}
