#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
}

interface ReadyWorker { child: ChildProcess; ready: { preview_id: string; command_id: string; checkpoint: any; event_count: number } }

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('drill worker exit timeout')), 10_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function startWorker(dataDir: string): Promise<ReadyWorker> {
  const worker = fileURLToPath(new URL('./testing/resilience-worker.ts', import.meta.url));
  const child = spawn(process.execPath, [worker, '--data', dataDir], { cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.setEncoding('utf8');
  child.stderr!.resume();
  let ready: any;
  try {
    ready = await new Promise<any>((resolveReady, reject) => {
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
      child.once('exit', () => { clearTimeout(timer); reject(new Error('drill worker exited before readiness')); });
    });
  } catch (error) {
    child.kill('SIGKILL');
    throw error;
  }
  if (ready?.ready !== true || typeof ready.checkpoint?.transaction_id !== 'string') { child.kill('SIGKILL'); throw new Error('drill worker readiness contract failed'); }
  return { child, ready };
}

async function verifyRecoveredState(dataDir: string, expected: ReadyWorker['ready'], label: string): Promise<void> {
  const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
  try {
    const service = new KnowledgerService(ledger, vault, demoDefinition());
    await service.initialize();
    const checkpoint = ledger.checkpoint();
    if (checkpoint?.transaction_id !== expected.checkpoint.transaction_id) throw new Error(`${label} checkpoint changed`);
    if (ledger.events(0, 1000).length !== expected.event_count) throw new Error(`${label} journal changed`);
    const overview = await service.overview(actorIdentity(PERSONAS[1]));
    if (overview.documents.filter((item: any) => item.payload.document_id === 'doc-resilience-smoke-001').length !== 1) throw new Error(`${label} document missing`);
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
    const a = await startWorker(hostA);
    workers.push(a.child);
    const b = await startWorker(hostB);
    workers.push(b.child);

    // Host A fails hard mid-operation — no graceful shutdown.
    const aExit = onceExit(a.child);
    a.child.kill('SIGKILL');
    await aExit;

    // Host B must be unaffected: still running, then a clean graceful stop.
    if (b.child.exitCode !== null || b.child.signalCode !== null) throw new Error('peer domain died with its neighbour');
    const bExit = onceExit(b.child);
    b.child.kill('SIGTERM');
    await bExit;
    await verifyRecoveredState(hostB, b.ready, 'peer domain after neighbour kill');

    // The killed domain recovers through SQLite WAL replay, then an offline
    // snapshot restores into a brand-new directory with identical state.
    await verifyRecoveredState(hostA, a.ready, 'killed domain after WAL recovery');
    const snapshotDir = join(root, 'host-a-snapshot');
    const restoredDir = join(root, 'host-a-restored');
    createRuntimeSnapshot({ dataDir: hostA, snapshotDir });
    restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
    await verifyRecoveredState(restoredDir, a.ready, 'killed domain after snapshot restore');

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
  } catch {
    process.stderr.write('multi-host drill failed: invalid input or domain recovery failure\n');
    process.exitCode = 1;
  } finally {
    if (ownedRoot && rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
}
