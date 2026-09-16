#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
import type { Actor, Checkpoint, LedgerEvent } from '../packages/storage/local-ledger.ts';
import type { ApplicationLedger, CommittedReceipt, PendingReceipt } from '../packages/storage/ledger-port.ts';
import type { DomainCommand } from '../packages/domain/index.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { createApp } from '../apps/api/server.ts';
import { actorIdentity, CHANNEL_ID, demoFixtures, PERSONAS, BOOTSTRAP_ACTOR, demoDefinition } from '../examples/order-workflow/config.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../packages/storage/runtime-snapshot.ts';

export interface ResilienceSmokeOptions { rootDir: string }

export interface ResilienceSmokeResult {
  schema_version: 1;
  mode: 'local-simulation';
  environment: { node: string; platform: string; arch: string };
  metrics: { forced_restart_reopen_ms: number; snapshot_backup_restore_ms: number; peer_recovery_ms: number };
  functional_assertions: {
    forced_restart_recovered: true;
    idempotent_retry_no_duplicate_event: true;
    snapshot_restore_same_state: true;
    peer_unavailable_strict_503: true;
    peer_recovery_no_duplicate_event: true;
  };
  assessment: { recovery_pass: true; performance: 'measurement_only'; fabric_sla_proven: false };
}

class FixturePeerPort implements ApplicationLedger {
  readonly mode = 'fabric-test-network' as const;
  readonly channelId: string;
  unavailable = false;
  private readonly local: LocalLedger;
  constructor(local: LocalLedger) { this.local = local; this.channelId = local.channelId; }
  async refresh(): Promise<void> { if (this.unavailable) throw new Error('peer unavailable'); await this.local.refresh(); }
  read(key: string, at?: Checkpoint | null): any | undefined { return this.local.read(key, at); }
  entries(prefix: string, at?: Checkpoint | null): [string, any][] { return this.local.entries(prefix, at); }
  checkpoint(): Checkpoint | null { return this.local.checkpoint(); }
  assertCheckpoint(at: Checkpoint): void { this.local.assertCheckpoint(at); }
  checkpointForTransaction(transactionId: string): Checkpoint { return this.local.checkpointForTransaction(transactionId); }
  checkpointForStateCreation(key: string): Checkpoint { return this.local.checkpointForStateCreation(key); }
  events(after?: number, limit?: number): LedgerEvent[] { return this.local.events(after, limit); }
  async execute(actor: Actor, command: DomainCommand): Promise<CommittedReceipt | PendingReceipt> { return this.local.execute(actor, command); }
  async bootstrap(actor: Actor, config: unknown): Promise<CommittedReceipt> { return this.local.bootstrap(actor, config); }
  close(): void { this.local.close(); }
}

function onceExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resilience worker exit timeout')), 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  const exited = onceExit(child);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await exited;
}

async function startWorker(dataDir: string): Promise<{ child: ChildProcess; ready: any }> {
  const worker = fileURLToPath(new URL('./testing/resilience-worker.ts', import.meta.url));
  const child = spawn(process.execPath, [worker, '--data', dataDir], { cwd: resolve(fileURLToPath(new URL('..', import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout!.setEncoding('utf8');
  child.stderr!.resume();
  let ready: any;
  try {
    ready = await new Promise<any>((resolveReady, reject) => {
      let buffer = '';
      const timer = setTimeout(() => reject(new Error('resilience worker timeout')), 15_000);
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        const lineEnd = buffer.indexOf('\n');
        if (lineEnd < 0) return;
        const line = buffer.slice(0, lineEnd); buffer = buffer.slice(lineEnd + 1);
        try { const parsed = JSON.parse(line); clearTimeout(timer); resolveReady(parsed); }
        catch { clearTimeout(timer); reject(new Error('resilience worker produced invalid readiness output')); }
      });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('resilience worker exited before readiness')); });
    });
  } catch (error) {
    await killAndWait(child);
    throw error;
  }
  if (ready?.ready !== true || typeof ready.preview_id !== 'string' || typeof ready.command_id !== 'string') { await killAndWait(child); throw new Error('resilience worker readiness contract failed'); }
  return { child, ready };
}

function actor(): Actor { return actorIdentity(PERSONAS[1]); }

