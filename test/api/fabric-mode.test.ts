import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import type { Actor, Checkpoint, LedgerEvent } from '../../packages/storage/local-ledger.ts';
import type { ApplicationLedger, CommittedReceipt, PendingReceipt } from '../../packages/storage/ledger-port.ts';
import type { DomainCommand } from '../../packages/domain/index.ts';
import { demoFixtures, PERSONAS, BOOTSTRAP_ACTOR } from '../../examples/order-workflow/config.ts';
import { createDemoApp as createApp } from '../../examples/order-workflow/application.ts';
import { KnowledgerService } from '../../apps/api/service.ts';
import { seedDemo } from '../../examples/order-workflow/application.ts';
import { demoDefinition } from '../../examples/order-workflow/config.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';

class FabricTestPort implements ApplicationLedger {
  readonly mode = 'fabric-test-network' as const;
  readonly channelId: string;
  refreshCount = 0;
  closeCount = 0;
  failRefresh = false;
  pendingNext = false;
  committedWithoutRecord = false;
  epochOverride: number | undefined;
  private local: LocalLedger;

  constructor(local: LocalLedger) { this.local = local; this.channelId = local.channelId; }
  async refresh(): Promise<void> { this.refreshCount++; if (this.failRefresh) throw new Error('peer unavailable'); await this.local.refresh(); }
  read(key: string, at?: Checkpoint | null): any | undefined { if (key === 'kcl:v1:eligibility_epoch' && !at && this.epochOverride !== undefined) return this.epochOverride; return this.local.read(key, at); }
  entries(prefix: string, at?: Checkpoint | null): [string, any][] { return this.local.entries(prefix, at); }
  checkpoint(): Checkpoint | null { return this.local.checkpoint(); }
  assertCheckpoint(at: Checkpoint): void { this.local.assertCheckpoint(at); }
  checkpointForTransaction(id: string): Checkpoint { return this.local.checkpointForTransaction(id); }
  checkpointForStateCreation(key: string): Checkpoint { return this.local.checkpointForStateCreation(key); }
  events(after?: number, limit?: number): LedgerEvent[] { return this.local.events(after, limit); }
  async execute(actor: Actor, command: DomainCommand): Promise<CommittedReceipt | PendingReceipt> {
    if (this.pendingNext) { this.pendingNext = false; return { status: 'pending', command_id: command.command_id, tx_id: `pending-${command.command_id}`, payload_digest: 'a'.repeat(64) }; }
    if (this.committedWithoutRecord) return { status: 'committed', result: { status: 'accepted' }, checkpoint: this.local.checkpoint()! };
    return this.local.execute(actor, command);
  }
  async bootstrap(actor: Actor, config: unknown): Promise<CommittedReceipt> { return this.local.bootstrap(actor, config); }
  close(): void { this.closeCount++; this.local.close(); }
}

async function preparedPort() {
  const local = new LocalLedger(':memory:', 'kcl-demo');
  await local.bootstrap(BOOTSTRAP_ACTOR, demoFixtures().config);
  return new FabricTestPort(local);
}

async function appFixture(t: any, port: FabricTestPort, personas = PERSONAS.slice(0, 3)) {
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-fabric-api-test-'));
  const app = await createApp({ dataDir, ledger: port, personas });
  const url = await app.listen(0);
  const sessionResponse = await fetch(`${url}/api/session`);
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
  const session = await sessionResponse.json() as any;
  t.after(async () => { await app.close(); rmSync(dataDir, { recursive: true, force: true }); });
  return { app, url, cookie, session };
}

