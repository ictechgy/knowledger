#!/usr/bin/env node
import { createRuntimeSnapshot, restoreRuntimeSnapshot, RuntimeSnapshotError } from '../packages/storage/runtime-snapshot.ts';
import { resolve } from 'node:path';

function usage(): never {
  throw new Error('Usage: runtime-snapshot backup --data PATH --out PATH | restore --snapshot PATH --out PATH');
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length || !args[index + 1] || args[index + 1].startsWith('--')) usage();
  return args[index + 1];
}

function parse(command: string, args: string[]): { source: string; out: string } {
  const expectedSource = command === 'backup' ? '--data' : '--snapshot';
  if (command !== 'backup' && command !== 'restore') usage();
  if (args.length !== 4 || !args.includes(expectedSource) || !args.includes('--out')) usage();
  const source = option(args, expectedSource);
  const out = option(args, '--out');
  if (args.filter(arg => arg === expectedSource).length !== 1 || args.filter(arg => arg === '--out').length !== 1) usage();
  return { source: resolve(source), out: resolve(out) };
}

function safeMessage(error: unknown): string {
  if (error instanceof RuntimeSnapshotError) return error.message;
  if (error instanceof Error && error.message.startsWith('Usage:')) return error.message;
  return 'Runtime snapshot operation failed';
}

function main(): void {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (!command) usage();
    const { source, out } = parse(command, args);
    const summary = command === 'backup'
      ? createRuntimeSnapshot({ dataDir: source, snapshotDir: out })
      : restoreRuntimeSnapshot({ snapshotDir: source, dataDir: out });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (error) {
    process.stderr.write(`runtime snapshot failed: ${safeMessage(error)}\n`);
    process.exitCode = 1;
  }
}

main();
