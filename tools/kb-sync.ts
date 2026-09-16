#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createDevelopmentClient } from '../packages/connectors/development-client.ts';
import { loadMarkdownSourceManifest, readMarkdownSource } from '../packages/connectors/filesystem-markdown.ts';
import { syncMarkdownSource } from '../packages/connectors/sync-markdown.ts';

const USAGE = 'Usage: node tools/kb-sync.ts --root PATH --manifest PATH --server URL --workspace ID --org ORG_ID --actor ACTOR_ID';
const REQUIRED = ['--root', '--manifest', '--server', '--workspace', '--org', '--actor'] as const;

function parse(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  if (args.includes('--help')) { process.stdout.write(`${USAGE}\n`); return values; }
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!REQUIRED.includes(name as typeof REQUIRED[number]) || !value || value.startsWith('--') || Object.hasOwn(values, name)) throw new Error('INVALID_ARGUMENTS');
    values[name] = value;
  }
  if (REQUIRED.some(name => !values[name])) throw new Error('INVALID_ARGUMENTS');
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
      const snapshot = await readMarkdownSource({ root: resolve(values['--root']), manifest });
      const result = await syncMarkdownSource(client, snapshot);
      process.stdout.write(`${JSON.stringify({ imported: result.counts.imported, unchanged: result.counts.unchanged, skipped: result.counts.skipped, removed: result.counts.removed, version: result.source.version })}\n`);
    }
  } catch (error: any) {
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/u.test(error.code) ? error.code : 'SYNC_FAILED';
    process.stderr.write(`kb-sync failed: ${code}\n`);
    process.exitCode = 1;
  }
}
