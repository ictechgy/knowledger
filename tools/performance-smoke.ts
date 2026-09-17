#!/usr/bin/env node
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { actorIdentity, CHANNEL_ID, PERSONAS, demoDefinition } from '../examples/order-workflow/config.ts';
import { seedDemo } from '../examples/order-workflow/application.ts';
import { compareMetrics, ComparisonInputError, loadBaselineJson, parseThresholds } from './perf-compare.ts';
import type { Actor } from '../packages/storage/local-ledger.ts';

const MAX_DOCUMENTS = 100_000;
const MAX_SAMPLES = 1_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SLOT_GROUPS = 256;
const DEFAULT_DOCUMENTS = 8;
const DEFAULT_SAMPLES = 3;
const DEFAULT_BODY_BYTES = 1024;
const SEARCH_QUERIES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;
const COLD_CACHE_QUERY = 'cold-cache-probe';

export interface PerformanceSmokeOptions {
  dataDir: string;
  documents?: number;
  samples?: number;
  bodyBytes?: number;
  slotGroups?: number;
}

export interface PerformanceSmokeResult {
  schema_version: 1;
  mode: 'local-simulation';
  environment: { node: string; platform: string; arch: string; cpu_count: number };
  dataset: { documents_requested: number; body_bytes: number; samples: number; slot_groups: number; marker: string; read_workload: 'all_pages_summary'; search_queries: readonly string[]; search_probes: 'single_marker' | 'multi_query' };
  metrics: {
    publish: LatencyMetric;
    search: LatencyMetric;
    search_warm: LatencyMetric;
    search_cold: LatencyMetric;
    overview: LatencyMetric;
    replay_restart_ms: number;
    database_bytes: number;
  };
  functional_assertions: {
    documents_generated: number;
    documents_retrieved: number;
    search_matches: number;
    search_query_matches: Record<string, number>;
    cold_search_matches: number;
    replay_documents_retrieved: number;
    replay_search_matches: number;
  };
  assessment: { functional_pass: true; performance: 'measurement_only'; fabric_sla_proven: false };
}

export interface LatencyMetric { samples: number; p50_ms: number; p95_ms: number; max_ms: number }

const actor = actorIdentity(PERSONAS[1]);
export const marker = 'performance-smoke-marker';

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside the allowed range`);
  return value;
}

export function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

export function latency(values: number[]): LatencyMetric {
  return { samples: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Math.max(...values, 0) };
}

export function bodyFor(index: number, bytes: number): string {
  const prefix = `# Synthetic document ${index}\n\n${marker}\n`;
  if (bytes <= prefix.length) return prefix.slice(0, bytes);
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'));
}

export function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += directoryBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

function validateOptions(options: PerformanceSmokeOptions): Required<PerformanceSmokeOptions> {
  if (!isAbsolute(options.dataDir)) throw new Error('dataDir must be absolute');
  return {
    dataDir: resolve(options.dataDir),
    documents: boundedInteger(options.documents ?? DEFAULT_DOCUMENTS, 'documents', 1, MAX_DOCUMENTS),
    samples: boundedInteger(options.samples ?? DEFAULT_SAMPLES, 'samples', 1, MAX_SAMPLES),
    bodyBytes: boundedInteger(options.bodyBytes ?? DEFAULT_BODY_BYTES, 'bodyBytes', 1, MAX_BODY_BYTES),
    slotGroups: boundedInteger(options.slotGroups ?? 1, 'slotGroups', 1, MAX_SLOT_GROUPS),
  };
}

/** Measure the complete paginated traversal, including every returned summary. */
export async function browseAll(service: KnowledgerService, searching = false, query = marker): Promise<any[]> {
  const rows: any[] = []; let cursor: string | undefined;
  do {
    const page = searching ? await service.search(actor, { query, limit: 50, cursor }) : await service.overview(actor, { limit: 50, cursor });
    rows.push(...('results' in page ? page.results : page.documents));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return rows;
}

/** 단일 합성 문서를 초안→검토→게시까지 수행한다. slotGroups>1이면 scope를 순환시켜 슬롯을 섞는다. */
export async function generateSyntheticDocument(service: KnowledgerService, index: number, options: { documents: number; bodyBytes: number; slotGroups: number }): Promise<void> {
  const group = options.slotGroups > 1 ? 1 + (index % options.slotGroups) : undefined;
  const draft = await service.draft(actor, {
    title: `${marker} synthetic performance document ${index}`,
    body_markdown: bodyFor(index, options.bodyBytes),
    context_id: 'context-fulfillment',
    scope_id: group === undefined ? 'scope-order-2026-001' : `scope-perf-${String(group).padStart(3, '0')}`,
    usage_scope: 'domain-definition/v1',
    document_id: `doc-performance-${index}`,
  });
  const preview = await service.preview(actor, { draft_id: draft.draft_id });
  const receipt = await service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `performance-publish-${index}` });
  if (receipt.status !== 'committed') throw new Error('synthetic publication did not commit');
}

