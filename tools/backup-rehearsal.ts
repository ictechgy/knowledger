#!/usr/bin/env node
import { closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** 초안 전체를 페이지로 읽어 정렬된 레코드로 고정한다 — 다이제스트가 식별자와 내용을 함께 묶는다. */
async function readAllDraftRecords(service: KnowledgerService, actor: ReturnType<typeof actorIdentity>): Promise<string[]> {
  const records: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.listDrafts(actor, 50, cursor);
    records.push(...page.drafts.map(row => JSON.stringify(row)));
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return records.sort();
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
    if (typeof checkpoint.transaction_id !== 'string') throw new Error('rehearsal fixture checkpoint has no transaction id');
    const journal = readAllEvents(ledger);
    journalDigest = contentDigest(journal);
    eventCount = journal.length;
    draftsDigest = contentDigest(await readAllDraftRecords(service, actor()));
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
  // WAL 거부는 별도 일회용 사본에서 검증한다 — 실제 데이터 디렉터리에 가짜
  // WAL을 심고 지우는 방식은 어떤 경합으로도 진짜 WAL을 건드릴 여지를 남긴다.
  const guardDir = join(root, 'guard-source');
  mkdirSync(guardDir, { recursive: true, mode: 0o700 });
  copyFileSync(join(dataDir, 'shared-ledger.sqlite'), join(guardDir, 'shared-ledger.sqlite'));
  copyFileSync(join(dataDir, 'private-local.sqlite'), join(guardDir, 'private-local.sqlite'));
  writeFileSync(join(guardDir, 'shared-ledger.sqlite-wal'), 'not-a-real-wal', { flag: 'wx' });
  expectSnapshotError(() => createRuntimeSnapshot({ dataDir: guardDir, snapshotDir: join(root, 'guard-snapshot') }), 'offline_required', 'snapshot with WAL sidecar');

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
    const restoredJournal = readAllEvents(restoredLedger);
    if (contentDigest(restoredJournal) !== journalDigest || restoredJournal.length !== eventCount) throw new Error('restored journal differs');
    const overview = await restored.overview(actor());
    if (!overview.documents.some((item: { payload: { document_id?: string } }) => item.payload.document_id === 'doc-backup-rehearsal-001')) throw new Error('restored document missing');
    if (contentDigest(await readAllDraftRecords(restored, actor())) !== draftsDigest) throw new Error('restored private drafts differ');
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
      checkpoint_transaction_id: checkpoint.transaction_id,
      journal_events: eventCount,
      journal_digest: journalDigest,
      snapshot_files: backup.files.map(({ name, sha256 }) => ({ name, sha256 })),
    },
  };
}

/** 증거 아티팩트를 쓴다 — 심볼릭 링크는 O_NOFOLLOW, FIFO는 O_NONBLOCK으로 거부하고, 열린 디스크립터가 일반 파일인지 확인한 뒤 항상 0600으로 쓴다. */
function writeArtifact(path: string, output: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('--out must be a regular file');
    ftruncateSync(fd, 0);
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