test('Fabric mode does not seed and requires the injected signer list', async t => {
  const port = await preparedPort();
  const before = port.events(0, 1000).length;
  const api = await appFixture(t, port);
  assert.equal(port.events(0, 1000).length, before);
  assert.equal((await fetch(`${api.url}/api/session`)).status, 200);
  const response = await fetch(`${api.url}/api/session`, {
    method: 'POST', headers: { Cookie: api.cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.session.csrf_token },
    body: JSON.stringify({ org_id: 'FulfillmentMSP', actor_id: 'agent-knowledge-drafter' }),
  });
  assert.equal(response.status, 404);

  const missing = await preparedPort();
  const dataDir = mkdtempSync(join(tmpdir(), 'knowledger-fabric-api-missing-personas-'));
  await assert.rejects(() => createApp({ dataDir, ledger: missing }), /explicit signer persona list/);
  assert.equal(missing.closeCount, 1);
  rmSync(dataDir, { recursive: true, force: true });
});

test('pending Fabric commands return HTTP 202 without reading a receipt', async t => {
  const port = await preparedPort();
  const api = await appFixture(t, port);
  port.pendingNext = true;
  const response = await fetch(`${api.url}/v1/workspaces/demo/agreement-proposals`, {
    method: 'POST', headers: { Cookie: api.cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.session.csrf_token },
    body: JSON.stringify({ revision_digest: demoFixtures().revisions[1].revision_digest, policy_id: 'policy-fulfillment-v1', policy_version: 1, command_id: 'command-pending-fabric' }),
  });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, 'pending');
});

test('pending fence fails closed with HTTP 503', async t => {
  const port = await preparedPort();
  const api = await appFixture(t, port);
  port.pendingNext = true;
  const response = await fetch(`${api.url}/v1/workspaces/demo/resolve`, {
    method: 'POST', headers: { Cookie: api.cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.session.csrf_token },
    body: JSON.stringify({ document_ids: ['doc-pending-fence'], context_id: 'context-test', scope_id: 'scope-test', usage_scope: 'domain-definition/v1' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'FRESHNESS_UNAVAILABLE');
});

test('a committed receipt without an idempotency record fails closed', async t => {
  const port = await preparedPort();
  const api = await appFixture(t, port);
  port.committedWithoutRecord = true;
  const response = await fetch(`${api.url}/v1/workspaces/demo/agreement-proposals`, {
    method: 'POST', headers: { Cookie: api.cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.session.csrf_token },
    body: JSON.stringify({ revision_digest: demoFixtures().revisions[1].revision_digest, policy_id: 'policy-fulfillment-v1', policy_version: 1, command_id: 'command-missing-receipt' }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'PROJECTION_BEHIND');
});

test('resolve withholds a fence superseded after full block refresh', async t => {
  const local = new LocalLedger(':memory:', 'kcl-demo');
  const seedVault = new PrivateStore(':memory:');
  const seedService = new KnowledgerService(local, seedVault, demoDefinition());
  await seedService.initialize();
  await seedDemo(seedService);
  const port = new FabricTestPort(local);
  t.after(() => seedVault.close());
  const api = await appFixture(t, port, PERSONAS.slice(0, 3));
  port.epochOverride = 999;
  const fixture = demoFixtures().revisions[0].payload;
  const response = await fetch(`${api.url}/v1/workspaces/demo/resolve`, {
    method: 'POST', headers: { Cookie: api.cookie, Origin: api.url, 'Content-Type': 'application/json', 'X-KNOWLEDGER-CSRF': api.session.csrf_token },
    body: JSON.stringify({ document_ids: [fixture.document_id], context_id: fixture.context_id, scope_id: fixture.scope_id, usage_scope: fixture.usage_scope }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).reason, 'FENCE_SUPERSEDED');
});

test('readiness reports peer refresh failures while liveness stays available', async t => {
  const port = await preparedPort();
  const api = await appFixture(t, port);
  port.failRefresh = true;
  assert.equal((await fetch(`${api.url}/healthz`)).status, 200);
  await fetch(`${api.url}/readyz`); // Start one nonblocking, shared readiness probe.
  const response = await fetch(`${api.url}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json() as any;
  assert.equal(body.healthy, false);
  assert.equal(body.state, 'not-ready');
  assert.equal('channel_id' in body, false);
  assert.equal('message' in body, false);
});
