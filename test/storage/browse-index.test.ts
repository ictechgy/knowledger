import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  digestPayload,
  keyFor,
  type AgreementProposalRecord,
  type AgreementRecord,
  type DocumentRevision,
  type Slot,
} from '../../packages/domain/index.ts';
import { VerifiedBrowseIndex } from '../../packages/storage/browse-index.ts';
import { LocalLedger, type Checkpoint } from '../../packages/storage/local-ledger.ts';
import { BOOTSTRAP_ACTOR, PERSONAS, actorIdentity, demoFixtures } from '../../examples/order-workflow/config.ts';

const CHANNEL = 'channel-browse';
const actor = { org_id: 'OrgBrowse', actor_id: 'person-browse', kind: 'human' as const };

function checkpoint(block: number, transaction = 0): Checkpoint {
  return {
    channel_id: CHANNEL,
    block_number: block,
    transaction_index: transaction,
    transaction_id: `tx-${block}-${transaction}`,
    block_hash: `${block}-${transaction}`.padEnd(64, '0'),
  };
}

function slot(documentId: string, contextId = 'context-browse', scopeId = 'scope-browse'): Slot {
  return { channel_id: CHANNEL, document_id: documentId, context_id: contextId, scope_id: scopeId, usage_scope: 'domain-definition/v1' };
}

