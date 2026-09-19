#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, statSync, type Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { MAX_SOURCE_BYTES } from '../packages/connectors/source-contract.ts';
import { verifyJournalDb } from '../packages/storage/local-ledger.ts';
import { assertWritableTarget, writeArtifact } from './artifact.ts';
import { measureAdoption, validateObservationLog } from '../packages/measurement/adoption.ts';
import type { AdoptionMeasurement } from '../packages/measurement/adoption.ts';
import type { LedgerEvent } from '../packages/storage/local-ledger.ts';
import { CHANNEL_ID } from '../examples/order-workflow/config.ts';

/**
 * Adoption pilot measurement. Derives ledger-backed metrics (time-to-agreement,
 * review effort, reuse rate) from the verified local journal and combines them
 * with an explicit human observation log (interpretation mixing, review
 * questions, disclosure burden). The output is one pilot's measurement record —
 * not production evidence or a generalized SLA.
 * Stop the application before running this against its data directory.
 */

const USAGE = 'Usage: node tools/adoption-metrics.ts --observations PATH (--data DIR | --ledger PATH) [--channel ID] [--out PATH]';

/**
 * 저널 파일을 읽기 전용으로 열어 채널·해시 체인을 검증한 뒤 전체 이벤트를 페이지네이션한다.
 * 읽기 전용 열기라 저널 파일이나 WAL sidecar를 만들지 않고, 스키마가 없거나 채널이 다른
 * 파일은 verifyJournalDb가 거부한다 — 빈·잘못된 파일이 0건 측정으로 통과하지 않는다.
 */
export function readPilotMeasurement(input: { path: string; channelId: string; observations: unknown }): AdoptionMeasurement {
  const log = validateObservationLog(input?.observations);
  const db = new DatabaseSync(input?.path, { readOnly: true });
  try {
    // 검증과 페이지네이션을 한 읽기 트랜잭션에 묶는다 — autocommit 스냅샷 사이의
    // 동시 변경이 해시 체인 검증 없이 측정에 섞이는 것을 막는다.
    const events: LedgerEvent[] = [];
    db.exec('BEGIN');
    try {
      verifyJournalDb(db, input?.channelId);
      const page = db.prepare('SELECT sequence, record_json FROM ledger_transactions WHERE sequence > ? ORDER BY sequence LIMIT 1000');
      for (let after = 0;;) {
        const rows = page.all(after) as any[];
        for (const row of rows) events.push(JSON.parse(row.record_json));
        if (rows.length < 1000) break;
        after = rows[rows.length - 1].sequence;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return measureAdoption({ events, log });
  } finally {
    db.close();
  }
}

function isMain(): boolean { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }

if (isMain()) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) { process.stdout.write(`${USAGE}\n`); process.exitCode = 0; }
    else {
      const values = new Map<string, string>();
      for (let index = 0; index < args.length; index += 2) {
        const name = args[index];
        const value = args[index + 1];
        if (!['--data', '--ledger', '--observations', '--channel', '--out'].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid option');
        values.set(name, value);
      }
      if (!values.has('--observations') || (!values.has('--data') && !values.has('--ledger')) || (values.has('--data') && values.has('--ledger'))) throw new Error('invalid option');
      const ledgerPath = resolve(values.get('--ledger') ?? join(values.get('--data')!, 'shared-ledger.sqlite'));
      // 오타 경로가 새 빈 저널을 만들어 조용히 0건 측정을 내지 못하게 기존 정규 파일만 연다.
      const ledgerStat = lstatSync(ledgerPath, { throwIfNoEntry: false });
      if (!ledgerStat?.isFile() || ledgerStat.isSymbolicLink()) throw new Error('invalid option');
      const observationsPath = resolve(values.get('--observations')!);
      // 관찰 입력은 디스크립터로 열어 정규 파일·크기를 검증한다 — FIFO는 열기가 막히고
      // 심볼릭 링크는 따라가지 않는다. 디스크립터의 inode가 곧 읽은 대상의 신원이다.
      const observationsFd = openSync(observationsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let observationsStat: Stats;
      let observations: unknown;
      try {
        observationsStat = fstatSync(observationsFd);
        if (!observationsStat.isFile() || observationsStat.size > MAX_SOURCE_BYTES) throw new Error('invalid option');
        observations = JSON.parse(readFileSync(observationsFd, 'utf8'));
      } finally {
        closeSync(observationsFd);
      }
      const result = readPilotMeasurement({ path: ledgerPath, channelId: values.get('--channel') ?? CHANNEL_ID, observations });
      const output = JSON.stringify(result, null, 2);
      const out = values.get('--out');
      if (out) {
        const target = resolve(out);
        // --out이 저널이나 관찰 입력과 같은 파일(부모 심볼릭 링크 우회·하드링크·대소문자
        // 별칭 포함)이면 측정 결과가 입력을 덮어쓴다 — 저널 sidecar(-wal/-shm/-journal)와
        // 그 하위 경로도 보호 대상이다. 입력은 읽을 때 확정한 inode 신원을 보존한다.
        // 충돌 검증은 writeArtifact의 inode 고정 디렉터리 안에서 수행돼 검증과 쓰기가
        // 같은 디렉터리를 본다.
        const pin = (p: string) => ({ path: p, inode: lstatSync(p, { throwIfNoEntry: false }) });
        const inputs = [
          { path: ledgerPath, inode: ledgerStat },
          pin(`${ledgerPath}-wal`), pin(`${ledgerPath}-shm`), pin(`${ledgerPath}-journal`),
          { path: observationsPath, inode: observationsStat },
        ].map((input) => ({ path: input.path, inode: input.inode ? `${input.inode.dev}:${input.inode.ino}` : undefined }));
        // 아무것도 만들지 않는 선검사로 충돌을 먼저 거부한다 — 거부된 출력이 보호 경로
        // 위에 디렉터리를 남기지 않는다. 출력 디렉터리는 기존에 있어야 한다 — 재귀
        // 생성은 네임스페이스 변경이 만든 곳에 디렉터리를 남길 수 있다.
        assertWritableTarget(target, inputs);
        if (!statSync(dirname(target), { throwIfNoEntry: false })?.isDirectory()) throw new Error('invalid option');
        writeArtifact(target, output, { protectedPaths: inputs });
      }
      process.stdout.write(`${output}\n`);
    }
  } catch {
    process.stderr.write('adoption measurement failed: invalid input or unreadable ledger\n');
    process.exitCode = 1;
  }
}
