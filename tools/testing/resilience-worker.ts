#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { actorIdentity, CHANNEL_ID, PERSONAS, demoDefinition } from '../../examples/order-workflow/config.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';

function dataPath(): string {
  const args = process.argv.slice(2);
  const index = args.indexOf('--data');
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || !isAbsolute(value)) throw new Error('data path must be absolute');
  return value;
}

/** 선택적 쓰기 루프 주기(ms) — 드릴이 프로세스를 실제 작업 중에 강제 종료하도록 한다. */
function writeEveryMs(): number {
  const args = process.argv.slice(2);
  const index = args.indexOf('--write-every');
  if (index < 0) return 0;
  const value = Number(args[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error('write interval must be positive');
  return value;
}

const dataDir = dataPath();
const writeEvery = writeEveryMs();
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const ledger = new LocalLedger(join(dataDir, 'shared-ledger.sqlite'), CHANNEL_ID);
const vault = new PrivateStore(join(dataDir, 'private-local.sqlite'));
const service = new KnowledgerService(ledger, vault, demoDefinition());
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
  // 쓰기 루프가 켜지면 실제 커밋이 진행 중인 상태로 강제 종료될 수 있게 계속 발행한다.
  let loopBusy = false;
  let loopWrites = 0;
  const timer = setInterval(() => {
    if (writeEvery <= 0 || loopBusy || stopped) return;
    loopBusy = true;
    loopWrites += 1;
    const tag = loopWrites;
    void (async () => {
      const loopDraft = await service.draft(actor, {
        title: 'Resilience loop document', body_markdown: '# resilience-loop\n',
        context_id: 'context-fulfillment', scope_id: 'scope-order-2026-001', usage_scope: 'domain-definition/v1',
        document_id: `doc-resilience-loop-${tag}`,
      });
      const loopPreview = await service.preview(actor, { draft_id: loopDraft.draft_id });
      await service.publish(actor, { preview_id: loopPreview.preview_id, confirm_shared: true, command_id: `resilience-loop-publish-${tag}` });
    })().catch((error: unknown) => {
      process.stderr.write(`resilience loop write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    }).finally(() => { loopBusy = false; });
  }, writeEvery > 0 ? writeEvery : 1_000);
  const finish = () => { ledger.close(); vault.close(); process.exit(0); };
  const close = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    // 진행 중인 루프 쓰기가 끝나면 닫는다 — 상한을 두어 정상 종료가 무한 대기하지 않게 한다.
    const deadline = Date.now() + 2_000;
    const drain = setInterval(() => { if (!loopBusy || Date.now() > deadline) { clearInterval(drain); finish(); } }, 10);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
} catch {
  try { ledger.close(); } catch { /* ignore cleanup failure */ }
  try { vault.close(); } catch { /* ignore cleanup failure */ }
  process.stderr.write('resilience worker failed\n');
  process.exitCode = 1;
}