export async function runResilienceSmoke(options: ResilienceSmokeOptions): Promise<ResilienceSmokeResult> {
  if (!isAbsolute(options.rootDir)) throw new Error('rootDir must be absolute');
  const rootDir = resolve(options.rootDir);
  if (existsSync(rootDir) && readdirSync(rootDir).length !== 0) throw new Error('rootDir must be a new or empty directory');
  mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  const dataDir = join(rootDir, 'runtime');
  let child: ChildProcess | undefined;
  let ledger: LocalLedger | undefined;
  let vault: PrivateStore | undefined;
  try {
    const started = await startWorker(dataDir);
    child = started.child;
    await killAndWait(child);

    const reopenStarted = performance.now();
    ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
    vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
    let service = new KnowledgerService(ledger, vault, demoDefinition());
    await service.initialize();
    const eventsBeforeRetry = ledger.events(0, 1000).length;
    const retry = await service.publish(actor(), { preview_id: started.ready.preview_id, confirm_shared: true, command_id: started.ready.command_id });
    if (retry.status !== 'committed' || retry.checkpoint.transaction_id !== started.ready.checkpoint.transaction_id || ledger.events(0, 1000).length !== eventsBeforeRetry) throw new Error('idempotent retry changed the recovered journal');
    const recoveredCheckpoint = retry.checkpoint;
    const reopenMs = performance.now() - reopenStarted;
    const recoveredDocuments = (await service.overview(actor())).documents.filter((item: any) => item.payload.document_id === 'doc-resilience-smoke-001').length;
    if (recoveredDocuments !== 1) throw new Error('restarted runtime did not recover the committed document');
    ledger.close(); vault.close(); ledger = undefined; vault = undefined;

    const snapshotStarted = performance.now();
    const snapshotDir = join(rootDir, 'snapshot');
    const restoredDir = join(rootDir, 'restored');
    createRuntimeSnapshot({ dataDir, snapshotDir });
    restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
    const snapshotMs = performance.now() - snapshotStarted;
    const restoredLedger = new LocalLedger(join(restoredDir, 'shared-ledger.sqlite'), CHANNEL_ID);
    const restoredVault = new PrivateStore(join(restoredDir, 'private-local.sqlite'));
    service = new KnowledgerService(restoredLedger, restoredVault, demoDefinition());
    await service.initialize();
    const restoredEvents = restoredLedger.events(0, 1000).length;
    const restoredOverview = await service.overview(actor());
    if (restoredEvents !== eventsBeforeRetry || restoredLedger.checkpoint()?.transaction_id !== recoveredCheckpoint.transaction_id || restoredOverview.documents.filter((item: any) => item.payload.document_id === 'doc-resilience-smoke-001').length !== 1) throw new Error('snapshot restore changed recovered state');
    restoredLedger.close(); restoredVault.close();

    const peerLocal = new LocalLedger(':memory:', CHANNEL_ID);
    await peerLocal.bootstrap(BOOTSTRAP_ACTOR, demoFixtures().config);
    const peer = new FixturePeerPort(peerLocal);
    const peerApp = await createApp({ dataDir: join(rootDir, 'peer-api'), ledger: peer, personas: PERSONAS.slice(0, 3), definition: demoDefinition() });
    const origin = await peerApp.listen(0);
    try {
      const sessionResponse = await fetch(`${origin}/api/session`);
      const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
      peer.unavailable = true;
      const outageStarted = performance.now();
      const unavailable = await fetch(`${origin}/v1/workspaces/demo/overview`, { headers: { Cookie: cookie } });
      const health = await fetch(`${origin}/healthz`);
      const readiness = await fetch(`${origin}/readyz`);
      if (unavailable.status !== 503 || readiness.status !== 503 || health.status !== 200) throw new Error('peer outage did not distinguish unavailable knowledge from process liveness');
      peer.unavailable = false;
      const recovered = await fetch(`${origin}/v1/workspaces/demo/overview`, { headers: { Cookie: cookie } });
      const recoveryMs = performance.now() - outageStarted;
      if (recovered.status !== 200 || peer.events(0, 1000).length !== 1) throw new Error('peer recovery changed fixture state');
      return {
        schema_version: 1,
        mode: 'local-simulation',
        environment: { node: process.version, platform: process.platform, arch: process.arch },
        metrics: { forced_restart_reopen_ms: reopenMs, snapshot_backup_restore_ms: snapshotMs, peer_recovery_ms: recoveryMs },
        functional_assertions: { forced_restart_recovered: true, idempotent_retry_no_duplicate_event: true, snapshot_restore_same_state: true, peer_unavailable_strict_503: true, peer_recovery_no_duplicate_event: true },
        assessment: { recovery_pass: true, performance: 'measurement_only', fabric_sla_proven: false },
      };
    } finally {
      await peerApp.close();
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) await killAndWait(child);
    try { ledger?.close(); } catch { /* cleanup only */ }
    try { vault?.close(); } catch { /* cleanup only */ }
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
    if (!root) mkdirSync(resolve('.data'),{recursive:true,mode:0o700});
    rootDir = root ?? mkdtempSync(join(resolve('.data'), 'resilience-smoke-'));
    ownedRoot = !root;
    const result = await runResilienceSmoke({ rootDir });
    const output = JSON.stringify(result, null, 2);
    if (out) { mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 }); writeFileSync(out, `${output}\n`, { mode: 0o600 }); }
    process.stdout.write(`${output}\n`);
  } catch {
    process.stderr.write('resilience smoke failed: invalid input or local recovery failure\n');
    process.exitCode = 1;
  } finally {
    if (ownedRoot && rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
}
