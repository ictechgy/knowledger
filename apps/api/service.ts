import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as domain from '../../packages/domain/index.ts';
import { LocalLedger } from '../../packages/storage/local-ledger.ts';
import type { Actor, Checkpoint } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { demoFixtures, BOOTSTRAP_ACTOR, PERSONAS, slotFields, actorIdentity } from './demo-config.ts';

const P = 'kcl:v1:';
const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const newId = (prefix: string) => `${prefix}-${randomUUID()}`;
const stableId = (prefix: string, actor: Actor, commandId: string) => `${prefix}-${createHash('sha256').update(`${actor.org_id}:${actor.actor_id}:${commandId}`).digest('hex').slice(0,32)}`;
const sameSlot = (a: any, b: any) => ['channel_id', 'document_id', 'context_id', 'scope_id', 'usage_scope'].every(field => a[field] === b[field]);

export class ApiError extends Error {
  code: string; status: number; retryable: boolean;
  constructor(code: string, message: string, status = 400, retryable = false) {
    super(message); this.code = code; this.status = status; this.retryable = retryable;
  }
}
function onlyFields(input: any, allowed: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError('INVALID_INPUT', '허용되지 않은 요청 필드입니다.');
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new ApiError('INVALID_INPUT', '올바른 식별자가 필요합니다.');
  return value;
}

/** API orchestration for the explicitly labelled local simulation. */
export class KclService {
  readonly ledger: LocalLedger;
  private vault: PrivateStore;
  private bootId = randomUUID();
  private commandQueue: Promise<unknown> = Promise.resolve();