function isPerformanceDocument(item: any): boolean {
  return typeof item?.payload?.document_id === 'string' && item.payload.document_id.startsWith('doc-performance-');
}

/** 복수 검색어 샘플의 실제 결과 수를 측정해 돌려준다. 각 검색어는 전체 페이지를 순회한다. */
async function measureSearchQueryMatches(service: KnowledgerService): Promise<Record<string, number>> {
  const matches: Record<string, number> = {};
  for (const query of SEARCH_QUERIES) {
    let rows: any[];
    try {
      rows = await browseAll(service, true, query);
    } catch (cause) {
      throw new Error(`search query "${query}" failed: ${(cause as Error).message}`);
    }
    matches[query] = rows.length;
  }
  return matches;
}

export async function runPerformanceSmoke(input: PerformanceSmokeOptions): Promise<PerformanceSmokeResult> {
  const options = validateOptions(input);
  if (existsSync(options.dataDir)) {
    if (readdirSync(options.dataDir).length !== 0) throw new Error('dataDir must be a new or empty directory');
  } else mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const ledgerPath = join(options.dataDir, 'shared-ledger.sqlite');
  const vaultPath = join(options.dataDir, 'private-local.sqlite');
  let ledger = new LocalLedger(ledgerPath, CHANNEL_ID);
  let vault = new PrivateStore(vaultPath);
  const definition = demoDefinition();
  let service = new KnowledgerService(ledger, vault, definition);
  const publishTimes: number[] = [];
  const searchTimes: number[] = [];
  const searchWarmTimes: number[] = [];
  const searchColdTimes: number[] = [];
  const overviewTimes: number[] = [];
  let searchQueryMatches: Record<string, number> = {};
  let coldSearchMatches = 0;
  try {
    await service.initialize();
    await seedDemo(service);
    for (let index = 0; index < options.documents; index += 1) {
      const started = performance.now();
      await generateSyntheticDocument(service, index, options);
      publishTimes.push(performance.now() - started);
    }

    let overview = await browseAll(service);
    const generated = overview.filter(isPerformanceDocument);
    if (generated.length !== options.documents) throw new Error('generated document count mismatch');
    for (let sample = 0; sample < options.samples; sample += 1) {
      let started = performance.now();
      const search = await browseAll(service, true);
      searchTimes.push(performance.now() - started);
      if (search.length !== options.documents) throw new Error('search result count mismatch');
      started = performance.now();
      overview = await browseAll(service);
      overviewTimes.push(performance.now() - started);
      if (overview.filter(isPerformanceDocument).length !== options.documents) throw new Error('overview result count mismatch');
    }

    // 동일 체크포인트에서 복수 검색어를 재검색한다 — warm 캐시 경로의 실제 결과 수를 검증한다.
    const warmOverview = await browseAll(service);
    searchQueryMatches = await measureSearchQueryMatches(service);
    for (let sample = 0; sample < options.samples; sample += 1) {
      const started = performance.now();
      const search = await browseAll(service, true);
      searchWarmTimes.push(performance.now() - started);
      if (search.length !== warmOverview.filter(isPerformanceDocument).length) throw new Error('warm search result count mismatch');
    }

    // cold 측정: 검색 매치 캐시는 서비스 인스턴스별이므로 샘플마다 새 서비스를 만들어
    // 모든 샘플이 실제 cache-miss 전체 스캔을 측정한다. 캐시 내부를 건드리지 않고
    // 재생이 완료된 동일 원장 상태만 재사용한다 — initialize()는 열린 원장의 tail
    // 확인과 구성 검사뿐이라 저널 재생 없이 가볍다.
    const probeService = new KnowledgerService(ledger, vault, definition);
    await probeService.initialize();
    const coldProbe = await browseAll(probeService, true, COLD_CACHE_QUERY);
    if (coldProbe.length !== 0) throw new Error('cold cache probe unexpectedly matched documents');
    for (let sample = 0; sample < options.samples; sample += 1) {
      const coldService = new KnowledgerService(ledger, vault, definition);
      await coldService.initialize();
      const started = performance.now();
      const search = await browseAll(coldService, true);
      searchColdTimes.push(performance.now() - started);
      if (search.length !== options.documents) throw new Error('cold search result count mismatch');
      coldSearchMatches = search.length;
    }

    const databaseBytesBeforeReplay = directoryBytes(options.dataDir);
    ledger.close();
    vault.close();
    const replayStarted = performance.now();
    ledger = new LocalLedger(ledgerPath, CHANNEL_ID);
    vault = new PrivateStore(vaultPath);
    service = new KnowledgerService(ledger, vault, definition);
    await service.initialize();
    const replayRestartMs = performance.now() - replayStarted;
    const replayOverview = await browseAll(service);
    const replaySearch = await browseAll(service, true);
    const replayDocuments = replayOverview.filter(isPerformanceDocument).length;
    if (replayDocuments !== options.documents || replaySearch.length !== options.documents) throw new Error('replay result count mismatch');
    return {
      schema_version: 1,
      mode: 'local-simulation',
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpu_count: cpus().length },
      dataset: { documents_requested: options.documents, body_bytes: options.bodyBytes, samples: options.samples, slot_groups: options.slotGroups, marker, read_workload: 'all_pages_summary', search_queries: [...SEARCH_QUERIES], search_probes: 'multi_query' },
      metrics: { publish: latency(publishTimes), search: latency(searchTimes), search_warm: latency(searchWarmTimes), search_cold: latency(searchColdTimes), overview: latency(overviewTimes), replay_restart_ms: replayRestartMs, database_bytes: databaseBytesBeforeReplay },
      functional_assertions: {
        documents_generated: generated.length,
        documents_retrieved: overview.filter(isPerformanceDocument).length,
        search_matches: options.documents,
        search_query_matches: searchQueryMatches,
        cold_search_matches: coldSearchMatches,
        replay_documents_retrieved: replayDocuments,
        replay_search_matches: replaySearch.length,
      },
      assessment: { functional_pass: true, performance: 'measurement_only', fabric_sla_proven: false },
    };
  } finally {
    try { ledger.close(); } catch { /* preserve the first failure */ }
    try { vault.close(); } catch { /* preserve the first failure */ }
  }
}

