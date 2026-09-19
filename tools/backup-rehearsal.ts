#!/usr/bin/env node
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { actorIdentity, CHANNEL_ID, PERSONAS, demoDefinition } from '../examples/order-workflow/config.ts';
import { seedDemo } from '../examples/order-workflow/application.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot, RuntimeSnapshotError } from '../packages/storage/runtime-snapshot.ts';

/**
 * Repeatable backup/restore rehearsal for CI. It exercises the real snapshot
 * code path against a fresh local runtime: graceful stop, offline snapshot,
 * restore into a new directory, and state equivalence — plus the guard rails
 * (online/WAL refusal, existing destination, overlapping paths).
 * It never touches an existing runtime directory.
 */

export interface BackupRehearsalResult {
  schema_version: 1;
  environment: { node: string; platform: string; arch: string };
  functional_assertions: {
    offline_snapshot_manifest: true;
    restore_same_checkpoint: true;
    restore_same_journal: true;
    restore_private_drafts: true;
    wal_sidecar_refused: true;
    existing_destination_refused: true;
    overlapping_paths_refused: true;
  };
  assessment: { rehearsal_pass: true; fabric_disaster_recovery_proven: false };
  /** 실행을 특정하는 증거 — 체크포인트·저널 다이제스트·스냅샷 파일 해시를 묶는다. */
  details: {
    checkpoint_transaction_id: string | null;
    journal_events: number;
    journal_digest: string;
    snapshot_files: { name: string; sha256: string }[];
  };
}

const actor = () => actorIdentity(PERSONAS[1]);

/** 기대한 거부 코드가 나는지 확인한다 — 다른 오류나 통과는 리허설 실패다. */
function expectSnapshotError(fn: () => unknown, code: string, label: string): void {
  try { fn(); } catch (error) {
    if (error instanceof RuntimeSnapshotError && error.code === code) return;
    throw new Error(`${label} rejected with the wrong error: ${error instanceof Error ? error.message : String(error)}`);
  }
  throw new Error(`${label} was not rejected`);
}

