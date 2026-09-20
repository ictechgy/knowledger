#!/usr/bin/env node
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
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
import { parseStrictJson } from '../packages/fabric/canonical.ts';

/**
 * Adoption pilot measurement. Derives ledger-backed metrics (time-to-agreement,
 * review effort, reuse rate) from a verified local or Fabric journal and combines them
 * with an explicit human observation log (interpretation mixing, review
 * questions, disclosure burden). The output is one pilot's measurement record —
 * not production evidence or a generalized SLA.
 * Stop the application before running this against its data directory.
 */

const USAGE = 'Usage: node tools/adoption-metrics.ts --observations PATH (--data DIR | --ledger PATH) [--mode local|fabric] [--channel ID] [--out PATH]\nFabric mode requires --channel ID --chaincode NAME --chaincode-version VERSION --genesis PATH (public genesis JSON).';

/**
 * 저널 파일을 읽기 전용으로 열어 채널·해시 체인을 검증한 뒤 이벤트를 순차 소비한다.
 * 스키마가 없거나 채널이 다른 파일은 verifyJournalDb가 거부한다 — 빈·잘못된 파일이 0건
 * 측정으로 통과하지 않는다. 읽기 전용이라도 SQLite는 WAL 인덱스(-shm)를 만들거나 갱신할
 * 수 있다 — 저널 내용의 변경은 아니며, 읽는 동안 입력이 바뀌지 않는 정지된 저장소라는
 * 계약의 일부다.
 */