function revision(id: string, value: Slot): DocumentRevision {
  const payload = {
    contract_type: 'DocumentRevision' as const,
    contract_version: 1 as const,
    revision_id: id,
    ...value,
    visibility: 'shared_channel' as const,
    title: id,
    body_markdown: `# ${id}`,
    parents: [],
    dependencies: [],
    metadata: {
      author_id: actor.actor_id,
      created_at: '2026-09-16T00:00:00.000Z',
      source_kind: 'human_authored' as const,
      shared_assertions: [],
      author_org_id: actor.org_id,
    },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function proposal(id: string, value: DocumentRevision, createdAt: string): AgreementProposalRecord {
  return {
    record_type: 'AgreementProposal', proposal_id: id, revision_digest: value.revision_digest,
    policy_id: 'policy-browse', policy_version: 1, membership_epoch: 1, role_binding_version: 1,
    config_version: 'config-browse', status: 'open', created_by: actor, created_at: createdAt, review_counter: 0,
    ...slot(value.payload.document_id, value.payload.context_id, value.payload.scope_id),
  };
}

function agreement(id: string, proposalId: string, value: DocumentRevision, activatedAt: string): AgreementRecord {
  return {
    agreement_id: id, proposal_id: proposalId, revision_digest: value.revision_digest,
    policy_id: 'policy-browse', policy_version: 1, membership_epoch: 1, role_binding_version: 1,
    approval_decision_ids: ['decision-browse'], status: 'active', activated_by: actor, activated_at: activatedAt,
    ...slot(value.payload.document_id, value.payload.context_id, value.payload.scope_id),
  };
}

function commit(index: VerifiedBrowseIndex, at: Checkpoint, writes: readonly (readonly [string, unknown])[]): void {
  index.prepare([{ checkpoint: at, writes }]).commit();
}

test('browse refs preserve ordering, full slots, pages, and exact historical visibility', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-first', slot('document-one'));
  const second = revision('revision-second', slot('document-one'));
  const otherScope = revision('revision-other-scope', slot('document-one', 'context-browse', 'scope-other'));
  const otherDocument = revision('revision-other-doc', slot('document-two'));

  commit(index, checkpoint(1, 0), [[keyFor.revision(first.revision_digest), first]]);
  commit(index, checkpoint(1, 1), [[keyFor.revision(otherDocument.revision_digest), otherDocument]]);
  commit(index, checkpoint(2), [[keyFor.revision(second.revision_digest), second]]);
  commit(index, checkpoint(3), [[keyFor.revision(otherScope.revision_digest), otherScope]]);

  const all = index.query({ kind: 'revisions', mode: 'all', at: checkpoint(3), offset: 0, limit: 10 });
  assert.deepEqual(all.items.map(item => item.revision_digest), [otherScope.revision_digest, second.revision_digest, otherDocument.revision_digest, first.revision_digest]);
  assert.equal(all.total, 4);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1, 0), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'latest-per-slot', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest, second.revision_digest, otherDocument.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'slot', slot: slot('document-one'), at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'document', document_id: 'document-one', scope_id: 'scope-other', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', scope_id: 'scope-other', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [otherScope.revision_digest]);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', context_id: 'context-missing', at: checkpoint(3), offset: 0, limit: 10 }).items, []);
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'latest-per-slot', document_id: 'document-one', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest]);

  const proposalA = proposal('proposal-a', second, '2026-09-16T02:00:00.000Z');
  const proposalB = proposal('proposal-b', second, '2026-09-16T02:00:00.000Z');
  const proposalOld = proposal('proposal-old', first, '2026-09-16T01:00:00.000Z');
  commit(index, checkpoint(4), [[keyFor.proposal(proposalB.proposal_id), proposalB], [keyFor.proposal(proposalA.proposal_id), proposalA], [keyFor.proposal(proposalOld.proposal_id), proposalOld]]);
  assert.deepEqual(index.query({ kind: 'proposals', at: checkpoint(4), offset: 0, limit: 2 }).items.map(item => item.proposal_id), ['proposal-a', 'proposal-b']);
  assert.deepEqual(index.query({ kind: 'proposals', revision_digest: first.revision_digest, at: checkpoint(4), offset: 0, limit: 10 }).items.map(item => item.proposal_id), ['proposal-old']);

  const agreementA = agreement('agreement-a', proposalA.proposal_id, second, '2026-09-16T03:00:00.000Z');
  const agreementB = agreement('agreement-b', proposalB.proposal_id, second, '2026-09-16T03:00:00.000Z');
  commit(index, checkpoint(5), [[keyFor.agreement(agreementA.agreement_id), agreementA]]);
  commit(index, checkpoint(6), [[keyFor.agreement(agreementB.agreement_id), agreementB]]);
  assert.deepEqual(index.query({ kind: 'revision-annotations', at: checkpoint(4), revision_digests: [second.revision_digest] }), [{ revision_digest: second.revision_digest, revision: all.items[1], has_proposal: true }]);
  const annotation = index.query({ kind: 'revision-annotations', at: checkpoint(6), revision_digests: [second.revision_digest] })[0];
  assert.equal(annotation.agreement?.agreement_id, 'agreement-b');

  const agreementUpper = agreement('agreement-Zed', proposalA.proposal_id, first, '2026-09-16T04:00:00.000Z');
  const agreementLower = agreement('agreement-aardvark', proposalA.proposal_id, first, '2026-09-16T04:00:00.000Z');
  commit(index, checkpoint(7, 0), [[keyFor.agreement(agreementUpper.agreement_id), agreementUpper]]);
  commit(index, checkpoint(7, 1), [[keyFor.agreement(agreementLower.agreement_id), agreementLower]]);
  assert.equal(index.query({ kind: 'revision-annotations', at: checkpoint(7, 1), revision_digests: [first.revision_digest] })[0].agreement?.agreement_id, 'agreement-aardvark');
  const blockOnly = { ...checkpoint(8), transaction_index: -1, transaction_id: '' };
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: blockOnly, offset: 0, limit: 10 }).total, 4);
  assert.doesNotThrow(() => index.prepare([{ checkpoint: blockOnly, writes: [] }]));
  assert.throws(() => index.prepare([{ checkpoint: blockOnly, writes: [[keyFor.revision(first.revision_digest), first]] }]), /block-only|checkpoint/i);

  const cached = index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 1 });
  assert.equal(cached.total, 2); cached.items[0].slot.document_id = 'caller-mutation';
  const later = revision('revision-later', slot('document-one'));
  commit(index, checkpoint(9), [[keyFor.revision(later.revision_digest), later]]);
  assert.equal(index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 0, limit: 1 }).items[0].slot.document_id, 'document-one');
  const nextCachedPage = index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(3), offset: 1, limit: 1 });
  assert.equal(nextCachedPage.total, 2); assert.notEqual(nextCachedPage.items[0].slot.document_id, 'caller-mutation');
  assert.equal(index.query({ kind: 'revisions', mode: 'latest-per-slot', scope_id: 'scope-browse', at: checkpoint(9), offset: 0, limit: 10 }).items[0].revision_digest, later.revision_digest);
});

