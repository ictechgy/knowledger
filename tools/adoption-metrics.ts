#!/usr/bin/env node
import { lstatSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalLedger } from '../packages/storage/local-ledger.ts';
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

function allEvents(ledger: LocalLedger): LedgerEvent[] {
  const events: LedgerEvent[] = [];
  for (;;) {
    const page = ledger.events(events.length ? events[events.length - 1].checkpoint.block_number : 0, 1000);
    events.push(...page);
    if (page.length < 1000) return events;
  }
}

export function readPilotMeasurement(input: { ledger: LocalLedger; observations: unknown }): AdoptionMeasurement {
  const log = validateObservationLog(input?.observations);
  if (!input?.ledger || typeof input.ledger.events !== 'function') throw new Error('ledger required');
  return measureAdoption({ events: allEvents(input.ledger), log });
}

function isMain(): boolean { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }

if (isMain()) {
  let ledger: LocalLedger | undefined;
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
      ledger = new LocalLedger(ledgerPath, values.get('--channel') ?? CHANNEL_ID);
      const result = readPilotMeasurement({ ledger, observations });
      const output = JSON.stringify(result, null, 2);
      const out = values.get('--out');
      if (out) {
        const target = resolve(out);
        mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
        writeArtifact(target, output);
      }
      process.stdout.write(`${output}\n`);
    }
  } catch {
    process.stderr.write('adoption measurement failed: invalid input or unreadable ledger\n');
    process.exitCode = 1;
  } finally {
    ledger?.close();
  }
}
