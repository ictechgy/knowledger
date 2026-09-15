/** Real-network acceptance test using only the disposable test-network.py MSPs. */
import assert from 'node:assert/strict';
import { createPrivateKey } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { demoFixtures, PERSONAS, slotFields } from '../../apps/api/demo-config.ts';
import { idempotencyDigest, keyFor, resolveAt } from '../../packages/domain/index.ts';
import { connectOfficialFabricGateway, FabricGatewayTransport } from '../../packages/fabric/gateway.ts';
import { SqliteOutbox } from '../../packages/fabric/sqlite-outbox.ts';
import type { FabricGatewayClient, GatewayCommand } from '../../packages/fabric/types.ts';

const root = fileURLToPath(new URL('../..', import.meta.url));
const state = join(root, '.data/fabric-smoke');
const require = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
const grpc = require('@grpc/grpc-js');
const sdk = require('@hyperledger/fabric-gateway');
const fixtures = demoFixtures();
const names = ['sales', 'fulfillment', 'settlement'];
const evidence: Record<string, unknown> = { mode: 'real-fabric', channel: 'kcl-demo', fictional_test_identities: true };

async function connect(index: number, outboxName = `outbox-${names[index]}`) {
  const domain = `${names[index]}.kcl.test`;
  const base = join(state, 'crypto/peerOrganizations', domain);
  const msp = join(base, 'users', `User1@${domain}`, 'msp');
  const keyFiles = readdirSync(join(msp, 'keystore')).filter(name => name.endsWith('_sk'));
  assert.equal(keyFiles.length, 1, 'Expected one disposable signing key');
  const privateKey = createPrivateKey(readFileSync(join(msp, 'keystore', keyFiles[0])));
  const credentials = {
    msp_id: PERSONAS[index].org_id,
    certificate: readFileSync(join(msp, 'signcerts', `User1@${domain}-cert.pem`)),
    signer: sdk.signers.newPrivateKeySigner(privateKey),
  };
  const rpc = new grpc.Client(`127.0.0.1:${17051 + index * 1000}`, grpc.credentials.createSsl(readFileSync(join(base, 'peers', `peer0.${domain}`, 'tls/ca.crt'))), {
    'grpc.ssl_target_name_override': `peer0.${domain}`, 'grpc.default_authority': `peer0.${domain}`,
  });
  const client = await connectOfficialFabricGateway({ client: rpc, channel_id: 'kcl-demo', chaincode_name: 'kcl', credentials });
  const gateway = sdk.connect({ client: rpc, identity: { mspId: credentials.msp_id, credentials: credentials.certificate }, signer: credentials.signer,
    evaluateOptions: () => ({ deadline: Date.now() + 10000 }), blockEventsOptions: () => ({ deadline: Date.now() + 30000 }) });
  const outbox = new SqliteOutbox(join(state, `${outboxName}.sqlite`));
  return { client, gateway, outbox, transport: new FabricGatewayTransport({ client, outbox }),
    close() { outbox.close(); client.close?.(); gateway.close(); rpc.close(); } };
}

function command(index: number, command_id: string, type: string, input: unknown): GatewayCommand {
  return { command_id, actor_org_id: PERSONAS[index].org_id, type, input };
}

async function submitForRestart(loseResponse: boolean) {
  const suffix = loseResponse ? 'response-lost' : 'restart';
  const connection = await connect(1, `outbox-${suffix}`);
  const cmd = command(1, `smoke-${suffix}`, 'fence', { nonce: `smoke-fence-${suffix}-001` });
  try {
    if (loseResponse) {
      const base = connection.client;
      const faulty: FabricGatewayClient = {
        async newProposal(cmd) {
          const proposal = await base.newProposal(cmd);
          return { tx_id: proposal.tx_id, async endorse() {
            const endorsement = await proposal.endorse();
            return { ...endorsement, async submit() { await endorsement.submit(); throw new Error('Injected lost submit response'); } };
          } };
        },
        async getStatus() { throw new Error('Injected unavailable status response'); },
        async getAuthoritativeCommandResult() { throw new Error('Injected unavailable query response'); },
      };
      const result = await new FabricGatewayTransport({ client: faulty, outbox: connection.outbox }).execute(cmd);
      assert.equal(result.status, 'pending');
    } else {
      const proposal = await connection.client.newProposal(cmd);
      await connection.outbox.recordAttempt({ command_id: cmd.command_id, actor_org_id: cmd.actor_org_id, payload_digest: idempotencyDigest(cmd), tx_id: proposal.tx_id, status: 'pending' });
      const endorsed = await proposal.endorse();
      await endorsed.submit();
      await connection.outbox.updateAttempt(proposal.tx_id, { status: 'acknowledged', commit_bytes: await endorsed.getCommitBytes!() });
      // Deliberately exit before calling getStatus. Parent starts a new SDK client.
    }
  } finally { connection.close(); }
}