test('later mutable writes cannot change indexed identity, order, or full-slot fields', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const value = revision('revision-mutable', slot('document-mutable'));
  const original = proposal('proposal-mutable', value, '2026-09-16T00:00:00.000Z');
  commit(index, checkpoint(1), [[keyFor.revision(value.revision_digest), value], [keyFor.proposal(original.proposal_id), original], [keyFor.proposal(original.proposal_id), original]]);

  const mutable = { ...original, status: 'activated' as const, review_counter: 3, agreement_id: 'agreement-mutable' };
  commit(index, checkpoint(2), [[keyFor.proposal(original.proposal_id), mutable]]);
  assert.equal(index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 }).total, 1);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(3), writes: [[keyFor.proposal(original.proposal_id), { ...mutable, created_at: '2027-01-01T00:00:00.000Z' }]] }]), /immutable|indexed/i);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(3), writes: [[keyFor.proposal(original.proposal_id), { ...mutable, scope_id: 'scope-forged' }]] }]), /immutable|indexed/i);

  const originalAgreement = agreement('agreement-mutable', original.proposal_id, value, '2026-09-16T01:00:00.000Z');
  commit(index, checkpoint(3), [[keyFor.agreement(originalAgreement.agreement_id), originalAgreement]]);
  commit(index, checkpoint(4), [[keyFor.agreement(originalAgreement.agreement_id), {
    ...originalAgreement, status: 'withdrawn', status_reason: 'policy changed', status_changed_by: actor,
    status_changed_at: '2026-09-16T02:00:00.000Z',
  }]]);
  assert.throws(() => index.prepare([{ checkpoint: checkpoint(5), writes: [[keyFor.agreement(originalAgreement.agreement_id), {
    ...originalAgreement, activated_at: '2027-01-01T00:00:00.000Z',
  }]] }]), /immutable|indexed/i);

  const firstRead = index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 });
  firstRead.items[0].slot.document_id = 'document-forged';
  firstRead.items[0].published_checkpoint.block_number = 999;
  const secondRead = index.query({ kind: 'proposals', at: checkpoint(2), offset: 0, limit: 10 });
  assert.equal(secondRead.items[0].slot.document_id, 'document-mutable');
  assert.equal(secondRead.items[0].published_checkpoint.block_number, 1);
  assert.throws(() => index.query({ kind: 'proposals', at: checkpoint(4), offset: -1, limit: 10 }), /offset|range/i);
  assert.throws(() => index.query({ kind: 'revision-annotations', at: checkpoint(4), revision_digests: Array(1001).fill(value.revision_digest) }), /1000|batch/i);
});

test('streamed index preparation is atomic and sorts a whole replay once', () => {
  const index = new VerifiedBrowseIndex(CHANNEL);
  const first = revision('revision-stream-first', slot('document-stream'));
  const second = revision('revision-stream-second', slot('document-stream'));
  function* failingReplay() {
    yield { checkpoint: checkpoint(1), writes: [[keyFor.revision(first.revision_digest), first]] as const };
    throw new Error('synthetic replay failure');
  }
  assert.throws(() => index.prepare(failingReplay()), /replay failure/);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(0), offset: 0, limit: 10 }).total, 0);
  function* replay() {
    yield { checkpoint: checkpoint(1), writes: [[keyFor.revision(first.revision_digest), first]] as const };
    yield { checkpoint: checkpoint(2), writes: [[keyFor.revision(second.revision_digest), second]] as const };
  }
  index.prepare(replay()).commit();
  assert.deepEqual(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(2), offset: 0, limit: 10 }).items.map(item => item.revision_digest), [second.revision_digest, first.revision_digest]);
  assert.equal(index.query({ kind: 'revisions', mode: 'all', at: checkpoint(1), offset: 0, limit: 10 }).total, 1);
});

