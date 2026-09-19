#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /** 실행을 특정하는 증거 — pid, 신호, WAL 크기, 복구된 체크포인트·저널 수·다이제스트를 묶는다. */
  details: {
    host_a: { pid: number | null; kill_signal: 'SIGKILL'; wal_sidecar_bytes: number; writes_begun: number; commits_acknowledged: number; in_flight_interrupted: number; main_db_only_events: number; recovered_checkpoint: string; recovered_journal_events: number; recovered_journal_digest: string };
    host_b: { pid: number | null; exit_code: number | null; journal_digest: string };
    restored_checkpoint: string; restored_journal_digest: string;
  };
}

/** 워커가 준비 신호로 출력하는 계약 — readiness 플래그와 기준 체크포인트·저널·초안 다이제스트를 담는다. */
interface WorkerReadiness { ready: true; draft_id: string; preview_id: string; command_id: string; checkpoint: { transaction_id?: string }; event_count: number; journal_digest: string; drafts_digest: string }

interface ReadyWorker { child: ChildProcess; stderrTail: () => string; ready: WorkerReadiness; commits: string[]; counts: { begins: number }; stdoutDone: Promise<void> }

/** 자식 프로세스의 종료를 한 번 기다린다 — 이미 종료됐으면 즉시 돌아온다. */
function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('drill worker exit timeout')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

/** 자식을 강제 종료하고 종료를 확인한다 — 어떤 실패 경로도 실행 중인 자식을 남기지 않는다. */
async function killAndReap(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  await onceExit(child);
}