/** 저널·초안 내용을 해시로 고정한다 — 개수만 비교하면 내용 손상을 놓친다. */
function contentDigest(rows: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export async function runBackupRehearsal(rootDir: string): Promise<BackupRehearsalResult> {
  if (!isAbsolute(rootDir)) throw new Error('rootDir must be absolute');
  const root = resolve(rootDir);
  if (existsSync(root) && readdirSync(root).length !== 0) throw new Error('rootDir must be a new or empty directory');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const dataDir = join(root, 'runtime');

  const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
  let checkpoint: { transaction_id?: string };
  let journalDigest: string;
  let eventCount: number;
  let draftsDigest: string;
  try {
    const service = new KnowledgerService(ledger, vault, demoDefinition());
    await service.initialize();
    await seedDemo(service);
    const draft = await service.draft(actor(), {
      title: 'Backup rehearsal synthetic document', body_markdown: '# backup-rehearsal-marker\n',
      context_id: 'context-fulfillment', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1',
      document_id: 'doc-backup-rehearsal-001',
    });
    const published = await service.publish(actor(), { preview_id: (await service.preview(actor(), { draft_id: draft.draft_id })).preview_id, confirm_shared: true, command_id: 'backup-rehearsal-publish-001' });
    if (published.status !== 'committed') throw new Error('rehearsal fixture did not commit');
    checkpoint = published.checkpoint;
    const journal = ledger.events(0, 1000);
    journalDigest = contentDigest(journal);
    eventCount = journal.length;
    const draftsBefore = await service.listDrafts(actor(), 50, undefined);
    draftsDigest = contentDigest(draftsBefore.drafts.map(row => row.revision_digest).sort());
  } finally {
    ledger.close();
    vault.close();
  }

  const snapshotDir = join(root, 'snapshot');
  const restoredDir = join(root, 'restored');

  // Guard rails first: refuse overlapping paths and online-looking source trees.
  expectSnapshotError(() => createRuntimeSnapshot({ dataDir, snapshotDir: join(dataDir, 'nested-snapshot') }), 'overlapping_paths', 'snapshot nested inside data');
  // A clean stop must not leave real WAL/SHM sidecars — never overwrite or
  // delete a real one to satisfy the guard.
  for (const sidecar of ['shared-ledger.sqlite-wal', 'shared-ledger.sqlite-shm', 'private-local.sqlite-wal', 'private-local.sqlite-shm']) {
    if (existsSync(join(dataDir, sidecar))) throw new Error(`clean stop left a real sidecar: ${sidecar}`);
  }
  const fakeWalPath = join(dataDir, 'shared-ledger.sqlite-wal');
  // 배타 생성 — 확인과 생성 사이에 진짜 WAL이 생기면 덮어쓰지 않고 실패한다.
  writeFileSync(fakeWalPath, 'not-a-real-wal', { flag: 'wx' });
  const fakeWalId = statSync(fakeWalPath);
  expectSnapshotError(() => createRuntimeSnapshot({ dataDir, snapshotDir }), 'offline_required', 'snapshot with WAL sidecar');
  // 삭제 전에 심어둔 파일과 동일한지 확인한다 — 진짜 WAL을 지우는 일은 없어야 한다.
  const beforeUnlink = statSync(fakeWalPath);
  if (beforeUnlink.dev !== fakeWalId.dev || beforeUnlink.ino !== fakeWalId.ino) throw new Error('planted WAL sidecar was replaced — refusing to unlink');
  unlinkSync(fakeWalPath);

  const backup = createRuntimeSnapshot({ dataDir, snapshotDir });
  const manifestNames = backup.files.map(file => file.name);
  if (backup.mode !== 'local' || !manifestNames.includes('shared-ledger.sqlite') || !manifestNames.includes('private-local.sqlite')) throw new Error('snapshot manifest profile mismatch');
  expectSnapshotError(() => restoreRuntimeSnapshot({ snapshotDir, dataDir }), 'destination_exists', 'restore onto the live directory');
  restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });

  const restoredLedger = new LocalLedger(join(restoredDir, 'shared-ledger.sqlite'), CHANNEL_ID);
  const restoredVault = new PrivateStore(join(restoredDir, 'private-local.sqlite'));
  try {
    const restored = new KnowledgerService(restoredLedger, restoredVault, demoDefinition());
    await restored.initialize();
    if (restoredLedger.checkpoint()?.transaction_id !== checkpoint.transaction_id) throw new Error('restored checkpoint differs');
    const restoredJournal = restoredLedger.events(0, 1000);
    if (contentDigest(restoredJournal) !== journalDigest || restoredJournal.length !== eventCount) throw new Error('restored journal differs');
    const overview = await restored.overview(actor());
    if (!overview.documents.some((item: { payload: { document_id?: string } }) => item.payload.document_id === 'doc-backup-rehearsal-001')) throw new Error('restored document missing');
    const drafts = await restored.listDrafts(actor(), 50, undefined);
    if (contentDigest(drafts.drafts.map(row => row.revision_digest).sort()) !== draftsDigest) throw new Error('restored private drafts differ');
  } finally {
    restoredLedger.close();
    restoredVault.close();
  }

  return {
    schema_version: 1,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    functional_assertions: {
      offline_snapshot_manifest: true, restore_same_checkpoint: true, restore_same_journal: true,
      restore_private_drafts: true, wal_sidecar_refused: true, existing_destination_refused: true, overlapping_paths_refused: true,
    },
    assessment: { rehearsal_pass: true, fabric_disaster_recovery_proven: false },
    details: {
      checkpoint_transaction_id: checkpoint.transaction_id ?? null,
      journal_events: eventCount,
      journal_digest: journalDigest,
      snapshot_files: backup.files.map(({ name, sha256 }) => ({ name, sha256 })),
    },
  };
}

/** 증거 아티팩트를 쓴다 — 기존 파일이면 덮어쓰되 권한은 항상 0600으로 맞춘다. */
function writeArtifact(path: string, output: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('--out must be a regular file');
  }
  const fd = openSync(path, 'w');
  try {
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
    rootDir = root ?? mkdtempSync(join(resolve('.data'), 'backup-rehearsal-'));
    ownedRoot = !root;
    const result = await runBackupRehearsal(rootDir);
    const output = JSON.stringify(result, null, 2);
    if (out) { mkdirSync(resolve(out, '..'), { recursive: true, mode: 0o700 }); writeArtifact(out, output); }
    process.stdout.write(`${output}\n`);
  } catch (error) {
    process.stderr.write(`backup rehearsal failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    if (ownedRoot && rootDir) rmSync(rootDir, { recursive: true, force: true });
  }
}
