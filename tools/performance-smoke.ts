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
import type { Actor } from '../packages/storage/local-ledger.ts';

const MAX_DOCUMENTS = 10_000;
const MAX_SAMPLES = 1_000;
const MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_DOCUMENTS = 8;
const DEFAULT_SAMPLES = 3;
const DEFAULT_BODY_BYTES = 1024;

export interface PerformanceSmokeOptions {
  dataDir: string;
  documents?: number;
  samples?: number;
  bodyBytes?: number;
}

export interface PerformanceSmokeResult {
  schema_version: 1;
  mode: 'local-simulation';
  environment: { node: string; platform: string; arch: string; cpu_count: number };
  dataset: { documents_requested: number; body_bytes: number; samples: number; marker: string; read_workload: 'all_pages_summary' };
  metrics: {
    publish: LatencyMetric;
    search: LatencyMetric;
    overview: LatencyMetric;
    replay_restart_ms: number;
    database_bytes: number;
  };
  functional_assertions: {
    documents_generated: number;
    documents_retrieved: number;
    search_matches: number;
    replay_documents_retrieved: number;
    replay_search_matches: number;
  };
  assessment: { functional_pass: true; performance: 'measurement_only'; fabric_sla_proven: false };
}

interface LatencyMetric { samples: number; p50_ms: number; p95_ms: number; max_ms: number }

const actor = actorIdentity(PERSONAS[1]);
const marker = 'performance-smoke-marker';

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside the allowed range`);
  return value;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function latency(values: number[]): LatencyMetric {
  return { samples: values.length, p50_ms: percentile(values, 0.5), p95_ms: percentile(values, 0.95), max_ms: Math.max(...values, 0) };
}

function bodyFor(index: number, bytes: number): string {
  const prefix = `# Synthetic document ${index}\n\n${marker}\n`;
  if (bytes <= prefix.length) return prefix.slice(0, bytes);
  return prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix, 'utf8'));
}

function directoryBytes(directory: string): number {
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
  };
}

/** Measure the complete paginated traversal, including every returned summary. */
async function browseAll(service: KnowledgerService, searching = false): Promise<any[]> {
  const rows: any[] = []; let cursor: string | undefined;
  do {
    const page = searching ? await service.search(actor, { query: marker, limit: 50, cursor }) : await service.overview(actor, { limit: 50, cursor });
    rows.push(...('results' in page ? page.results : page.documents));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return rows;
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
  const overviewTimes: number[] = [];
  try {
    await service.initialize();
    await seedDemo(service);
    for (let index = 0; index < options.documents; index += 1) {
      const started = performance.now();
      const draft = await service.draft(actor, {
        title: `${marker} synthetic performance document ${index}`,
        body_markdown: bodyFor(index, options.bodyBytes),
        context_id: 'context-fulfillment',
        scope_id: 'scope-order-2026-001',
        usage_scope: 'domain-definition/v1',
        document_id: `doc-performance-${index}`,
      });
      const preview = await service.preview(actor, { draft_id: draft.draft_id });
      const receipt = await service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: `performance-publish-${index}` });
      if (receipt.status !== 'committed') throw new Error('synthetic publication did not commit');
      publishTimes.push(performance.now() - started);
    }

    let overview = await browseAll(service);
    const generated = overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-'));
    if (generated.length !== options.documents) throw new Error('generated document count mismatch');
    for (let sample = 0; sample < options.samples; sample += 1) {
      let started = performance.now();
      const search = await browseAll(service, true);
      searchTimes.push(performance.now() - started);
      if (search.length !== options.documents) throw new Error('search result count mismatch');
      started = performance.now();
      overview = await browseAll(service);
      overviewTimes.push(performance.now() - started);
      if (overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length !== options.documents) throw new Error('overview result count mismatch');
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
    const replayDocuments = replayOverview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length;
    if (replayDocuments !== options.documents || replaySearch.length !== options.documents) throw new Error('replay result count mismatch');
    return {
      schema_version: 1,
      mode: 'local-simulation',
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpu_count: cpus().length },
      dataset: { documents_requested: options.documents, body_bytes: options.bodyBytes, samples: options.samples, marker, read_workload: 'all_pages_summary' },
      metrics: { publish: latency(publishTimes), search: latency(searchTimes), overview: latency(overviewTimes), replay_restart_ms: replayRestartMs, database_bytes: databaseBytesBeforeReplay },
      functional_assertions: {
        documents_generated: generated.length,
        documents_retrieved: overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length,
        search_matches: options.documents,
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

function parseCli(args: string[]): { options: PerformanceSmokeOptions; out?: string; ownedData: boolean } {
  const known = new Set(['--data', '--documents', '--samples', '--body-bytes', '--out']);
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
  return { options: { dataDir, documents: number('--documents'), samples: number('--samples'), bodyBytes: number('--body-bytes') }, out, ownedData };
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  let dataDir: string | undefined;
  let ownedData = false;
  try {
    const parsed = parseCli(process.argv.slice(2));
    dataDir = parsed.options.dataDir;
    ownedData = parsed.ownedData;
    const result = await runPerformanceSmoke(parsed.options);
    const output = JSON.stringify(result, null, 2);
    if (parsed.out) { mkdirSync(resolve(parsed.out, '..'), { recursive: true, mode: 0o700 }); writeFileSync(parsed.out, `${output}\n`, { mode: 0o600 }); }
    process.stdout.write(`${output}\n`);
  } catch {
    process.stderr.write('performance smoke failed: invalid input or local measurement failure\n');
    process.exitCode = 1;
  } finally {
    if (ownedData && dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}