test('LocalLedger publishes browse changes only after SQL commit and rebuilds them from the journal', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-browse-index-'));
  const path = join(directory, 'ledger.sqlite');
  let ledger = new LocalLedger(path, CHANNEL);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = revision('revision-local-first', slot('document-local'));
  const firstCommit = await ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(first.revision_digest), first); });
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: firstCommit.checkpoint, offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);

  const external = new DatabaseSync(path);
  external.exec("CREATE TRIGGER fail_browse_projection BEFORE INSERT ON projection_history BEGIN SELECT RAISE(ABORT, 'browse rollback'); END");
  external.close();
  const second = revision('revision-local-second', slot('document-local'));
  await assert.rejects(ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(second.revision_digest), second); }), /browse rollback/);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: firstCommit.checkpoint, offset: 0, limit: 10 }).items.map(item => item.revision_digest), [first.revision_digest]);

  const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER fail_browse_projection'); repair.close();
  const secondCommit = await ledger.transact(actor, async ctx => { await ctx.put(keyFor.revision(second.revision_digest), second); });
  const expected = ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 });
  ledger.close();
  ledger = new LocalLedger(path, CHANNEL);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);

  const tamper = new DatabaseSync(path);
  tamper.prepare('DELETE FROM projection WHERE state_key = ?').run(keyFor.revision(first.revision_digest));
  tamper.prepare('UPDATE projection_history SET value_json = ? WHERE state_key = ?').run(JSON.stringify(second), keyFor.revision(first.revision_digest));
  tamper.close();
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);
  ledger.close();
  ledger = new LocalLedger(path, CHANNEL);
  assert.deepEqual(ledger.queryBrowse({ kind: 'revisions', mode: 'all', at: secondCommit.checkpoint, offset: 0, limit: 10 }), expected);
});

test('LocalLedger rejects changed indexed proposal fields before committing SQL or memory', async t => {
  const ledger = new LocalLedger(':memory:', 'kcl-demo'); t.after(() => ledger.close());
  const fixture = demoFixtures(); const author = actorIdentity(PERSONAS[0]); const value = fixture.revisions[0]; const policy = fixture.policies[0];
  await ledger.bootstrap(BOOTSTRAP_ACTOR, fixture.config);
  await ledger.execute(author, { command_id: 'command-browse-publish', type: 'publish_revision', input: {
    revision: value, publication: { revision_digest: value.revision_digest, config_version: 1, membership_epoch: 1 },
  } });
  await ledger.execute(author, { command_id: 'command-browse-propose', type: 'propose', input: {
    proposal_id: 'proposal-browse-guard', revision_digest: value.revision_digest, policy_id: policy.policy_id, policy_version: 1,
  } });
  const key = keyFor.proposal('proposal-browse-guard'); const before = ledger.read(key); const at = ledger.checkpoint()!;
  await assert.rejects(ledger.transact(author, async ctx => {
    await ctx.put(key, { ...before, created_at: '2027-01-01T00:00:00.000Z' });
  }), /immutable|indexed/i);
  assert.deepEqual(ledger.checkpoint(), at);
  assert.deepEqual(ledger.read(key), before);
  assert.deepEqual(ledger.queryBrowse({ kind: 'proposals', at, offset: 0, limit: 10 }).items.map(item => item.proposal_id), ['proposal-browse-guard']);
});
