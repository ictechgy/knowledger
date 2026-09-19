#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { actorIdentity, CHANNEL_ID, PERSONAS, demoDefinition } from '../examples/order-workflow/config.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../packages/storage/runtime-snapshot.ts';

/**
 * Two-administrative-domain failure drill. Two independent worker processes —
 * separate roots, processes and databases — model two independently
 * administered hosts. One is force-killed mid-operation; the other must keep
 * its verified state untouched, and the killed domain must recover from an
 * offline snapshot. The evidence record states plainly that these are
 * process/filesystem boundaries on one machine, not physical hosts.
 */

export interface MultiHostDrillResult {
  schema_version: 1;
  drill: 'two-administrative-domains';
  environment: { node: string; platform: string; arch: string };
  boundaries: { physical_hosts: false; administrative_boundary: 'process+filesystem'; fabric_channel_independence_proven: false };
  functional_assertions: {
    peer_unaffected_by_kill: true;
    peer_graceful_stop_clean: true;
    killed_domain_wal_recovery: true;
    killed_domain_snapshot_restore: true;
  };
  assessment: { drill_pass: true };
  /** 실행을 특정하는 증거 — pid, 신호, WAL 크기, 복구된 체크포인트·저널 수를 묶는다. */
  details: {
    host_a: { pid: number | null; kill_signal: 'SIGKILL'; wal_sidecar_bytes: number; recovered_checkpoint: string; recovered_journal_events: number };
    host_b: { pid: number | null; exit_code: number | null };
    restored_checkpoint: string;
  };
}

/** 워커가 준비 신호로 출력하는 계약 — readiness 플래그와 기준 체크포인트·저널 수를 담는다. */
interface WorkerReadiness { ready: true; draft_id: string; preview_id: string; command_id: string; checkpoint: { transaction_id?: string }; event_count: number }

interface ReadyWorker { child: ChildProcess; stderrTail: () => string; ready: WorkerReadiness }

/** 자식 프로세스의 종료를 한 번 기다린다 — 이미 종료됐으면 즉시 돌아온다. */
function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('drill worker exit timeout')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** 독립 데이터 디렉터리로 워커 프로세스를 띄워 준비 신호까지 기다린다 — stderr는 실패 진단용으로 꼬리를 남긴다. */
async function startWorker(dataDir: string, extraArgs: string[] = []): Promise<ReadyWorker> {
  const worker = fileURLToPath(new URL('./testing/resilience-worker.ts', import.meta.url));
  const child = spawn(process.execPath, [worker, '--data', dataDir, ...extraArgs], { cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.setEncoding('utf8');
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
  let ready: ReadyWorker['ready'];
  try {
    ready = await new Promise<ReadyWorker['ready']>((resolveReady, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('drill worker timeout')), 15_000);
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0) return;
        try { resolveReady(JSON.parse(buffer.slice(0, lineEnd))); clearTimeout(timer); }
        catch { clearTimeout(timer); reject(new Error('drill worker produced invalid readiness output')); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`drill worker exited before readiness: ${stderr.slice(-400)}`)); });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  } finally {
    child.stdout!.removeAllListeners('data');
  }
  if (ready?.ready !== true || typeof ready.checkpoint?.transaction_id !== 'string') { child.kill('SIGKILL'); throw new Error('drill worker readiness contract failed'); }
  return { child, ready, stderrTail: () => stderr };
}

interface RecoveredState { checkpoint_tx_id: string; event_count: number }

/** 데이터 디렉터리를 열어 복구된 상태를 판독한다 — 기대값 비교는 호출부가 모드를 정한다. */
async function readRecoveredState(dataDir: string, label: string): Promise<RecoveredState> {
  const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
  try {
    const service = new KnowledgerService(ledger, vault, demoDefinition());
    await service.initialize();
    const checkpoint = ledger.checkpoint();
    if (typeof checkpoint?.transaction_id !== 'string') throw new Error(`${label} checkpoint missing`);
    const overview = await service.overview(actorIdentity(PERSONAS[1]));
    if (overview.documents.filter((item: { payload: { document_id?: string } }) => item.payload.document_id === 'doc-resilience-smoke-001').length !== 1) throw new Error(`${label} document missing`);
    return { checkpoint_tx_id: checkpoint.transaction_id, event_count: ledger.events(0, 1000).length };
  } finally {
    ledger.close();
    vault.close();
  }
}