function parseCli(args: string[]): { options: PerformanceSmokeOptions; out?: string; ownedData: boolean; baselinePath?: string; thresholdText?: string } {
  const known = new Set(['--data', '--documents', '--samples', '--body-bytes', '--slot-groups', '--baseline', '--threshold', '--out']);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!known.has(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid option');
    values.set(name, value);
  }
  const data = values.has('--data') ? resolve(values.get('--data')!) : undefined;
  const out = values.has('--out') ? resolve(values.get('--out')!) : undefined;
  if (!data) mkdirSync(resolve('.data'),{recursive:true,mode:0o700});
  const ownedData = !data;
  const dataDir = data ?? mkdtempSync(join(resolve('.data'), 'performance-smoke-'));
  const number = (name: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : Number(value);
  };
  return { options: { dataDir, documents: number('--documents'), samples: number('--samples'), bodyBytes: number('--body-bytes'), slotGroups: number('--slot-groups') }, out, ownedData, baselinePath: values.get('--baseline'), thresholdText: values.get('--threshold') };
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

const COMPARABLE_DATASET_FIELDS = ['documents_requested', 'body_bytes', 'samples', 'slot_groups', 'read_workload', 'search_probes'] as const;
const COMPARABLE_METRICS = ['publish', 'search', 'search_warm', 'search_cold', 'overview', 'replay_restart_ms'] as const;

if (isMain()) {
  let dataDir: string | undefined;
  let ownedData = false;
  try {
    const parsed = parseCli(process.argv.slice(2));
    dataDir = parsed.options.dataDir;
    ownedData = parsed.ownedData;
    const thresholds = parsed.thresholdText ? parseThresholds(parsed.thresholdText, COMPARABLE_METRICS) : {};
    if (parsed.thresholdText && !parsed.baselinePath) throw new ComparisonInputError('--threshold requires --baseline <file>; thresholds only apply when comparing against a baseline result');
    const result = await runPerformanceSmoke(parsed.options);
    let comparison: { baseline: string; regressions: string[]; metrics: { metric: string; baseline_ms: number; current_ms: number; ratio: number; threshold: number | null }[] } | undefined;
    if (parsed.baselinePath) {
      const verdict = compareMetrics(loadBaselineJson(parsed.baselinePath), result, COMPARABLE_DATASET_FIELDS, COMPARABLE_METRICS, thresholds);
      comparison = { baseline: parsed.baselinePath, regressions: verdict.regressions, metrics: verdict.entries };
    }
    const output = JSON.stringify(comparison ? { ...result, comparison } : result, null, 2);
    if (parsed.out) { mkdirSync(resolve(parsed.out, '..'), { recursive: true, mode: 0o700 }); writeFileSync(parsed.out, `${output}\n`, { mode: 0o600 }); }
    process.stdout.write(`${output}\n`);
    if (comparison && comparison.regressions.length) {
      process.stderr.write(`performance regression detected (${comparison.regressions.length} metric(s) exceeded thresholds):\n  ${comparison.regressions.join('\n  ')}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const guidance = error instanceof ComparisonInputError ? '' : ' (input validation or local measurement — check --documents/--samples/--body-bytes ranges and that --data is a new empty directory)';
    process.stderr.write(`performance smoke failed: ${detail}${guidance}\n`);
    process.exitCode = 1;
  } finally {
    if (ownedData && dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}
