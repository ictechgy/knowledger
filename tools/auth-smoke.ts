/** Real OIDC and Fabric acceptance test with a separate key-holding process. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startDevelopmentIssuer } from '../examples/order-workflow/issuer.ts';
import { OidcAuthentication } from '../packages/auth/oidc.ts';
import { createDemoApp as createApp } from '../examples/order-workflow/application.ts';
import { createFabricTestRuntime } from '../examples/order-workflow/fabric-runtime.ts';
import { createDevelopmentAuthRuntime } from '../examples/order-workflow/auth-runtime.ts';
import { createRuntimeSnapshot, restoreRuntimeSnapshot } from '../packages/storage/runtime-snapshot.ts';
import { PERSONAS, actorIdentity } from '../examples/order-workflow/config.ts';
import { attestationSlot, createRemoteSigner } from '../packages/fabric/remote-signer.ts';
import { DEVELOPMENT_SIGNING_KEY_IDS } from '../examples/order-workflow/signing-service.ts';
import { OidcTestBrowser } from './oidc-test-browser.ts';
import { DatabaseSync } from 'node:sqlite';

const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, '.data'), { recursive: true });
const dataDir = mkdtempSync(join(root, '.data/auth-smoke-'));
const socketPath = join(mkdtempSync('/tmp/knowledger-auth-sign-'), 'sign.sock');
const runId = randomUUID().slice(0, 8);
let signer: ChildProcess | undefined;
let app: Awaited<ReturnType<typeof createApp>> | undefined;
let issuer: Awaited<ReturnType<typeof startDevelopmentIssuer>> | undefined;
let releaseSubmission: (() => void) | undefined;
let phase = 'startup';

async function startSigner() {
  signer = spawn(process.execPath, ['infra/fabric/signing-service.ts', '--socket', socketPath, '--demo'], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  signer.stderr?.on('data', () => {});
  for (let attempt = 0; !existsSync(socketPath); attempt++) {
    if (signer.exitCode !== null || attempt > 50) throw new Error('Signing process did not start');
    await delay(100);
  }
}
async function stopSigner() {
  if (signer && signer.exitCode === null) { const exited = new Promise<void>(resolve => signer!.once('exit', () => resolve())); signer.kill('SIGTERM'); await exited; }
  signer = undefined;
}
async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}

try {
  await startSigner();
  const origin = `http://127.0.0.1:${await freePort()}`;
  issuer = await startDevelopmentIssuer({ port: 0, redirectUri: `${origin}/auth/callback` });
  const subjects = new Map(['dev-sales-owner', 'dev-fulfillment-owner', 'dev-settlement-owner'].map((subject, index) => [subject, actorIdentity(PERSONAS[index])]));
  const authentication = await OidcAuthentication.create({ issuer: issuer.issuer, clientId: 'knowledger-development-client', redirectUri: `${origin}/auth/callback`, development: true,
    authorizationVersionClaim: 'account_version', resolveActor: (receivedIssuer, subject) => receivedIssuer === issuer!.issuer ? subjects.get(subject) : undefined });
  let pauseNextSubmit = false;
  let submissionReached: (() => void) | undefined;
  let submissionGate: Promise<void> | undefined;
  const runtime = await createFabricTestRuntime(dataDir, {
    signerProvider: (actor, certificate, attestation) => {
      const keyId = DEVELOPMENT_SIGNING_KEY_IDS.find(id => id === actor.actor_id); assert.ok(keyId);
      return createRemoteSigner({ socketPath, keyId, certificate, attestation: attestation === undefined ? undefined : attestationSlot(attestation) });
    },
    authorizeActor: async (actor, phase) => {
      if (phase === 'submit' && pauseNextSubmit) { pauseNextSubmit = false; submissionReached?.(); await submissionGate; }
      await authentication.assertCurrentActor(actor);
    },
  });
  app = await createApp({ dataDir, ...runtime, authentication });
  await app.listen(Number(new URL(origin).port));
  const browser = new OidcTestBrowser([origin, issuer.issuer]);
  let csrf = '';
  async function login(subject: string) {
    assert.equal((await browser.login(origin, subject)).status, 200);
    const response = await browser.request(`${origin}/api/session`); const session = await response.json();
    assert.equal(session.personas.length, 0); assert.equal(session.auth_mode, 'oidc-development'); csrf = session.csrf_token;
    return session;
  }
  async function post(path: string, input: unknown, expected = 200): Promise<any> {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await browser.request(`${origin}${path.startsWith('/api/') || path.startsWith('/auth/') ? path : '/v1/workspaces/demo' + path}`, {
        method: 'POST', headers: { Origin: origin, 'X-KNOWLEDGER-CSRF': csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      if (response.status === 204) { assert.equal(expected, 204); return {}; }
      const value = await response.json();
      if (response.status === 202 && expected === 200) { await delay(300); continue; }
      assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`); return value;
    }
    throw new Error('Command stayed pending');
  }
  async function get(path: string, expected = 200): Promise<any> {
    const response = await browser.request(`${origin}/v1/workspaces/demo${path}`);
    const value = await response.json();
    assert.equal(response.status, expected, `${path}: ${value.code ?? value.status}`);
    return value;
  }
  assert.equal((await browser.request(`${origin}/v1/workspaces/demo/overview`)).status, 401);
  const initialSession = await (await browser.request(`${origin}/api/session`)).json(); assert.equal(initialSession.actor, null);
  phase = 'login and publication';
  assert.equal((await login('dev-sales-owner')).actor.actor_id, 'person-sales-owner');
  await post('/api/session', { org_id: 'SettlementMSP', actor_id: 'person-settlement-owner' }, 403);
  const overview = await (await browser.request(`${origin}/v1/workspaces/demo/overview`)).json();
  const candidates = overview.documents.filter((doc: any) => doc.payload.document_id === 'doc-sales-order-definition-001');
  const base = candidates.find((doc: any) => doc.eligible) ?? candidates.at(-1); assert.ok(base);
  const scope = { document_ids: [base.payload.document_id], context_id: base.payload.context_id, scope_id: base.payload.scope_id, usage_scope: base.payload.usage_scope };
  const importedBody = `\uFEFF# OIDC Markdown acceptance ${runId}\r\n\r\n개발용 계정의 명시적 가져오기·승인 검증입니다.\r\n`;
  const importFilename = `private-source-${runId}.md`;
  const importInput = { import_id: `markdown-${runId}`, filename: importFilename, content_base64: Buffer.from(importedBody).toString('base64'), base_revision_digest: base.revision_digest, title: `OIDC 승인 검증 ${runId}` };
  phase = 'Markdown import';
  await runtime.ledger.refresh(); const beforeImport = runtime.ledger.checkpoint();
  const importedDraft = await post('/draft-imports/markdown', importInput);
  assert.equal(importedDraft.revision.payload.body_markdown, importedBody);
  assert.deepEqual(await post('/draft-imports/markdown', importInput), importedDraft);
  await runtime.ledger.refresh(); assert.deepEqual(runtime.ledger.checkpoint(), beforeImport);
  const firstList = await get('/drafts'); assert.equal(firstList.total, 1);
  assert.equal(firstList.drafts[0].draft_id, importedDraft.draft_id);
  assert.equal(JSON.stringify(firstList).includes(importFilename), false);
  assert.deepEqual(await get(`/drafts/${importedDraft.draft_id}`), importedDraft);
  await login('dev-fulfillment-owner'); await post('/publication-previews', { draft_id: importedDraft.draft_id }, 404);
  assert.equal((await get('/drafts')).total, 0); await get(`/drafts/${importedDraft.draft_id}`, 404);
  await login('dev-sales-owner');
  phase = 'private draft editing';
  assert.deepEqual(await get(`/drafts/${importedDraft.draft_id}`), importedDraft);
  const editInput = { edit_id: `edit-${runId}`, title: `다시 검토한 OIDC 문서 ${runId}`, body_markdown: `${importedBody}\r\n다시 연 초안의 검토 내용을 추가합니다.\r\n` };
  const draft = await post(`/drafts/${importedDraft.draft_id}/edits`, editInput);
  assert.deepEqual(await post(`/drafts/${importedDraft.draft_id}/edits`, editInput), draft);
  assert.deepEqual(await get(`/drafts/${importedDraft.draft_id}`), importedDraft);
  assert.equal(draft.revision.payload.document_id, importedDraft.revision.payload.document_id);
  await runtime.ledger.refresh(); assert.deepEqual(runtime.ledger.checkpoint(), beforeImport);
  const preview = await post('/publication-previews', { draft_id: draft.draft_id });
  phase = 'Markdown publication';
  const publication = await post('/revisions', { preview_id: preview.preview_id, confirm_shared: true, command_id: `oidc-publish-${runId}` });
  const publicationEvents = runtime.ledger.events(publication.checkpoint.block_number - 1, 1);
  assert.ok(publicationEvents.some(event => event.checkpoint.transaction_id === publication.checkpoint.transaction_id));
  assert.equal(JSON.stringify(publicationEvents).includes(importFilename), false);
  const proposalInput = { revision_digest: draft.revision.revision_digest, policy_id: 'policy-sales-v1', policy_version: 1, command_id: `oidc-propose-${runId}` };
  const proposed = await post('/agreement-proposals', proposalInput);
  const proposalId = proposed.result.proposal_id;
  phase = 'account revocation';
  issuer.setAccountEnabled('dev-sales-owner', false);
  await post(`/agreement-proposals/${proposalId}/decisions`, { command_id: `oidc-disabled-${runId}`, decision: 'approve', rationale: 'Must be rejected' }, 401);
  issuer.setAccountEnabled('dev-sales-owner', true); await login('dev-sales-owner');
  issuer.setAccountVersion('dev-sales-owner', 2);
  await post(`/agreement-proposals/${proposalId}/decisions`, { command_id: `oidc-version-${runId}`, decision: 'approve', rationale: 'Must reauthenticate' }, 401);
  await login('dev-sales-owner');
  const approval = await post(`/agreement-proposals/${proposalId}/decisions`, { command_id: `oidc-approve-${runId}`, decision: 'approve', rationale: 'Development account reviewed the exact document.' });
  const active = await post(`/agreement-proposals/${proposalId}/activate`, { command_id: `oidc-activate-${runId}`, expected_active_agreement_id: candidates.find((doc: any) => doc.eligible)?.agreement.agreement_id ?? null });
  assert.equal((await post('/resolve', scope)).status, 'provided');
  console.log('OIDC + Fabric: subject binding, role-switch rejection, private draft and account/version revocation passed');

  phase = 'logout before submission';
  await runtime.ledger.refresh(); const beforeCancelled = runtime.ledger.checkpoint();
  const reached = new Promise<void>(resolve => { submissionReached = resolve; });
  submissionGate = new Promise<void>(resolve => { releaseSubmission = resolve; }); pauseNextSubmit = true;
  const cancelled = post('/agreement-proposals', { ...proposalInput, command_id: `oidc-cancelled-${runId}` }, 403);
  await Promise.race([reached, delay(10000).then(() => { throw new Error('Submission gate was not reached'); })]);
  await post('/auth/logout', {}, 204); assert.ok(releaseSubmission); releaseSubmission(); await cancelled;
  await runtime.ledger.refresh(); assert.deepEqual(runtime.ledger.checkpoint(), beforeCancelled);
  const outbox = new DatabaseSync(join(dataDir, 'SalesMSP-person-sales-owner-outbox.sqlite'), { readOnly: true });
  try {
    const row = outbox.prepare('SELECT status FROM fabric_outbox_attempts WHERE command_id = ?').get(`oidc-cancelled-${runId}`);
    assert.equal(row?.status, 'cancelled');
  } finally { outbox.close(); }
  await runtime.ledger.recoverPending();
  console.log('OIDC revocation: logout after endorsement prevented submission; no new ledger block');
  await login('dev-sales-owner');
  phase = 'signing service failure and recovery';
  await stopSigner(); await post('/resolve', scope, 503); await startSigner();
  assert.equal((await post('/resolve', scope)).status, 'provided');
  await post(`/agreements/${active.result.agreement_id}/withdraw`, { command_id: `oidc-withdraw-${runId}`, reason: 'End of development OIDC scenario' });
  assert.equal((await post('/resolve', scope)).status, 'withheld');
  await post('/auth/logout', {}, 204);
  assert.equal((await browser.request(`${origin}/v1/workspaces/demo/overview`)).status, 401);
  phase = 'offline backup and restore';
  const beforeRestore = runtime.ledger.checkpoint();
  await app.close(); app = undefined;
  const snapshotDir = join(root, '.data', `auth-snapshot-${runId}`);
  const restoredDir = join(root, '.data', `auth-restored-${runId}`);
  const snapshot = createRuntimeSnapshot({ dataDir, snapshotDir });
  const restored = restoreRuntimeSnapshot({ snapshotDir, dataDir: restoredDir });
  assert.equal(snapshot.mode, 'fabric'); assert.equal(restored.mode, 'fabric');
  const restoredRuntime = await createDevelopmentAuthRuntime({ dataDir: restoredDir, origin, issuer: issuer.issuer, socketPath });
  app = await createApp({ dataDir: restoredDir, ...restoredRuntime });
  await app.listen(Number(new URL(origin).port));
  assert.deepEqual(restoredRuntime.ledger.checkpoint(), beforeRestore);
  assert.equal((await (await browser.request(`${origin}/api/session`)).json()).actor, null);
  await login('dev-sales-owner');
  const restoredList = await get('/drafts'); assert.equal(restoredList.total, 2);
  assert.deepEqual(await get(`/drafts/${importedDraft.draft_id}`), importedDraft);
  assert.deepEqual(await get(`/drafts/${draft.draft_id}`), draft);
  assert.deepEqual(await post(`/drafts/${importedDraft.draft_id}/edits`, editInput), draft);
  assert.equal((await post('/resolve', scope)).status, 'withheld');
  await post('/auth/logout', {}, 204);
  console.log('Offline recovery: Fabric projection, private drafts, edit retries and withdrawal state restored');
  const evidence = { verified_at: new Date().toISOString(), mode: 'oidc-development-fabric', passed: true, publication_checkpoint: publication.checkpoint, approval_checkpoint: approval.checkpoint,
    no_anonymous_actor: true, markdown_import_exact_bytes: true, markdown_import_idempotent: true, markdown_import_no_ledger_write: true, import_filename_private_after_publish: true, private_draft_list_isolated: true, private_draft_reopened_and_edited: true, offline_snapshot_restored: true, restored_edit_idempotent: true, restored_withdrawal_withheld: true, snapshot_directory: snapshotDir, restored_directory: restoredDir, role_switch_rejected: true, disabled_account_rejected: true, changed_version_rejected: true, logout_prevented_submit: true, cancelled_outbox_terminal: true, separate_signer_failure_status: 503, signer_recovery: true, withdrawal_withheld: true };
  writeFileSync(join(dataDir, 'auth-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  console.log(`OIDC acceptance passed. Evidence: ${join(dataDir, 'auth-evidence.json')}`);
} catch {
  console.error(`OIDC acceptance failed during ${phase}.`); process.exitCode = 1;
} finally { releaseSubmission?.(); await app?.close(); await issuer?.close(); await stopSigner(); }