  constructor(ledger: LocalLedger, vault: PrivateStore) { this.ledger = ledger; this.vault = vault; }
  config(at?: Checkpoint) { return this.ledger.read(`${P}config`, at); }
  values(kind: string, at?: Checkpoint): any[] { return this.ledger.entries(`${P}${kind}:`, at).map(([, value]) => value); }
  actor(actor: Actor): void {
    const config = this.config();
    if (!config?.identities.some((item: any) => item.org_id === actor.org_id && item.actor_id === actor.actor_id && item.kind === actor.kind)) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없거나 접근할 수 없습니다.', 404);
    if (!config.serving_enabled) throw new ApiError('SERVING_FROZEN', '현재 공유 지식 제공이 중지되어 있습니다.', 503, true);
  }
  private revision(digest: string, at?: Checkpoint) {
    const value = this.values('revision', at).find(item => item.revision_digest === digest);
    if (!value) throw new ApiError('NOT_FOUND', '개정본을 찾을 수 없거나 접근할 수 없습니다.', 404);
    return value;
  }
  private proposal(id: string) {
    const value = this.values('proposal').find(item => item.proposal_id === id);
    if (!value) throw new ApiError('NOT_FOUND', '제안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    return value;
  }
  private policy(id: string, version?: number) {
    const value = this.config().policies.find((item: any) => item.policy_id === id && (version === undefined || item.policy_version === version));
    if (!value) throw new ApiError('POLICY_NOT_FOUND', '이 범위의 합의 정책이 없습니다.', 409);
    return value;
  }

  async initialize(seed = true): Promise<void> {
    const fixtures = demoFixtures();
    if (!this.config()) await this.ledger.transact(BOOTSTRAP_ACTOR, ctx => domain.bootstrap(ctx, fixtures.config));
    if (!seed) return;
    for (let index = 0; index < fixtures.revisions.length; index++) {
      const revision = fixtures.revisions[index];
      const actor = actorIdentity(PERSONAS[index === 3 ? 1 : index]);
      const policy = fixtures.policies[index];
      const suffix = index === 3 ? 'review-invitation' : ['sales', 'fulfillment', 'settlement'][index];
      const submit = (type: string, input: any) => this.ledger.transact(actor, ctx => domain.execute(ctx, { command_id: `seed-${type}-${suffix}`, type, input }));
      await submit('publish_revision', { revision, publication: { revision_digest: revision.revision_digest, config_version: 1, membership_epoch: 1 } });
      const proposalId = `proposal-${suffix}-001`;
      await submit('propose', { proposal_id: proposalId, revision_digest: revision.revision_digest, policy_id: policy.policy_id, policy_version: 1 });
      if (index === 3) continue;
      await submit('decide', { decision: this.makeDecision(actor, proposalId, policy, revision, { decision: 'approve', rationale: '가상 예제: 해당 도메인의 정의를 확인합니다.' }, `decision-${suffix}-001`, '2026-09-15T00:00:00Z') });
      await submit('activate', { proposal_id: proposalId, agreement_id: `agreement-${suffix}-001`, expected_active_agreement_id: null });
    }
  }

  private makeDecision(actor: Actor, proposalId: string, policy: any, revision: any, input: any, id: string, timestamp: string) {
    const representative = policy.role_representatives.find((item: any) => item.actor_org_id === actor.org_id && item.actor_id === actor.actor_id);
    if (!representative) throw new ApiError('NOT_REPRESENTATIVE', '이 범위에 지정된 도메인 책임자가 아닙니다.', 403);
    return {
      contract_type: 'ApprovalDecision', contract_version: 1, decision_id: id,
      revision_digest: revision.revision_digest, ...slotFields(revision.payload),
      policy_id: policy.policy_id, policy_version: policy.policy_version,
      membership_epoch: policy.membership_epoch, role_binding_version: policy.role_binding_version,
      actor_org_id: actor.org_id, actor_id: actor.actor_id, subject_id: revision.payload.document_id,
      actor_domain_role: representative.domain_role, decision: input.decision,
      rationale: input.rationale, decided_at: timestamp, proposal_id: proposalId,
      ...(input.decision === 'retract' ? { retracts_decision_id: input.retracts_decision_id } : {}),
    };
  }

  async overview(actor: Actor) {
    this.actor(actor);
    const checkpoint = this.ledger.checkpoint()!;
    const revisions = this.values('revision', checkpoint);
    const agreements = this.values('agreement', checkpoint);
    const documents = await Promise.all(revisions.map(async revision => {
      const eligibility = await domain.resolveAt(async key => this.ledger.read(key, checkpoint), slotFields(revision.payload));
      const agreement = eligibility.agreement?.revision_digest === revision.revision_digest ? eligibility.agreement : agreements.filter(item => item.revision_digest === revision.revision_digest).sort((a, b) => a.activated_at.localeCompare(b.activated_at) || a.agreement_id.localeCompare(b.agreement_id)).at(-1);
      return { ...revision, agreement, eligible: eligibility.eligible && eligibility.revision?.revision_digest === revision.revision_digest, reason: eligibility.reason,
        history: revisions.filter(item => sameSlot(item.payload, revision.payload)).map(item => ({ revision_digest: item.revision_digest, title: item.payload.title, created_at: item.payload.metadata.created_at })) };
    }));
    const decisions = this.values('decision', checkpoint);
    const config = this.config(checkpoint);
    const proposals = this.values('proposal', checkpoint).map(proposal => ({ ...proposal,
      decisions: decisions.filter(decision => decision.proposal_id === proposal.proposal_id),
      required_representatives: config.policies.find((policy: any) => policy.policy_id === proposal.policy_id && policy.policy_version === proposal.policy_version).role_representatives,
    }));
    this.actor(actor);
    return { mode: 'local-simulation', channel: { channel_id: config.channel_id, org_ids: [...new Set(config.identities.map((item: any) => item.org_id))], config_version: config.config_version, membership_epoch: config.membership_epoch }, actor, documents, proposals, policies: config.policies, checkpoint };
  }

  async draft(actor: Actor, input: any) {
    this.actor(actor);
    onlyFields(input, ['base_revision_digest', 'title', 'body_markdown', 'source_kind', 'context_id', 'scope_id', 'usage_scope', 'document_id']);
    const base = input.base_revision_digest ? this.revision(input.base_revision_digest) : undefined;
    const payload = base ? structuredClone(base.payload) : {
      contract_type: 'DocumentRevision', contract_version: 1, channel_id: this.ledger.channelId,
      document_id: input.document_id ?? newId('doc'), context_id: input.context_id,
      scope_id: input.scope_id, usage_scope: input.usage_scope, visibility: 'shared_channel', dependencies: [],
    };
    Object.assign(payload, { revision_id: newId('rev'), title: input.title, body_markdown: input.body_markdown,
      parents: base ? [base.revision_digest] : [], metadata: { author_id: actor.actor_id, author_org_id: actor.org_id,
        created_at: new Date().toISOString(), source_kind: input.source_kind ?? (actor.kind === 'agent' ? 'llm_drafted' : 'human_authored'), shared_assertions: [] } });
    const revision = { revision_digest: domain.digestPayload(payload), payload };
    domain.validateRevision(revision);
    const draftId = newId('draft');
    this.vault.put('draft', draftId, actor, { revision });
    return { draft_id: draftId, revision };
  }

  async preview(actor: Actor, input: any) {
    this.actor(actor); onlyFields(input, ['draft_id']);
    const draft = this.vault.get('draft', identifier(input.draft_id), actor);
    if (!draft) throw new ApiError('NOT_FOUND', '초안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    const config = this.config();
    const registered = config.identities.find((item: any) => item.org_id === actor.org_id && item.actor_id === actor.actor_id);
    if (!registered.publish_contexts.includes(draft.revision.payload.context_id)) throw new ApiError('PUBLISH_FORBIDDEN', '이 맥락의 공유 권한이 없습니다.', 403);
    const preview = { preview_id: newId('preview'), revision_digest: draft.revision.revision_digest,
      recipients: [...new Set(config.identities.map((item: any) => item.org_id))],
      config_version: config.config_version, membership_epoch: config.membership_epoch,
      body_bytes: Buffer.byteLength(draft.revision.payload.body_markdown), expires_at: new Date(Date.now() + 300_000).toISOString(), revision: draft.revision };
    this.vault.put('preview', preview.preview_id, actor, preview);
    return preview;
  }

  /** Persist the exact generated command before execution so HTTP retries bind identical timestamps/IDs. */
  private command(actor: Actor, route: string, input: any, build: () => any): Promise<any> {
    this.actor(actor); identifier(input.command_id);
    const run = this.commandQueue.then(async () => {
      const digest = createHash('sha256').update(domain.canonicalize({ route, input })).digest('hex');
      let stored = this.vault.get('command', input.command_id, actor);
      if (stored && stored.request_digest !== digest) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 command_id로 다른 요청을 보낼 수 없습니다.', 409);
      if (!stored) {
        stored = { request_digest: digest, command: { command_id: input.command_id, ...build() } };
        this.vault.put('command', input.command_id, actor, stored);
      }
      const receipt = await this.ledger.transact(actor, ctx => domain.execute(ctx, stored.command));
      const committed = this.ledger.read(domain.keyFor.idempotency(actor.org_id, input.command_id));
      const checkpoint = this.ledger.checkpointForTransaction(committed.tx_id);
      return { command_id: input.command_id, ...receipt, checkpoint };
    });
    this.commandQueue = run.catch(() => undefined);
    return run;
  }

  async publish(actor: Actor, input: any) {
    onlyFields(input, ['preview_id', 'confirm_shared', 'command_id']);
    return this.command(actor, 'publish', input, () => {
      if (input.confirm_shared !== true) throw new ApiError('PUBLICATION_CONFIRMATION_REQUIRED', '본문이 참여 조직 전체에 복제됨을 확인해 주세요.');
      const preview = this.vault.get('preview', identifier(input.preview_id), actor);
      if (!preview) throw new ApiError('NOT_FOUND', '공개 검토를 찾을 수 없거나 접근할 수 없습니다.', 404);
      const config = this.config();
      if (Date.parse(preview.expires_at) < Date.now() || preview.config_version !== config.config_version || preview.membership_epoch !== config.membership_epoch) throw new ApiError('STALE_PREVIEW', '공개 검토가 만료되었습니다. 다시 확인해 주세요.', 409);
      return { type: 'publish_revision', input: { revision: preview.revision, publication: { revision_digest: preview.revision_digest, config_version: preview.config_version, membership_epoch: preview.membership_epoch } } };
    });
  }

  async propose(actor: Actor, input: any) {
    onlyFields(input, ['revision_digest', 'policy_id', 'policy_version', 'command_id']);
    return this.command(actor, 'propose', input, () => ({ type: 'propose', input: { proposal_id: stableId('proposal', actor, input.command_id), revision_digest: input.revision_digest, policy_id: input.policy_id, policy_version: input.policy_version } }));
  }
  async decide(actor: Actor, proposalId: string, input: any) {
    onlyFields(input, ['decision', 'rationale', 'retracts_decision_id', 'command_id']);
    return this.command(actor, `decide:${proposalId}`, input, () => {
      const proposal = this.proposal(proposalId);
      return { type: 'decide', input: { decision: this.makeDecision(actor, proposalId, this.policy(proposal.policy_id, proposal.policy_version), this.revision(proposal.revision_digest), input, stableId('decision', actor, input.command_id), new Date().toISOString()) } };
    });
  }
  async activate(actor: Actor, proposalId: string, input: any) {
    onlyFields(input, ['expected_active_agreement_id', 'command_id']);
    return this.command(actor, `activate:${proposalId}`, input, () => ({ type: 'activate', input: { proposal_id: proposalId, agreement_id: stableId('agreement', actor, input.command_id), expected_active_agreement_id: input.expected_active_agreement_id } }));
  }
  async changeAgreement(actor: Actor, agreementId: string, type: 'withdraw' | 'suspend', input: any) {
    onlyFields(input, ['reason', 'command_id']);
    return this.command(actor, `${type}:${agreementId}`, input, () => ({ type, input: { agreement_id: agreementId, reason: input.reason } }));
  }

  async search(actor: Actor, input: any) {
    onlyFields(input, ['query', 'context_id', 'scope_id', 'usage_scope']);
    if (typeof input.query !== 'string' || input.query.length > 1000) throw new ApiError('INVALID_INPUT', '검색어는 1,000자 이하여야 합니다.');
    const overview = await this.overview(actor);
    const query = input.query.toLocaleLowerCase();
    return { results: overview.documents.filter(doc => ['context_id', 'scope_id', 'usage_scope'].every(field => !input[field] || doc.payload[field] === input[field]) && `${doc.payload.title}\n${doc.payload.body_markdown}`.toLocaleLowerCase().includes(query)), checkpoint: overview.checkpoint };
  }

  async resolve(actor: Actor, input: any) {
    this.actor(actor); onlyFields(input, ['document_ids', 'context_id', 'scope_id', 'usage_scope', 'query']);
    if (!Array.isArray(input.document_ids) || input.document_ids.length !== 1) throw new ApiError('INVALID_INPUT', 'v0.1에서는 정확한 문서 한 개의 사용 범위를 지정해 주세요.');
    const slot = { channel_id: this.ledger.channelId, document_id: identifier(input.document_ids[0]), context_id: identifier(input.context_id), scope_id: identifier(input.scope_id), usage_scope: input.usage_scope };
    if (typeof input.usage_scope !== 'string' || !/^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/.test(input.usage_scope)) throw new ApiError('INVALID_INPUT', '버전이 있는 사용 범위가 필요합니다.');
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 1000)) throw new ApiError('INVALID_INPUT', '검색어가 너무 깁니다.');
    const started = performance.now();
    const fence = await this.ledger.transact(actor, ctx => domain.execute(ctx, { command_id: newId('command'), type: 'fence', input: { nonce: newId('fence') } }));
    const at = fence.checkpoint;
    const resolved = await domain.resolveAt(async key => this.ledger.read(key, at), slot);
    this.actor(actor);
    if (performance.now() - started > 30_000) throw new ApiError('FRESHNESS_UNAVAILABLE', '신선한 원장 체크포인트를 확보하지 못했습니다.', 503, true);
    if (!resolved.eligible || !resolved.revision || !resolved.agreement) return { status: 'withheld', reason: resolved.reason ?? 'NO_ACTIVE_AGREEMENT', documents: [], checkpoint: at };
    const { revision, agreement } = resolved;
    domain.validateRevision(revision);
    const runId = newId('run');
    const approvalDecisions = await domain.validateAgreementApprovals(async key => this.ledger.read(key, at), agreement);
    const manifest = {
      contract_type: 'RunContextManifest', contract_version: 1, manifest_id: newId('manifest'), run_id: runId,
      context_id: slot.context_id, scope_id: slot.scope_id, usage_scope: slot.usage_scope,
      policy_id: agreement.policy_id, policy_version: agreement.policy_version, membership_epoch: this.config(at).membership_epoch,
      checkpoint: { mode: 'strict', checkpoint_id: newId('checkpoint'), ...at, eligibility_epoch: this.ledger.read(`${P}eligibility_epoch`, at) },
      provided_revisions: [{ revision_digest: revision.revision_digest, purpose: 'scoped_knowledge', reference_kind: 'normative', target_context_id: slot.context_id, target_scope_id: slot.scope_id, usage_scope: slot.usage_scope, agreement_id: agreement.agreement_id }],
      approval_decisions: approvalDecisions.map(item => ({ decision_id: item.decision_id, revision_digest: item.revision_digest, proposal_id: item.proposal_id })),
      private_sources: [], retrieval_profile_id: 'retrieval-scoped-markdown-v1', authorization_snapshot_id: newId('authz'), model_egress_policy_version: 1,
    };
    this.vault.put('run', runId, actor, { manifest, slot, boot_id: this.bootId, issued_monotonic: performance.now() });
    return { status: 'provided', mode: 'local-simulation', documents: [{ revision_digest: revision.revision_digest, title: revision.payload.title, body_markdown: revision.payload.body_markdown, agreement_id: agreement.agreement_id }], manifest, checkpoint: at };
  }

