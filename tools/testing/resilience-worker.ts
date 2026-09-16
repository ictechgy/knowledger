#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KclService } from '../../apps/api/service.ts';
import { actorIdentity, CHANNEL_ID, PERSONAS, demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';

function dataPath(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf('--data');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || !isAbsolute(value)) throw new Error('data path must be absolute');
  return value;
}

const dataDir = dataPath();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
const service = new KclService(ledger, vault, demoDefinition());
const actor = actorIdentity(PERSONAS[1]);
let stopped = false;

try {
  await service.initialize();
  await seedDemo(service);
  const draft = await service.draft(actor, {
    title: 'Resilience synthetic document',
    body_markdown: '# resilience-smoke-marker\n\nSynthetic recovery fixture.\n',
    context_id: 'context-fulfillment', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1',
    document_id: 'doc-resilience-smoke-001',
  });
  const preview = await service.preview(actor, { draft_id: draft.draft_id });
  const commandId = 'resilience-publish-001';
  const receipt = await service.publish(actor, { preview_id: preview.preview_id, confirm_shared: true, command_id: commandId });
  if (receipt.status !== 'committed') throw new Error('resilience fixture did not commit');
  process.stdout.write(`${JSON.stringify({ ready: true, draft_id: draft.draft_id, preview_id: preview.preview_id, command_id: commandId, checkpoint: receipt.checkpoint, event_count: ledger.events(0, 1000).length })}\n`);
  const timer = setInterval(() => undefined, 1_000);
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    ledger.close();
    vault.close();
    process.exit(0);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch {
  try { ledger.close(); } catch { /* ignore cleanup failure */ }
  try { vault.close(); } catch { /* ignore cleanup failure */ }
  process.stderr.write('resilience worker failed\n');
  process.exitCode = 1;
}
