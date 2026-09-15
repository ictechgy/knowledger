/** Real three-application organization boundaries, shared Fabric agreement and scoped recovery. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DEVELOPMENT_ORGANIZATIONS } from '../examples/order-workflow/organizations.ts';
import type { DevelopmentOrganization } from '../examples/order-workflow/organizations.ts';
import { readRuntimeScope, ensureRuntimeScope } from '../packages/storage/runtime-scope.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../packages/storage/runtime-snapshot.ts';
import { OidcTestBrowser } from './oidc-test-browser.ts';

interface OrganizationApp { organization: DevelopmentOrganization; dataDir: string; origin: string; issuerOrigin: string; process?: ChildProcess; csrf: string }
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, '.data'), { recursive: true });
const directory = mkdtempSync(join(root, '.data/organization-smoke-'));
const runId = randomUUID().slice(0, 8);
const applications: OrganizationApp[] = [];
let phase = 'startup';

async function stopApplication(process: ChildProcess | undefined): Promise<void> {
  if (!process?.pid || process.exitCode !== null || process.signalCode !== null) return;
  const exited = new Promise<void>(resolve => process.once('exit', () => resolve()));
  process.kill('SIGTERM'); await exited;
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

async function startOrganization(organization: DevelopmentOrganization, restoredDataDir?: string, ports?: { app: number; issuer: number }): Promise<OrganizationApp> {
  if (!ports) {
    const first = await reservePort();
    let second: Awaited<ReturnType<typeof reservePort>> | undefined;
    try { second = await reservePort(); ports = { app: first.port, issuer: second.port }; }
    finally { await first.close(); await second?.close(); }
  }
  const origin = `http://127.0.0.1:${ports.app}`;
  const issuerOrigin = `http://127.0.0.1:${ports.issuer}`;
  const dataDir = restoredDataDir ?? join(directory, organization.org_id);
  const child = spawn(process.execPath, ['tools/development-auth.ts', '--organization', organization.org_id, '--port', String(ports.app), '--issuer-port', String(ports.issuer), '--data', dataDir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr?.on('data', () => {});
  let output = ''; let ready = false; let failed = false;
  child.once('error', () => { failed = true; });
  child.stdout?.on('data', chunk => {
    output = (output + String(chunk)).slice(-4096);
    if (output.includes(`KCL development login: ${origin}`)) ready = true;
  });
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (failed || child.exitCode !== null) throw new Error('Organization application exited during startup');
      if (ready) {
        const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(6000) });
        if (response.status === 200 && (await response.json()).healthy === true) return { organization, dataDir, origin, issuerOrigin, process: child, csrf: '' };
      }
      await delay(250);
    }
    throw new Error('Organization application did not become ready');
  } catch (error) { await stopApplication(child); throw error; }
}

try {
  for (const organization of DEVELOPMENT_ORGANIZATIONS) { phase = `startup ${organization.org_id}`; applications.push(await startOrganization(organization)); }
  assert.equal(new Set(applications.map(app => app.process!.pid)).size, 3);
  const browser = new OidcTestBrowser(applications.flatMap(app => [app.origin, app.issuerOrigin]));
  async function login(app: OrganizationApp) {
    assert.equal((await browser.login(app.origin, app.organization.subject)).status, 200);
    const response = await browser.request(`${app.origin}/api/session`);
    assert.equal(response.status, 200);
    const session = await response.json();
    assert.equal(session.actor.org_id, app.organization.org_id); assert.deepEqual(session.personas, []);
    app.csrf = session.csrf_token;
  }
  async function get(app: OrganizationApp, path: string, expected = 200): Promise<any> {
    const response = await browser.request(`${app.origin}${path.startsWith('/api/') ? path : `/v1/workspaces/demo${path}`}`);
    assert.equal(response.status, expected, `Scoped GET ${path}`);
    return response.json();
  }
  async function post(app: OrganizationApp, path: string, input: unknown, expected = 200): Promise<any> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await browser.request(`${app.origin}${path.startsWith('/api/') || path.startsWith('/auth/') ? path : `/v1/workspaces/demo${path}`}`, {
        method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json', 'X-KCL-CSRF': app.csrf }, body: JSON.stringify(input),
      });
      if (response.status === 204) { assert.equal(expected, 204); return {}; }
      const value = await response.json();
      if (response.status === 202 && expected === 200) { await delay(300); continue; }
      assert.equal(response.status, expected, `Scoped POST ${path}: ${value.code ?? value.status}`); return value;
    }
    throw new Error('Scoped command stayed pending');
  }
  phase = 'organization sessions and private drafts';
  const drafts = new Map<string, any>();
  for (const app of applications) {
    const anonymous = await get(app, '/api/session'); assert.equal(anonymous.actor, null);
    await login(app);
    const draft = await post(app, '/drafts', { title: `조직 비공개 ${runId}`, body_markdown: `PRIVATE_ORGANIZATION_${runId}_${app.organization.org_id}`, context_id: 'context-coordination', scope_id: 'scope-order-2026-001', usage_scope: 'review-invitation/v1' });
    drafts.set(app.organization.org_id, draft);
    assert.equal((await get(app, '/drafts')).total, 1);
    assert.equal(readRuntimeScope(app.dataDir)?.organization, app.organization.org_id);
    assert.deepEqual(readdirSync(app.dataDir).filter(name => name.endsWith('-outbox.sqlite')), [`${app.organization.org_id}-${app.organization.key_id}-outbox.sqlite`]);
  }
  for (const app of applications) {
    assert.equal((await get(app, '/api/session')).actor.org_id, app.organization.org_id);
    for (const other of applications.filter(value => value !== app)) await get(app, `/drafts/${drafts.get(other.organization.org_id).draft_id}`, 404);
    await post(app, '/api/session', { actor_id: 'person-sales-owner' }, 403);
    const wrongSubject = applications.find(other => other !== app)!.organization.subject;
    const stranger = new OidcTestBrowser([app.origin, app.issuerOrigin]);
    assert.equal((await stranger.login(app.origin, wrongSubject)).status, 403);
  }
  console.log('Organization scopes: independent sessions, own key/outbox routes, private draft boundaries passed');

  const [sales, fulfillment] = applications;
  phase = 'shared publication and human agreement';
  const overview = await get(sales, '/overview');
  const candidates = overview.documents.filter((doc: any) => doc.payload.document_id === 'doc-sales-order-definition-001');
  const base = candidates.find((doc: any) => doc.eligible) ?? candidates.at(-1); assert.ok(base);
  const draft = await post(sales, '/drafts', { base_revision_digest: base.revision_digest, title: `조직 실행 검증 ${runId}`, body_markdown: `# Scoped Fabric agreement ${runId}\n\n공유를 명시적으로 확인한 테스트 본문입니다.` });
  const preview = await post(sales, '/publication-previews', { draft_id: draft.draft_id });
  const published = await post(sales, '/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: `scoped-publish-${runId}` });
  const otherOverview = await get(fulfillment, '/overview');
  assert.ok(otherOverview.documents.some((doc: any) => doc.revision_digest === draft.revision.revision_digest));
  assert.equal(JSON.stringify(otherOverview).includes(`PRIVATE_ORGANIZATION_${runId}`), false);
  const proposal = await post(sales, '/agreement-proposals', { revision_digest: draft.revision.revision_digest, policy_id: 'policy-sales-v1', policy_version: 1, command_id: `scoped-propose-${runId}` });
  await post(fulfillment, `/agreement-proposals/${proposal.result.proposal_id}/decisions`, { decision: 'approve', rationale: 'wrong organization', command_id: `scoped-wrong-${runId}` }, 403);
  await post(sales, `/agreement-proposals/${proposal.result.proposal_id}/decisions`, { decision: 'approve', rationale: '본 조직의 지정 책임자가 원문을 검토했습니다.', command_id: `scoped-approve-${runId}` });
  const active = await post(sales, `/agreement-proposals/${proposal.result.proposal_id}/activate`, { expected_active_agreement_id: candidates.find((doc: any) => doc.eligible)?.agreement.agreement_id ?? null, command_id: `scoped-activate-${runId}` });
  const scope = { document_ids: [base.payload.document_id], context_id: base.payload.context_id, scope_id: base.payload.scope_id, usage_scope: base.payload.usage_scope };
  assert.equal((await post(sales, '/resolve', scope)).status, 'provided');
  await post(sales, `/agreements/${active.result.agreement_id}/withdraw`, { reason: '조직 실행 검증 종료', command_id: `scoped-withdraw-${runId}` });
  assert.equal((await post(sales, '/resolve', scope)).status, 'withheld');
  await post(sales, '/auth/logout', {}, 204);
  assert.equal((await get(fulfillment, '/api/session')).actor.org_id, fulfillment.organization.org_id);

  phase = 'scoped backup and restore';
  await stopApplication(sales.process); sales.process = undefined;
  const snapshotDir = join(directory, 'sales-snapshot');
  const restoredDir = join(directory, 'sales-restored');
  const backup = createRuntimeSnapshot({ dataDir: sales.dataDir, snapshotDir });
  assert.equal(backup.mode, 'fabric-scoped'); assert.equal(backup.organization, 'SalesMSP');
  restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
  assert.throws(() => ensureRuntimeScope(restoredDir, fulfillment.organization));
  assert.throws(() => ensureRuntimeScope(restoredDir));
  const restarted = await startOrganization(sales.organization, restoredDir, { app: Number(new URL(sales.origin).port), issuer: Number(new URL(sales.issuerOrigin).port) });
  sales.process = restarted.process; sales.dataDir = restoredDir;
  assert.equal((await get(sales, '/api/session')).actor, null);
  await login(sales);
  for (const other of applications.filter(app => app !== sales)) assert.equal((await get(other, '/api/session')).actor.org_id, other.organization.org_id);
  assert.equal((await get(sales, '/drafts')).total, 2);
  assert.deepEqual(await get(sales, `/drafts/${drafts.get('SalesMSP').draft_id}`), drafts.get('SalesMSP'));
  assert.equal((await post(sales, '/resolve', scope)).status, 'withheld');
  const evidence = { verified_at: new Date().toISOString(), passed: true, organizations: applications.map(app => app.organization.org_id), publication_checkpoint: published.checkpoint,
    independent_app_processes: true, isolated_sessions: true, other_sessions_survive_restart: true, private_draft_boundaries: true, one_outbox_per_organization: true, foreign_subject_rejected: true, wrong_org_approval_rejected: true,
    shared_revision_visible: true, human_activation_provided: true, withdrawal_withheld: true, scoped_snapshot_restored: true, wrong_scope_restore_rejected: true };
  writeFileSync(join(directory, 'organization-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`Organization acceptance passed. Evidence: ${join(directory, 'organization-evidence.json')}`);
} catch {
  console.error(`Organization acceptance failed during ${phase}.`); process.exitCode = 1;
} finally {
  for (const app of applications.reverse()) {
    await stopApplication(app.process);
  }
}
