#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { verifyJournalDb } from '../packages/storage/local-ledger.ts';
import { writeArtifact } from './artifact.ts';
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
      const observations = JSON.parse(readFileSync(resolve(values.get('--observations')!), 'utf8'));
      const result = readPilotMeasurement({ path: ledgerPath, channelId: values.get('--channel') ?? CHANNEL_ID, observations });
      const output = JSON.stringify(result, null, 2);
      const out = values.get('--out');
      if (out) {
        const target = resolve(out);
        // --out이 저널이나 관찰 입력과 같은 파일(부모 심볼릭 링크 우회·하드링크 포함)이면
        // 측정 결과가 입력을 덮어쓴다 — 정규 경로와 inode 양쪽으로 충돌을 거부한다.
        // 존재하지 않는 경로는 가장 가까운 기존 조상의 정규 경로 위에 얹어 해석한다.
        const canonical = (p: string): string => {
          const missing: string[] = [];
          for (let current = p;;) {
            try { return join(realpathSync(current), ...missing.reverse()); } catch {
              const parent = dirname(current);
              if (parent === current) return p;
              missing.push(basename(current));
              current = parent;
            }
          }
        };
        const inodeOf = (p: string): string | undefined => {
          const stat = lstatSync(p, { throwIfNoEntry: false });
          return stat ? `${stat.dev}:${stat.ino}` : undefined;
        };
        // 저널 sidecar(-wal/-shm/-journal)도 보호 대상이다 — WAL 안의 커밋된 상태를
        // 측정 출력이 덮어쓰는 것을 막는다. 보호 경로의 하위에 쓰는 것도 거부한다 —
        // 거기에 디렉터리를 만들면 저널이 sidecar를 생성할 수 없게 된다.
        const inputs = [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`, `${ledgerPath}-journal`, resolve(values.get('--observations')!)];
        // 합성된 미존재 경로 조각은 원래 철자를 유지하므로, 대소문자 비구분 파일시스템의
        // 다른 철자 별칭을 잡기 위해 정규화·대소문자를 접은 형태로 비교한다 — 대소문자
        // 구분 시스템에서는 다른 파일을 넓게 거부할 뿐 조용한 우회는 허용하지 않는다.
        const fold = (p: string): string => p.normalize('NFC').toLowerCase();
        const targetFolded = fold(canonical(target));
        const targetInode = inodeOf(target);
        const collides = inputs.some((input) => {
          const base = fold(canonical(input));
          return targetFolded === base || targetFolded.startsWith(`${base}${sep}`)
            || (targetInode !== undefined && inodeOf(input) === targetInode);
        });
        if (collides) throw new Error('invalid option');
        // 검증을 통과한 뒤에만 디렉터리를 만든다 — 보호 경로에 디렉터리가 생기는 것을 막는다.
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeArtifact(target, output);
      }
      process.stdout.write(`${output}\n`);
    }
  } catch {
    process.stderr.write('adoption measurement failed: invalid input or unreadable ledger\n');
    process.exitCode = 1;
  }
}
