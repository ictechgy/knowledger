/** CLI for the fixed, disposable Fabric development certificate profiles. */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';
import {
  CertificateMaintenanceError,
  applyRenewal,
  checkCertificates,
  prepareRenewal,
} from '../../infra/fabric/certificates.ts';

const STATE_DIR = fileURLToPath(new URL('../../.data/fabric-smoke/', import.meta.url));

function usage(): never {
  throw new CertificateMaintenanceError(
    'INVALID_ARGUMENT',
    'Usage: check [--warn-days N] | prepare [--days N] [--renew-before-days N] | apply --plan STATE_RELATIVE_PATH',
  );
}

function integer(value: string | undefined, flag: string): number {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new CertificateMaintenanceError('INVALID_ARGUMENT', `${flag} requires a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new CertificateMaintenanceError('INVALID_ARGUMENT', `${flag} is outside the supported range`);
  return parsed;
}

function flags(values: string[], allowed: ReadonlySet<string>): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith('--') || result.has(flag)) usage();
    result.set(flag, value);
  }
  return result;
}

export function main(argv = process.argv.slice(2)): number {
  try {
    const [action, ...args] = argv;
    if (action === 'check') {
      const parsed = flags(args, new Set(['--warn-days']));
      const result = checkCertificates(STATE_DIR, parsed.has('--warn-days') ? integer(parsed.get('--warn-days'), '--warn-days') : undefined);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'ok' ? 0 : 2;
    }
    if (action === 'prepare') {
      const parsed = flags(args, new Set(['--days', '--renew-before-days']));
      const result = prepareRenewal(STATE_DIR, {
        ...(parsed.has('--days') ? { days: integer(parsed.get('--days'), '--days') } : {}),
        ...(parsed.has('--renew-before-days') ? { renewBeforeDays: integer(parsed.get('--renew-before-days'), '--renew-before-days') } : {}),
      });
      process.stdout.write(`${JSON.stringify({ ...result, plan_path_scope: result.plan_path ? 'state-relative' : undefined }, null, 2)}\n`);
      return 0;
    }
    if (action === 'apply') {
      const parsed = flags(args, new Set(['--plan']));
      const plan = parsed.get('--plan');
      if (!plan || isAbsolute(plan)) usage();
      const result = applyRenewal(STATE_DIR, join(STATE_DIR, plan));
      process.stdout.write(`${JSON.stringify({ ...result, plan_path_scope: 'state-relative' }, null, 2)}\n`);
      return 0;
    }
    return usage();
  } catch (error) {
    const safe = error instanceof CertificateMaintenanceError
      ? { error: error.code, message: error.message }
      : { error: 'CERTIFICATE_MAINTENANCE_FAILED', message: 'Test certificate maintenance failed' };
    process.stderr.write(`${JSON.stringify(safe)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