async function run() {
  assert.equal(existsSync(join(state, 'evidence.json')), false, 'This completed smoke network is immutable; inspect evidence.json or create a separate reviewed network');
  const connections = await Promise.all([0, 1, 2].map(index => connect(index)));
  const transactions: { command_id: string; tx_id: string }[] = [];
  async function execute(index: number, id: string, type: string, input: unknown) {
    const result = await connections[index].transport.execute(command(index, id, type, input));
    assert.equal(result.status, 'valid', `${id}: expected peer-confirmed VALID`);
    transactions.push({ command_id: id, tx_id: result.tx_id });
    return result.result as any;
  }
  try {
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'infra/fabric/genesis.json'), 'utf8')), fixtures.config);
    for (const [index, revision] of fixtures.revisions.entries()) {
      const actor = index === 3 ? 1 : index;
      await execute(actor, `smoke-publish-${index}`, 'publish_revision', { revision, publication: { revision_digest: revision.revision_digest, config_version: 1, membership_epoch: 1 } });
      await execute(actor, `smoke-propose-${index}`, 'propose', { proposal_id: `smoke-proposal-${index}`, revision_digest: revision.revision_digest, policy_id: fixtures.policies[index].policy_id, policy_version: 1 });
      const representatives = index === 3 ? [1, 2] : [index];
      for (const rep of representatives) {
        const decision = {
          contract_type: 'ApprovalDecision', contract_version: 1, decision_id: `smoke-decision-${index}-${rep}`,
          ...slotFields(revision.payload), revision_digest: revision.revision_digest,
          policy_id: fixtures.policies[index].policy_id, policy_version: 1, membership_epoch: 1, role_binding_version: 1,
          actor_org_id: PERSONAS[rep].org_id, actor_id: PERSONAS[rep].actor_id, subject_id: `smoke-subject-${rep}`,
          actor_domain_role: `${names[rep]}_owner`, decision: 'approve', rationale: 'Fictional fixture approval for integration testing.',
          decided_at: '2026-09-15T00:00:00Z', proposal_id: `smoke-proposal-${index}`,
        };
        await execute(rep, `smoke-decide-${index}-${rep}`, 'decide', { decision });
      }
      const result = await execute(actor, `smoke-activate-${index}`, 'activate', { proposal_id: `smoke-proposal-${index}`, agreement_id: `smoke-agreement-${index}`, expected_active_agreement_id: null });
      assert.equal(result.status, 'active');
      console.log(`VALID: published, approved and activated document ${index + 1}/4`);
    }
    // An authenticated Sales owner cannot submit a Fulfillment decision.
    const unauthorized = await connections[0].client.newProposal(command(0, 'smoke-unauthorized', 'withdraw', { agreement_id: 'smoke-agreement-2', reason: 'Unauthorized test' }));
    await assert.rejects(() => unauthorized.endorse());
    evidence.unauthorized_endorsement_rejected = true;

    for (const loseResponse of [false, true]) {
      const suffix = loseResponse ? 'response-lost' : 'restart';
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), loseResponse ? '--lose-response' : '--submit-only'], { cwd: root, encoding: 'utf8', timeout: 60000 });
      assert.equal(child.status, 0, `Submit child ${suffix} failed: ${child.stderr}`);
      const recovered = await connect(1, `outbox-${suffix}`);
      try {
        let results = await recovered.transport.recoverPending();
        for (let retry = 0; results.some(result => result.status === 'pending') && retry < 10; retry++) {
          await new Promise(resolve => setTimeout(resolve, 500));
          results = await recovered.transport.recoverPending();
        }
        assert.equal(results.length, 1);
        assert.equal(results[0].status, 'valid');
        assert.equal((await recovered.outbox.listRecoverable()).length, 0);
        evidence[suffix] = { status: results[0].status, tx_id: results[0].tx_id };
        console.log(`VALID: ${suffix} recovered using a new process/client`);
      } finally { recovered.close(); }
    }

    const duplicate = command(1, 'smoke-duplicate', 'fence', { nonce: 'smoke-duplicate-fence-001' });
    const proposals = await Promise.all([connections[1].client.newProposal(duplicate), connections[1].client.newProposal(duplicate)]);
    const endorsed = await Promise.all(proposals.map(proposal => proposal.endorse()));
    for (let i = 0; i < 2; i++) {
      await connections[1].outbox.recordAttempt({ command_id: duplicate.command_id, actor_org_id: duplicate.actor_org_id, payload_digest: idempotencyDigest(duplicate), tx_id: proposals[i].tx_id, status: 'pending' });
    }
    await Promise.all(endorsed.map(item => item.submit()));
    const statuses = await Promise.all(proposals.map(proposal => connections[1].client.getStatus(proposal.tx_id)));
    assert.deepEqual(statuses.map(status => status.status).sort(), ['INVALID', 'VALID']);
    const loser = statuses.findIndex(status => status.status === 'INVALID');
    const winner = 1 - loser;
    await connections[1].outbox.updateAttempt(proposals[winner].tx_id, { status: 'valid' });
    const reconciled = await connections[1].transport.recover({ ...duplicate, payload_digest: idempotencyDigest(duplicate), tx_id: proposals[loser].tx_id, commit_bytes: await endorsed[loser].getCommitBytes!() });
    assert.equal(reconciled.status, 'valid');
    assert.equal((reconciled.result as any).tx_id, proposals[winner].tx_id);
    evidence.duplicate = { valid_tx: proposals[winner].tx_id, invalid_tx: proposals[loser].tx_id, invalid_code: statuses[loser].code, reconciled: true };
    console.log('VALID: actual MVCC INVALID duplicate reconciled to original command');

    // Project peer blocks before and after the withdrawal. The projector is a
    // verified in-memory reader; this is not an HTTP deployment mode.
    const { FabricBlockProjector } = await import('../../packages/fabric/block-projector.ts');
    const projector = new FabricBlockProjector({ channel_id: 'kcl-demo', chaincode_name: 'kcl', public_genesis: fixtures.config });
    const seen = new Map<string, { block_number: string; transaction_index: number; code: number }>();
    let nextBlock = 0n;
    async function projectThrough(target: bigint) {
      const stream = await connections[1].gateway.getNetwork('kcl-demo').getBlockEvents({ startBlock: nextBlock });
      const { common } = require('@hyperledger/fabric-protos');
      try {
        for await (const block of stream) {
          projector.applyBlock(block.serializeBinary());
          const number = BigInt(block.getHeader().getNumber());
          const filter = block.getMetadata().getMetadataList_asU8()[2];
          for (const [index, bytes] of block.getData().getDataList_asU8().entries()) {
            const envelope = common.Envelope.deserializeBinary(bytes);
            const payload = common.Payload.deserializeBinary(envelope.getPayload_asU8());
            const header = common.ChannelHeader.deserializeBinary(payload.getHeader().getChannelHeader_asU8());
            if (header.getTxId()) seen.set(header.getTxId(), { block_number: number.toString(), transaction_index: index, code: filter[index] });
          }
          nextBlock = number + 1n;
          if (number >= target) break;
        }
      } finally { stream.close(); }
    }
    const duplicateBlock = BigInt(statuses[winner].block_number!);
    await projectThrough(duplicateBlock);
    const slot = slotFields(fixtures.revisions[3].payload);
    const before = await resolveAt(async key => projector.read(key), slot);
    assert.equal(before.eligible, true);
    assert.equal(before.revision!.payload.body_markdown, fixtures.revisions[3].payload.body_markdown);
    for (const transaction of transactions) assert.equal(seen.get(transaction.tx_id)?.code, 0);
    assert.equal(seen.get(proposals[loser].tx_id)?.code, 11);
    const fenceCommand = command(1, 'smoke-final-fence', 'fence', { nonce: 'smoke-final-fence-001' });
    const withdrawCommand = command(2, 'smoke-withdraw', 'withdraw', { agreement_id: 'smoke-agreement-2', reason: 'Fictional dependency withdrawal' });
    const fence = await connections[1].client.newProposal(fenceCommand);
    const withdrawal = await connections[2].client.newProposal(withdrawCommand);
    const [fenceEndorsed, withdrawalEndorsed] = await Promise.all([fence.endorse(), withdrawal.endorse()]);
    await fenceEndorsed.submit();
    await withdrawalEndorsed.submit();
    const fenceStatus = await connections[1].client.getStatus(fence.tx_id);
    const withdrawStatus = await connections[2].client.getStatus(withdrawal.tx_id);
    assert.equal(fenceStatus.status, 'VALID'); assert.equal(withdrawStatus.status, 'VALID');
    assert.equal(fenceStatus.block_number, withdrawStatus.block_number, 'Expected the ordered fence and withdrawal in the same block');
    await projectThrough(BigInt(withdrawStatus.block_number!));
    const after = await resolveAt(async key => projector.read(key), slot);
    assert.equal(after.eligible, false);
    const finalEpoch = projector.read(keyFor.eligibilityEpoch());
    const fenceValue = projector.read(keyFor.fence('smoke-final-fence-001')) as any;
    assert.notEqual(fenceValue.eligibility_epoch, finalEpoch);
    evidence.resolver = { before_dependency_withdrawal: 'provided', after_dependency_withdrawal: 'withheld', reason: after.reason, body_in_valid_peer_block: true };
    evidence.same_block_fence_withdrawal = { fence: seen.get(fence.tx_id), withdrawal: seen.get(withdrawal.tx_id), stale_fence_rejected: true };
    evidence.transactions = transactions.map(item => ({ ...item, ...seen.get(item.tx_id) }));
    evidence.verified_at = new Date().toISOString();
    writeFileSync(join(state, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    console.log('VALID: peer full-block projection, shared source body, same-block fence and dependency withdrawal');
    console.log(`Evidence saved to ${join(state, 'evidence.json')}`);
  } finally { for (const connection of connections) connection.close(); }
}

if (process.argv[2] === '--submit-only' || process.argv[2] === '--lose-response') await submitForRestart(process.argv[2] === '--lose-response');
else await run();