/** 독립 데이터 디렉터리로 워커 프로세스를 띄워 준비 신호까지 기다린다 — 자식은 spawn 직후 workers에 등록되고, stdout 라인의 begin/commit 승인은 계속 모은다. */
async function startWorker(workers: ChildProcess[], dataDir: string, extraArgs: string[] = []): Promise<ReadyWorker> {
  const worker = fileURLToPath(new URL('./testing/resilience-worker.ts', import.meta.url));
  const child = spawn(process.execPath, [worker, '--data', dataDir, ...extraArgs], { cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  workers.push(child);
  child.stdout!.setEncoding('utf8');
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2048); });
  const commits: string[] = [];
  const state = { begins: 0 };
  let buffer = '';
  let settled = false;
  let readyResolve: (ready: WorkerReadiness) => void;
  let readyReject: (error: Error) => void;
  const readiness = new Promise<WorkerReadiness>((res, rej) => { readyResolve = res; readyReject = rej; });
  const stdoutDone = new Promise<void>(resolveDone => child.stdout!.once('end', resolveDone));
  const timer = setTimeout(() => readyReject(new Error('drill worker timeout')), 15_000);
  child.stdout!.on('data', (chunk: string) => {
    buffer += chunk;
    let lineEnd: number;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd);
      buffer = buffer.slice(lineEnd + 1);
      if (!line.trim()) continue;
      let message: { ready?: boolean; begin?: unknown; commit?: unknown };
      try { message = JSON.parse(line); } catch { if (!settled) { settled = true; readyReject(new Error('drill worker produced invalid readiness output')); } continue; }
      if (!settled) { settled = true; readyResolve(message as WorkerReadiness); continue; }
      if (typeof message.commit === 'string') commits.push(message.commit);
      else if (typeof message.begin === 'number') state.begins += 1;
    }
  });
  child.once('error', error => { if (!settled) { settled = true; readyReject(error); } });
  child.once('exit', () => { if (!settled) { settled = true; readyReject(new Error(`drill worker exited before readiness: ${stderr.slice(-400)}`)); } });
  try {
    const ready = await readiness;
    if (ready?.ready !== true || typeof ready.checkpoint?.transaction_id !== 'string' || typeof ready.journal_digest !== 'string' || typeof ready.drafts_digest !== 'string') throw new Error('drill worker readiness contract failed');
    return { child, ready, stderrTail: () => stderr, commits, counts: state, stdoutDone };
  } catch (error) {
    try { await killAndReap(child); } catch (reapError) { process.stderr.write(`drill worker reap failed: ${reapError instanceof Error ? reapError.message : String(reapError)}\n`); }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

interface RecoveredState { checkpoint_tx_id: string; event_count: number; journal_digest: string; drafts_digest: string; transaction_ids: string[] }

/** 저널·초안 내용을 해시로 고정한다 — 개수만 비교하면 내용 손상을 놓친다. */
function contentDigest(rows: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

/** 저널 전체를 페이지로 읽는다 — 첫 페이지만 보면 잘린 이력을 다이제스트가 놓친다. */
function readAllEvents(ledger: LocalLedger): ReturnType<LocalLedger['events']> {
  const all: ReturnType<LocalLedger['events']> = [];
  let after = 0;
  for (;;) {
    const page = ledger.events(after, 1000);
    all.push(...page);
    if (page.length < 1000) return all;
    after = page[page.length - 1].checkpoint.block_number;
  }
}

/** 초안 다이제스트 전체를 페이지로 읽는다 — 첫 페이지만 비교하면 초안 손상을 놓친다. */
async function readAllDraftDigests(service: KnowledgerService, actor: ReturnType<typeof actorIdentity>): Promise<string[]> {
  const digests: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.listDrafts(actor, 50, cursor);
    digests.push(...page.drafts.map(row => row.revision_digest));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return digests.sort();
}

/** 데이터 디렉터리를 열어 복구된 상태를 판독한다 — 내용 다이제스트까지 비교해 손상을 놓치지 않는다. */
async function readRecoveredState(dataDir: string, label: string): Promise<RecoveredState> {
  const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
  try {
    const service = new KnowledgerService(ledger, vault, demoDefinition());
    await service.initialize();
    const actor = actorIdentity(PERSONAS[1]);
    const checkpoint = ledger.checkpoint();
    if (typeof checkpoint?.transaction_id !== 'string') throw new Error(`${label} checkpoint missing`);
    const overview = await service.overview(actor);
    if (overview.documents.filter((item: { payload: { document_id?: string } }) => item.payload.document_id === 'doc-resilience-smoke-001').length !== 1) throw new Error(`${label} document missing`);
    const journal = readAllEvents(ledger);
    return {
      checkpoint_tx_id: checkpoint.transaction_id,
      event_count: journal.length,
      journal_digest: contentDigest(journal),
      drafts_digest: contentDigest(await readAllDraftDigests(service, actor)),
      transaction_ids: journal.map(event => event.checkpoint.transaction_id),
    };
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
  const cleanupErrors: string[] = [];
  let result: MultiHostDrillResult;
  try {
    // Host A keeps committing real writes so the kill lands mid-operation.
    const a = await startWorker(workers, hostA, ['--write-every', '25']);
    const b = await startWorker(workers, hostB);

    // At least one loop commit must be acknowledged AND a write must be
    // in-flight when the kill lands — an ack proves the workload was active,
    // begins > commits proves a write was interrupted mid-operation.
    const commitDeadline = Date.now() + 15_000;
    while (a.commits.length === 0 || a.counts.begins <= a.commits.length) {
      if (a.child.exitCode !== null || a.child.signalCode !== null) throw new Error(`write-loop domain exited before an in-flight write: ${a.stderrTail().slice(-200)}`);
      if (Date.now() > commitDeadline) throw new Error('write-loop domain showed no in-flight write before kill');
      await new Promise(resolve => setTimeout(resolve, 5));
    }

    // Host A fails hard mid-operation — no graceful shutdown. The signal must
    // actually be delivered and observed, not just requested.
    const aExit = onceExit(a.child);
    if (!a.child.kill('SIGKILL')) throw new Error('SIGKILL delivery to write-loop domain failed');
    await aExit;
    if (a.child.signalCode !== 'SIGKILL') throw new Error(`write-loop domain did not die by SIGKILL (exit=${a.child.exitCode} signal=${a.child.signalCode})`);

    // stdout는 exit 직후까지 라인을 전달할 수 있다 — 파이프를 비운 뒤에야
    // 승인 목록을 동결해야 늦게 도착한 커밋도 복구 검증에 포함된다.
    await Promise.race([a.stdoutDone, new Promise(resolve => setTimeout(resolve, 5_000))]);
    const acknowledged = [...a.commits];
    const begun = a.counts.begins;
    const inFlight = begun - acknowledged.length;
    if (inFlight < 1) throw new Error('no in-flight write was interrupted by SIGKILL');

    // Host B must be unaffected: still running, then a clean graceful stop —
    // exit code 0 with no signal is the only acceptable graceful termination.
    if (b.child.exitCode !== null || b.child.signalCode !== null) throw new Error('peer domain died with its neighbour');
    const bExit = onceExit(b.child);
    b.child.kill('SIGTERM');
    await bExit;
    if (b.child.exitCode !== 0 || b.child.signalCode !== null) throw new Error(`peer domain did not stop gracefully (exit=${b.child.exitCode} signal=${b.child.signalCode}): ${b.stderrTail().slice(-200)}`);
    const peerState = await readRecoveredState(hostB, 'peer domain after neighbour kill');
    if (peerState.checkpoint_tx_id !== b.ready.checkpoint.transaction_id || peerState.event_count !== b.ready.event_count || peerState.journal_digest !== b.ready.journal_digest || peerState.drafts_digest !== b.ready.drafts_digest) throw new Error('peer domain state drifted during neighbour kill');

    // The kill must leave uncheckpointed WAL content — without a sidecar the
    // WAL-replay claim is unproven.
    const walPath = join(hostA, 'shared-ledger.sqlite-wal');
    const walBytes = existsSync(walPath) ? statSync(walPath).size : -1;
    if (walBytes <= 0) throw new Error('killed domain left no WAL sidecar — WAL recovery is unproven');

    // 통제군 — killed DB를 열기 전에 메인 DB 파일만 떠둔다. 첫 오픈이 WAL을
    // 리플레이하고 close 시 체크포인트할 수 있으므로, 대조용 사본은 리플레이
    // 이전 상태여야 한다. 비어 있지 않은 WAL도 이미 체크포인트된 프레임일 수
    // 있으니 이 대조가 있어야 "리플레이가 상태를 되살렸다"고 말할 수 있다.
    const mainOnlyDir = join(root, 'host-a-main-only');
    mkdirSync(mainOnlyDir, { recursive: true, mode: 0o700 });
    copyFileSync(join(hostA, 'shared-ledger.sqlite'), join(mainOnlyDir, 'shared-ledger.sqlite'));

    // The killed domain recovers through SQLite WAL replay: the journal may
    // advance past readiness because the write loop kept committing, but every
    // acknowledged commit must survive replay — a count alone would hide losses.
    const walState = await readRecoveredState(hostA, 'killed domain after WAL recovery');
    if (walState.event_count < a.ready.event_count) throw new Error('WAL recovery lost committed journal entries');
    const recoveredIds = new Set(walState.transaction_ids);
    const lost = acknowledged.filter(id => !recoveredIds.has(id));
    if (lost.length) throw new Error(`WAL recovery lost acknowledged commits: ${lost.join(', ')}`);

    const mainOnlyLedger = new LocalLedger(join(mainOnlyDir, 'shared-ledger.sqlite'), CHANNEL_ID);
    let mainOnlyIds: Set<string>;
    let mainOnlyEvents: number;
    try {
      const mainJournal = readAllEvents(mainOnlyLedger);
      mainOnlyIds = new Set(mainJournal.map(event => event.checkpoint.transaction_id));
      mainOnlyEvents = mainJournal.length;
    } finally {
      mainOnlyLedger.close();
    }
    const replayedByWal = acknowledged.filter(id => !mainOnlyIds.has(id));
    if (replayedByWal.length === 0 && walState.event_count <= mainOnlyEvents) throw new Error('WAL replay is unproven — the main database file already holds every recovered commit');

    // An offline snapshot restores into a brand-new directory with the same
    // replayed state — compared content-exact against the recovered state.
    const snapshotDir = join(root, 'host-a-snapshot');
    const restoredDir = join(root, 'host-a-restored');
    createRuntimeSnapshot({ dataDir: hostA, snapshotDir });
    restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
    const restoredState = await readRecoveredState(restoredDir, 'killed domain after snapshot restore');
    if (restoredState.checkpoint_tx_id !== walState.checkpoint_tx_id || restoredState.event_count !== walState.event_count || restoredState.journal_digest !== walState.journal_digest || restoredState.drafts_digest !== walState.drafts_digest) throw new Error('restored state differs from recovered state');

    result = {
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
        host_a: { pid: a.child.pid ?? null, kill_signal: 'SIGKILL', wal_sidecar_bytes: walBytes, writes_begun: begun, commits_acknowledged: acknowledged.length, in_flight_interrupted: inFlight, main_db_only_events: mainOnlyEvents, recovered_checkpoint: walState.checkpoint_tx_id, recovered_journal_events: walState.event_count, recovered_journal_digest: walState.journal_digest },
        host_b: { pid: b.child.pid ?? null, exit_code: b.child.exitCode, journal_digest: b.ready.journal_digest },
        restored_checkpoint: restoredState.checkpoint_tx_id, restored_journal_digest: restoredState.journal_digest,
      },
    };
  } finally {
    for (const child of workers) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        try { await onceExit(child); } catch (error) { cleanupErrors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    // 정리 실패는 삼키지 않는다 — 본문이 던졌으면 그 오류가 우선하고 정리 진단은 stderr에 남긴다.
    if (cleanupErrors.length) process.stderr.write(`multi-host drill worker cleanup incomplete: ${cleanupErrors.join('; ')}\n`);
  }
  if (cleanupErrors.length) throw new Error(`drill worker cleanup failed: ${cleanupErrors.join('; ')}`);
  return result!;
}

/** 증거 아티팩트를 쓴다 — 심볼릭 링크는 O_NOFOLLOW로 거부하고, 열린 디스크립터가 일반 파일인지 확인한 뒤 항상 0600으로 쓴다. */
function writeArtifact(path: string, output: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('--out must be a regular file');
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${output}\n`);
  } finally {
    closeSync(fd);
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
    if (out) { mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 }); writeArtifact(out, output); }
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`multi-host drill failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (ownedRoot && rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
}
