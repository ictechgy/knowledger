import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, keyFor, digestPayload } from '../../packages/domain/index.ts';
import type { Actor, DomainCommand, TxContext } from '../../packages/domain/index.ts';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { KclService } from '../../apps/api/service.ts';
import { demoFixtures, actorIdentity, PERSONAS, slotFields } from '../../apps/api/demo-config.ts';

/** A deterministic MVCC model, not a Fabric network or consensus-fault test. */
class VersionedState {
  values = new Map<string, { value: unknown; version: number }>();
  clock = 0;
  constructor(entries: [string, unknown][]) { for (const [key, value] of entries) this.values.set(key, { value, version: 0 }); }
  async simulate(actor: Actor, command: DomainCommand) {
    const snapshot = structuredClone(this.values);
    const reads = new Map<string, number>();
    const writes = new Map<string, unknown>();
    const ctx: TxContext = {
      actor, channel_id: 'kcl-demo', tx_id: `simulated-tx-${++this.clock}`, timestamp: '2026-09-15T12:00:00Z',
      get: async key => {
        reads.set(key, snapshot.get(key)?.version ?? -1);
        return structuredClone(writes.has(key) ? writes.get(key) : snapshot.get(key)?.value);
      },
      put: async (key, value) => { writes.set(key, structuredClone(value)); },
    };
    const result = await execute(ctx, command);
    return { reads, writes, result };
  }
  commit(transaction: Awaited<ReturnType<VersionedState['simulate']>>) {
    for (const [key, version] of transaction.reads) if ((this.values.get(key)?.version ?? -1) !== version) return false;
    for (const [key, value] of transaction.writes) this.values.set(key, { value: structuredClone(value), version: ++this.clock });
    return true;
  }
  read(key: string): any { return this.values.get(key)?.value; }
  async apply(actor: Actor, command: DomainCommand) { assert.equal(this.commit(await this.simulate(actor, command)), true); }
}

const actors = [actorIdentity(PERSONAS[1]), actorIdentity(PERSONAS[2])];
const fixtures = demoFixtures();
const revision = fixtures.revisions[3];
const policy = fixtures.policies[3];
const proposal = 'proposal-review-invitation-001';
let sequence = 0;
const command = (type: string, input: any): DomainCommand => ({ command_id: `cmd-mvcc-${++sequence}`, type, input });
function decision(actor: Actor, kind: 'approve' | 'object', proposalId = proposal, target = revision) {
  const representative = policy.role_representatives.find(item => item.actor_id === actor.actor_id)!;
  return command('decide', { decision: {
    contract_type: 'ApprovalDecision', contract_version: 1, decision_id: `decision-mvcc-${++sequence}`,
    revision_digest: target.revision_digest, ...slotFields(target.payload), policy_id: policy.policy_id,
    policy_version: 1, membership_epoch: 1, role_binding_version: 1, actor_org_id: actor.org_id,
    actor_id: actor.actor_id, subject_id: target.payload.document_id, actor_domain_role: representative.domain_role,
    decision: kind, rationale: 'MVCC behavior fixture', decided_at: '2026-09-15T12:00:00Z', proposal_id: proposalId,
  } });
}
async function ready() {
  const ledger = new LocalLedger(':memory:', 'kcl-demo');
  const vault = new PrivateStore(':memory:');
  const service = new KclService(ledger, vault);
  await service.initialize();
  const state = new VersionedState(ledger.entries('kcl:'));
  ledger.close(); vault.close();
  for (const actor of actors) await state.apply(actor, decision(actor, 'approve'));
  return state;
}

test('an objection committed before activation invalidates the stale activation read set', async () => {
  const state = await ready();
  const activation = await state.simulate(actors[0], command('activate', { proposal_id: proposal, agreement_id: 'agreement-race-one', expected_active_agreement_id: null }));
  const objection = await state.simulate(actors[1], decision(actors[1], 'object'));
  assert.equal(state.commit(objection), true);
  assert.equal(state.commit(activation), false);
  assert.equal(state.read(keyFor.activeSlot(revision.payload)), undefined);
});

test('activation winning an objection race forces retry, then the objection suspends atomically', async () => {
  const state = await ready();
  const activation = await state.simulate(actors[0], command('activate', { proposal_id: proposal, agreement_id: 'agreement-race-two', expected_active_agreement_id: null }));
  const objectionCommand = decision(actors[1], 'object');
  const objection = await state.simulate(actors[1], objectionCommand);
  assert.equal(state.commit(activation), true);
  assert.equal(state.commit(objection), false);
  const beforeEpoch = state.read(keyFor.eligibilityEpoch());
  await state.apply(actors[1], objectionCommand);
  assert.equal(state.read(keyFor.agreement('agreement-race-two')).status, 'suspended');
  assert.equal(state.read(keyFor.eligibilityEpoch()), beforeEpoch + 1);
  assert.equal(state.read(keyFor.activeSlot(revision.payload)).agreement_id, null);
});

test('two approved revisions racing for one empty slot yield exactly one valid activation', async () => {
  const state = await ready();
  const payload = { ...structuredClone(revision.payload), revision_id: 'rev-mvcc-replacement', parents: [revision.revision_digest], body_markdown: '# Revised review rule\n\nWait for all deliveries.' };
  const replacement = { revision_digest: digestPayload(payload), payload };
  await state.apply(actors[0], command('publish_revision', { revision: replacement, publication: { revision_digest: replacement.revision_digest, config_version: 1, membership_epoch: 1 } }));
  const secondProposal = 'proposal-mvcc-replacement';
  await state.apply(actors[0], command('propose', { proposal_id: secondProposal, revision_digest: replacement.revision_digest, policy_id: policy.policy_id, policy_version: 1 }));
  for (const actor of actors) await state.apply(actor, decision(actor, 'approve', secondProposal, replacement));
  const first = await state.simulate(actors[0], command('activate', { proposal_id: proposal, agreement_id: 'agreement-cas-first', expected_active_agreement_id: null }));
  const second = await state.simulate(actors[1], command('activate', { proposal_id: secondProposal, agreement_id: 'agreement-cas-second', expected_active_agreement_id: null }));
  assert.equal(state.commit(first), true);
  assert.equal(state.commit(second), false);
  assert.equal(state.read(keyFor.activeSlot(revision.payload)).agreement_id, 'agreement-cas-first');
  assert.equal(state.read(keyFor.agreement('agreement-cas-second')), undefined);
});