export function readPilotMeasurement(input: { path: string; channelId: string; observations: unknown; evidence?: AdoptionMeasurement['evidence'] }): AdoptionMeasurement {
  const log = validateObservationLog(input?.observations);
  const db = new DatabaseSync(input?.path, { readOnly: true });
  try {
    // 검증과 집계를 한 읽기 트랜잭션에 묶는다 — autocommit 스냅샷 사이의
    // 동시 변경이 해시 체인 검증 없이 측정에 섞이는 것을 막는다.
    db.exec('BEGIN');
    try {
      verifyJournalDb(db, input?.channelId);
      function* events(): Generator<LedgerEvent> {
        const rows = db.prepare('SELECT record_json FROM ledger_transactions ORDER BY sequence').iterate();
        for (const row of rows) yield JSON.parse(row.record_json as string);
      }
      const measurement = measureAdoption({ events: events(), log, channel_id: input?.channelId, evidence: input?.evidence });
      db.exec('COMMIT');
      return measurement;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

/** Descriptor-pinned JSON input shared by observations and public genesis. */
function readJsonInput(path: string, strict = false): { path: string; inode: string; bytes: Buffer; value: unknown } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before: BigIntStats = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) throw new Error('invalid option');
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let total = 0;
    for (let n = 1; n > 0; total += n) n = readSync(fd, buffer, total, buffer.length - total, null);
    if (total > MAX_SOURCE_BYTES) throw new Error('invalid option');
    const after = fstatSync(fd, { bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new Error('invalid option');
    const bytes = buffer.subarray(0, total);
    const value = strict ? parseStrictJson(bytes) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { path, inode: `${before.dev}:${before.ino}`, bytes, value };
  } finally { closeSync(fd); }
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
        if (!['--data', '--ledger', '--observations', '--channel', '--out', '--mode', '--genesis', '--chaincode', '--chaincode-version'].includes(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid option');
        values.set(name, value);
      }
      if (!values.has('--observations') || (!values.has('--data') && !values.has('--ledger')) || (values.has('--data') && values.has('--ledger'))) throw new Error('invalid option');
      const mode = values.get('--mode') ?? 'local';
      const fabricFlags = ['--genesis', '--chaincode', '--chaincode-version'];
      if (mode !== 'local' && mode !== 'fabric') throw new Error('invalid option');
      if (mode === 'fabric' ? !values.has('--channel') || fabricFlags.some(flag => !values.has(flag))
        : fabricFlags.some(flag => values.has(flag))) throw new Error('invalid option');
      const ledgerPath = resolve(values.get('--ledger') ?? join(values.get('--data')!, mode === 'fabric' ? 'fabric-projection.sqlite' : 'shared-ledger.sqlite'));
      // 오타 경로가 새 빈 저널을 만들어 조용히 0건 측정을 내지 못하게 기존 정규 파일만 연다.
      const ledgerStat = lstatSync(ledgerPath, { throwIfNoEntry: false, bigint: true });
      if (!ledgerStat?.isFile() || ledgerStat.isSymbolicLink()) throw new Error('invalid option');
      const observations = readJsonInput(resolve(values.get('--observations')!));
      const genesis = mode === 'fabric' ? readJsonInput(resolve(values.get('--genesis')!), true) : undefined;
      // --out이 저널이나 관찰 입력과 같은 파일(부모 심볼릭 링크 우회·하드링크·대소문자
      // 별칭 포함)이면 측정 결과가 입력을 덮어쓴다 — 저널 sidecar(-wal/-shm/-journal)와
      // 그 하위 경로도 보호 대상이다. 입력 신원은 읽기 전에 고정한다 — 읽는 동안 입력이
      // 옮겨져 대상 위치에 놓여도 확정된 inode로 비교한다. 존재하는 sidecar가 비정규
      // 파일이면 SQLite의 경로 해석을 신뢰할 수 없어 거부한다.
      const pin = (p: string) => {
        const stat = lstatSync(p, { throwIfNoEntry: false, bigint: true });
        if (stat && !stat.isFile()) throw new Error('invalid option');
        return { path: p, inode: stat ? `${stat.dev}:${stat.ino}` : undefined };
      };
      const inputs = [
        pin(ledgerPath), pin(`${ledgerPath}-wal`), pin(`${ledgerPath}-shm`), pin(`${ledgerPath}-journal`),
        { path: observations.path, inode: observations.inode },
        ...(genesis ? [{ path: genesis.path, inode: genesis.inode }] : []),
      ];
      // 측정 아티팩트에 읽은 관찰 입력의 신원을 싣는다 — 같은 건수의 다른 로그는
      // 다른 다이제스트로 구별된다.
      const evidence = { observations_sha256: createHash('sha256').update(observations.bytes).digest('hex'), observations_bytes: observations.bytes.byteLength };
      // Keep the default local path usable without optional Fabric dependencies.
      const result = mode === 'fabric'
        ? (await import('../packages/measurement/fabric-adoption.ts')).readFabricPilotMeasurement({
          path: ledgerPath, observations: observations.value, evidence,
          options: { channel_id: values.get('--channel')!, chaincode_name: values.get('--chaincode')!,
            chaincode_version: values.get('--chaincode-version')!, public_genesis: genesis!.value },
        })
        : readPilotMeasurement({ path: ledgerPath, channelId: values.get('--channel') ?? CHANNEL_ID, observations: observations.value, evidence });
      // 고정한 신원을 가진 모든 입력이 읽기 후에도 같은 대상인지 확인한다 — 읽는 동안
      // 바뀌거나 지워진 입력은 고정 신원이 실제 읽은 내용을 대표하지 못한다. 읽기 중
      // 새로 생긴 sidecar는 출력 검증 시점의 재조회가 보호 비교에 쓴다.
      for (const input of inputs) {
        if (input.inode === undefined) continue;
        const post = lstatSync(input.path, { throwIfNoEntry: false, bigint: true });
        if (!post || `${post.dev}:${post.ino}` !== input.inode) throw new Error('invalid option');
      }
      const output = JSON.stringify(result, null, 2);
      const out = values.get('--out');
      if (out) {
        const target = resolve(out);
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
    process.stderr.write('adoption measurement failed: invalid input, unreadable ledger, or missing optional Fabric dependencies\n');
    process.exitCode = 1;
  }
}