  async revalidate(actor: Actor, runId: string, input: any) {
    this.actor(actor); onlyFields(input, ['action']);
    if (input.action !== 'use-context') throw new ApiError('UNSUPPORTED_ACTION', 'v0.1에서는 지식 사용 여부만 재검증할 수 있습니다.');
    const run = this.vault.get('run', identifier(runId), actor);
    if (!run) throw new ApiError('NOT_FOUND', '실행 기록을 찾을 수 없거나 접근할 수 없습니다.', 404);
    if (run.boot_id !== this.bootId) return { status: 'withheld', reason: 'SESSION_RESTARTED_RESOLVE_AGAIN' };
    const result = await this.resolve(actor, { document_ids: [run.slot.document_id], context_id: run.slot.context_id, scope_id: run.slot.scope_id, usage_scope: run.slot.usage_scope });
    if (result.status !== 'provided') return { status: 'withheld', reason: result.reason, checkpoint: result.checkpoint };
    const old = run.manifest.provided_revisions[0];
    const fresh = result.manifest!.provided_revisions[0];
    if (old.revision_digest !== fresh.revision_digest || old.agreement_id !== fresh.agreement_id) return { status: 'withheld', reason: 'KNOWLEDGE_CHANGED', checkpoint: result.checkpoint };
    return { status: 'valid', checkpoint: result.checkpoint, refreshed_manifest: result.manifest };
  }
}

export { onlyFields };
