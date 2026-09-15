/** Real HTTP acceptance scenario; preserves the existing Fabric ledger. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../..', import.meta.url));
mkdirSync(join(root, '.data'), { recursive: true });
const dataDir = mkdtempSync(join(root, '.data/fabric-http-smoke-'));
const run = randomUUID().slice(0, 8);
const evidence: Record<string, unknown> = { mode: 'real-fabric-http', run_id: run };
let child: ChildProcess | undefined;
let exited: Promise<void> | undefined;
let url = '';
let cookie = '';
let csrf = '';
let pausedPeer = false;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function waitHealthy() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child?.exitCode !== null) throw new Error('HTTP application exited before becoming ready');
    try { const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(6000) }); if (response.status === 200) return await response.json() as any; } catch { /* Startup or reconnect is still in progress. */ }
    await delay(200);
  }
  throw new Error('HTTP application did not become healthy');
}

async function start() {
  const port = await freePort(); url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['apps/api/main.ts', '--demo', '--port', String(port), '--data', dataDir, '--ledger', 'fabric-test-network'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  // Drain output without printing auth material or unbounded child error traces.
  child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
  exited = new Promise<void>((resolve, reject) => { child!.once('error', reject); child!.once('exit', () => resolve()); });
  const health = await waitHealthy();
  assert.equal(health.mode, 'fabric-test-network');
  const response = await fetch(`${url}/api/session`);
  cookie = response.headers.get('set-cookie')!.split(';')[0];
  const session = await response.json() as any; csrf = session.csrf_token;
  assert.equal(session.personas.length, 3);
  assert.ok(session.personas.every((persona: any) => persona.kind === 'human'));
}

async function stop() {
  if (child && child.exitCode === null) child.kill('SIGTERM');
  await exited; child = undefined; exited = undefined;
}

async function get(path: string) {
  const response = await fetch(`${url}/v1/workspaces/demo${path}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200, `GET ${path}`);
  return await response.json() as any;
}

async function post(path: string, input: unknown, expected = 200): Promise<any> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await fetch(`${url}${path.startsWith('/api/') ? path : '/v1/workspaces/demo' + path}`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'Content-Type': 'application/json', 'X-KCL-CSRF': csrf }, body: JSON.stringify(input) });
    const value = await response.json() as any;
    if (response.status === 202 && expected === 200) { await delay(300); continue; }
    assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    if (path === '/api/session' && response.ok) csrf = value.csrf_token;
    return value;
  }
  throw new Error(`Commit projection remained pending: ${path}`);
}

function peer(action: 'stop' | 'start') {
  const result = spawnSync(join(root, '.tools/docker-compose'), ['--context', 'colima', '-p', 'kcl-fabric-smoke', '-f', join(root, '.data/fabric-smoke/compose.json'), action, 'peer0.fulfillment.kcl.test'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, `Test peer ${action} failed`);
}

try {
  await start();
  await post('/api/session', { actor_id: 'agent-knowledge-drafter' }, 404);
  await post('/api/session', { actor_id: 'person-sales-owner' });
  const initial = await get('/overview');
  const candidates = initial.documents.filter((doc: any) => doc.payload.document_id === 'doc-sales-order-definition-001');
  const base = candidates.find((doc: any) => doc.eligible) ?? candidates.at(-1);
  assert.ok(base);
  const scope = { document_ids: [base.payload.document_id], context_id: base.payload.context_id, scope_id: base.payload.scope_id, usage_scope: base.payload.usage_scope };
  const body = `# Fabric HTTP acceptance ${run}\n\n공유 검토를 통과한 가상 영업 정의입니다.\n`;
  const draft = await post('/drafts', { base_revision_digest: base.revision_digest, title: `Fabric HTTP 검증 ${run}`, body_markdown: body, source_kind: 'human_authored' });
  assert.equal(JSON.stringify(await get('/events?cursor=0')).includes(`Fabric HTTP acceptance ${run}`), false);
  await post('/api/session', { actor_id: 'person-fulfillment-owner' });
  await post('/publication-previews', { draft_id: draft.draft_id }, 404);
  await post('/api/session', { actor_id: 'person-sales-owner' });
  const preview = await post('/publication-previews', { draft_id: draft.draft_id });
  await post('/revisions', { preview_id: preview.preview_id, confirm_shared: false, command_id: `http-no-confirm-${run}` }, 400);
  const published = await post('/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: `http-publish-${run}` });
  assert.equal(published.status, 'committed');
  assert.equal(JSON.stringify(await get('/events?cursor=0')).includes(`Fabric HTTP acceptance ${run}`), true);
  const proposed = await post('/agreement-proposals', { revision_digest: draft.revision.revision_digest, policy_id: 'policy-sales-v1', policy_version: 1, command_id: `http-propose-${run}` });
  const proposalId = proposed.result.proposal_id;
  const activate = { expected_active_agreement_id: candidates.find((doc: any) => doc.eligible)?.agreement?.agreement_id ?? null, command_id: `http-activate-${run}` };
  await post(`/agreement-proposals/${proposalId}/activate`, activate, 409);
  await post('/api/session', { actor_id: 'person-fulfillment-owner' });
  await post(`/agreement-proposals/${proposalId}/decisions`, { decision: 'approve', rationale: 'Unauthorized fixture', command_id: `http-unauthorized-${run}` }, 403);
  await post('/api/session', { actor_id: 'person-sales-owner' });
  const decision = { decision: 'approve', rationale: 'Fictional owner reviewed the complete revision.', command_id: `http-approve-${run}` };
  const approved = await post(`/agreement-proposals/${proposalId}/decisions`, decision);
  const active = await post(`/agreement-proposals/${proposalId}/activate`, activate);
  const packet = await post('/resolve', { ...scope, query: `PRIVATE_QUERY_${run}` });
  assert.equal(packet.status, 'provided'); assert.equal(packet.documents[0].body_markdown, body);
  assert.equal(JSON.stringify(await get('/events?cursor=0')).includes(`PRIVATE_QUERY_${run}`), false);
  console.log('HTTP VALID: private draft boundary, publication confirmation, authorization, approval and activation');

  pausedPeer = true; peer('stop');
  const unavailable = await fetch(`${url}/healthz`);
  assert.equal(unavailable.status, 503);
  await post('/resolve', scope, 503);
  peer('start'); pausedPeer = false;
  await waitHealthy();
  assert.equal((await post('/resolve', scope)).status, 'provided');
  console.log('HTTP FAIL-CLOSED: peer stopped -> 503, restarted -> fresh provided result');

  await stop(); await start();
  await post('/api/session', { actor_id: 'person-sales-owner' });
  const retried = await post(`/agreement-proposals/${proposalId}/decisions`, decision);
  assert.deepEqual(retried.checkpoint, approved.checkpoint);
  assert.deepEqual(retried.result, approved.result);
  const oldRun = await post(`/runs/${packet.manifest.run_id}/revalidate`, { action: 'use-context' });
  assert.equal(oldRun.reason, 'SESSION_RESTARTED_RESOLVE_AGAIN');
  const restored = await post('/resolve', scope);
  assert.equal(restored.status, 'provided'); assert.equal(restored.documents[0].revision_digest, draft.revision.revision_digest);
  await post(`/agreements/${active.result.agreement_id}/withdraw`, { reason: 'End of fictional HTTP acceptance scenario', command_id: `http-withdraw-${run}` });
  assert.equal((await post(`/runs/${restored.manifest.run_id}/revalidate`, { action: 'use-context' })).status, 'withheld');
  console.log('HTTP RESTART: durable projection and original receipt restored; fresh withdrawal withheld');
  Object.assign(evidence, { passed: true, publication_checkpoint: published.checkpoint, approval_checkpoint: approved.checkpoint, activation_checkpoint: active.checkpoint, private_draft_isolated: true, peer_unavailable_status: 503, restarted_receipt_matches: true, stale_run_withheld: true, withdrawal_withheld: true, verified_at: new Date().toISOString() });
  writeFileSync(join(dataDir, 'http-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`Evidence: ${join(dataDir, 'http-evidence.json')}`);
} finally {
  if (pausedPeer) peer('start');
  await stop();
}
