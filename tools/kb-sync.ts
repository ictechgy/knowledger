#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDevelopmentClient } from '../packages/connectors/development-client.ts';
import { loadMarkdownSourceManifest, readMarkdownSource } from '../packages/connectors/filesystem-markdown.ts';
import { readGitSource } from '../packages/connectors/git-repository.ts';
import { planMarkdownSync, syncMarkdownSource } from '../packages/connectors/sync-markdown.ts';

const USAGE = 'Usage: node tools/kb-sync.ts --root PATH --manifest PATH --server URL --workspace ID --org ORG_ID --actor ACTOR_ID [--git-ref REF] [--dry-run] [--retries 0..3]';
const REQUIRED = ['--root', '--manifest', '--server', '--workspace', '--org', '--actor'] as const;
const OPTIONAL = ['--git-ref', '--retries'] as const;

function parse(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  if (args.includes('--help')) { process.stdout.write(`${USAGE}\n`); return values; }
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (name === '--dry-run' && !Object.hasOwn(values, name)) { values[name] = 'true'; index--; continue; }
    const value = args[index + 1];
    if (![...REQUIRED, ...OPTIONAL].includes(name as typeof REQUIRED[number] | typeof OPTIONAL[number]) || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw new Error('INVALID_ARGUMENTS');
    values[name] = value;
  }
  if (REQUIRED.some(name => !values[name])) throw new Error('INVALID_ARGUMENTS');
  if (values['--retries'] !== undefined && !/^[0-3]$/.test(values['--retries'])) throw new Error('INVALID_ARGUMENTS');
  return values;
}

function isMain(): boolean { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href; }

if (isMain()) {
  try {
    const values = parse(process.argv.slice(2));
    if (Object.keys(values).length === 0) process.exitCode = 0;
    else {
      // Authentication/session handshake intentionally precedes any source file read.
      const client = await createDevelopmentClient({ baseUrl: values['--server'], workspaceId: values['--workspace'], orgId: values['--org'], actorId: values['--actor'] });
      const manifest = loadMarkdownSourceManifest(resolve(values['--manifest']));
      const snapshot = values['--git-ref']
        ? await readGitSource({ root: resolve(values['--root']), ref: values['--git-ref'], manifest })
        : await readMarkdownSource({ root: resolve(values['--root']), manifest });
      const commit = 'commit' in snapshot ? { commit: snapshot.commit } : {};
      if (values['--dry-run']) {
        const plan = await planMarkdownSync(client, snapshot);
        process.stdout.write(`${JSON.stringify({ dry_run: true, ...plan, ...commit })}\n`);
      } else {
        const result = await syncMarkdownSource(client, snapshot, { retries: Number(values['--retries'] ?? 0) });
        process.stdout.write(`${JSON.stringify({ imported: result.counts.imported, unchanged: result.counts.unchanged, skipped: result.counts.skipped, removed: result.counts.removed, version: result.source.version, ...commit })}\n`);
      }
    }
  } catch (error: any) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code) ? error.code : 'SYNC_FAILED';
    process.stderr.write(`kb-sync failed: ${code}\n`);
    process.exitCode = 1;
  }
}