export async function runMultiHostDrill(rootDir: string): Promise<MultiHostDrillResult> {
  if (!isAbsolute(rootDir)) throw new Error('rootDir must be absolute');
  const root = resolve(rootDir);
  if (existsSync(root) && readdirSync(root).length !== 0) throw new Error('rootDir must be a new or empty directory');
  mkdirSync(root, { recursive: true, mode: 0o700 });

  const hostA = join(root, 'host-a');
  const hostB = join(root, 'host-b');
  const workers: ChildProcess[] = [];
  try {
    // Host A keeps committing real writes so the kill lands mid-operation.
    const a = await startWorker(hostA, ['--write-every', '25']);
    workers.push(a.child);
    const b = await startWorker(hostB);
    workers.push(b.child);

    // Host A fails hard mid-operation — no graceful shutdown.
    const aExit = onceExit(a.child);
    a.child.kill('SIGKILL');
    await aExit;

    // Host B must be unaffected: still running, then a clean graceful stop —
    // exit code 0 with no signal is the only acceptable graceful termination.
    if (b.child.exitCode !== null || b.child.signalCode !== null) throw new Error('peer domain died with its neighbour');
    const bExit = onceExit(b.child);
    b.child.kill('SIGTERM');
    await bExit;
    if (b.child.exitCode !== 0 || b.child.signalCode !== null) throw new Error(`peer domain did not stop gracefully (exit=${b.child.exitCode} signal=${b.child.signalCode}): ${b.stderrTail().slice(-200)}`);
    const peerState = await readRecoveredState(hostB, 'peer domain after neighbour kill');
    if (peerState.checkpoint_tx_id !== b.ready.checkpoint.transaction_id || peerState.event_count !== b.ready.event_count) throw new Error('peer domain state drifted during neighbour kill');

    // The kill must leave uncheckpointed WAL content — without a sidecar the
    // WAL-replay claim is unproven.
    const walPath = join(hostA, 'shared-ledger.sqlite-wal');
    const walBytes = existsSync(walPath) ? statSync(walPath).size : -1;
    if (walBytes <= 0) throw new Error('killed domain left no WAL sidecar — WAL recovery is unproven');

    // The killed domain recovers through SQLite WAL replay: the journal may
    // advance past readiness because the write loop kept committing, but it
    // must never lose committed entries.
    const walState = await readRecoveredState(hostA, 'killed domain after WAL recovery');
    if (walState.event_count < a.ready.event_count) throw new Error('WAL recovery lost committed journal entries');

    // An offline snapshot restores into a brand-new directory with the same
    // replayed state — compared against the recovered state, not readiness.
    const snapshotDir = join(root, 'host-a-snapshot');
    const restoredDir = join(root, 'host-a-restored');
    createRuntimeSnapshot({ dataDir: hostA, snapshotDir });
    restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
    const restoredState = await readRecoveredState(restoredDir, 'killed domain after snapshot restore');
    if (restoredState.checkpoint_tx_id !== walState.checkpoint_tx_id || restoredState.event_count !== walState.event_count) throw new Error('restored state differs from recovered state');

    return {
      schema_version: 1,
      drill: 'two-administrative-domains',
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      boundaries: { physical_hosts: false, administrative_boundary: 'process+filesystem', fabric_channel_independence_proven: false },
      functional_assertions: {
        peer_unaffected_by_kill: true, peer_graceful_stop_clean: true,
        killed_domain_wal_recovery: true, killed_domain_snapshot_restore: true,
      },
      assessment: { drill_pass: true },
      details: {
        host_a: { pid: a.child.pid ?? null, kill_signal: 'SIGKILL', wal_sidecar_bytes: walBytes, recovered_checkpoint: walState.checkpoint_tx_id, recovered_journal_events: walState.event_count },
        host_b: { pid: b.child.pid ?? null, exit_code: b.child.exitCode },
        restored_checkpoint: restoredState.checkpoint_tx_id,
      },
    };
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await onceExit(child).catch(() => undefined); }
    }
  }
}

function isMain(): boolean { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }

if (isMain()) {
  let rootDir: string | undefined;
  let ownedRoot = false;
  try {
    const args = process.argv.slice(2);
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {
      const name = args[index];
      const value = args[index + 1];
      if (!['--root', '--out'].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid option');
      values.set(name, value);
    }
    const root = values.has('--root') ? resolve(values.get('--root')!) : undefined;
    const out = values.has('--out') ? resolve(values.get('--out')!) : undefined;
    if (!root) mkdirSync(resolve('.data'), { recursive: true, mode: 0o700 });
    rootDir = root ?? mkdtempSync(join(resolve('.data'), 'multi-host-drill-'));
    ownedRoot = !root;
    const result = await runMultiHostDrill(rootDir);
    const output = JSON.stringify(result, null, 2);
    if (out) { mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 }); writeFileSync(out, `${output}\n`, { mode: 0o600 }); }
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`multi-host drill failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (ownedRoot && rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
}
