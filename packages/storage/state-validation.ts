import {
  canonicalize, keyFor, slotKey, validateAgreement, validateConfig,
  validateDecision, validatePolicy, validateProposal, validateRevision,
} from '../domain/index.ts';

const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const fail = (): never => { throw new Error('Invalid or unsupported ledger write-set; projection halted'); };
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function record(value: any, names: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) fail();
}
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const isDigest = (value: unknown) => typeof value === 'string' && DIGEST.test(value);

/** A known key prefix is insufficient: validate its current schema and key/value binding. */
export function validateStateWrite(key: string, value: any): void {
  try {
    if (Buffer.byteLength(canonicalize(value)) > 2 * 1024 * 1024) fail();
    const parts = key.split(':');
    if (parts[0] !== 'kcl' || parts[1] !== 'v1' || key.includes('\0')) fail();
    const tail = parts.slice(3).map(decodeURIComponent);
    if (tail.some((part, index) => encodeURIComponent(part) !== parts[index + 3])) fail();
    const exact = (expected: string) => { if (key !== expected) fail(); };
    switch (parts[2]) {
      case 'config': validateConfig(value); exact(keyFor.config()); return;
      case 'revision': validateRevision(value); exact(keyFor.revision(value.revision_digest)); return;
      case 'revision_id':
        record(value, ['revision_digest']);
        if (tail.length !== 1 || !isId(tail[0]) || !isDigest(value.revision_digest)) fail();
        exact(keyFor.revisionId(tail[0])); return;
      case 'policy': validatePolicy(value); exact(keyFor.policy(value.policy_id, value.policy_version)); return;
      case 'proposal': validateProposal(value); exact(keyFor.proposal(value.proposal_id)); return;
      case 'decision': validateDecision(value); exact(keyFor.decision(value.decision_id)); return;
      case 'latest_decision':
        record(value, ['decision_id']);
        if (!isId(value.decision_id) || tail.length !== 5 || ![tail[0], tail[2], tail[3], tail[4]].every(isId) || !/^[1-9][0-9]*$/.test(tail[1]) || !Number.isSafeInteger(Number(tail[1]))) fail();
        exact(keyFor.latestDecision(tail[0], Number(tail[1]), tail[2], tail[3], tail[4])); return;
      case 'review_counter':
        if (!integer(value) || tail.length !== 1 || !isId(tail[0])) fail();
        exact(keyFor.reviewCounter(tail[0])); return;
      case 'agreement': validateAgreement(value); exact(keyFor.agreement(value.agreement_id)); return;
      case 'active_slot': {
        record(value, ['agreement_id']);
        if (value.agreement_id !== null && !isId(value.agreement_id)) fail();
        if (tail.length !== 1) fail();
        const fields = tail[0].split('|');
        if (fields.length !== 5) fail();
        const slot = { channel_id: fields[0], document_id: fields[1], context_id: fields[2], scope_id: fields[3], usage_scope: fields[4] };
        if (slotKey(slot) !== tail[0]) fail();
        exact(keyFor.activeSlot(slot)); return;
      }
      case 'eligibility_epoch':
        if (!integer(value)) fail();
        exact(keyFor.eligibilityEpoch()); return;
      case 'idempotency':
        record(value, ['record_type', 'command_id', 'command_type', 'command_digest', 'actor', 'result', 'tx_id']);
        record(value.actor, ['org_id', 'actor_id', 'kind']);
        if (value.record_type !== 'IdempotencyRecord' || !isId(value.command_id) || !isId(value.actor.org_id) || !isId(value.actor.actor_id) || !['human', 'agent'].includes(value.actor.kind) || !isDigest(value.command_digest) || typeof value.tx_id !== 'string' || value.tx_id.length < 1 || !['publish_revision', 'propose', 'decide', 'activate', 'withdraw', 'suspend', 'fence'].includes(value.command_type) || !value.result || typeof value.result.status !== 'string') fail();
        exact(keyFor.idempotency(value.actor.org_id, value.command_id)); return;
      case 'fence':
        record(value, ['nonce', 'eligibility_epoch', 'tx_id']);
        if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(value.nonce) || !integer(value.eligibility_epoch) || typeof value.tx_id !== 'string' || value.tx_id.length < 1) fail();
        exact(keyFor.fence(value.nonce)); return;
      default: fail();
    }
  } catch { fail(); }
}

export const IMMUTABLE_KINDS = new Set(['config', 'revision', 'revision_id', 'policy', 'decision', 'idempotency', 'fence']);

/** Run after all writes of a transaction are staged, so links may target its other writes. */
export function validateStateLinks(key: string, value: any, get: (key: string) => any): void {
  const parts = key.split(':');
  const tail = parts.slice(3).map(decodeURIComponent);
  const require = (key: string) => { const target = get(key); if (target === undefined) fail(); return target; };
  const sameSlot = (a: any, b: any) => slotKey(a) === slotKey(b);
  try {
    switch (parts[2]) {
      case 'revision_id': {
        const target = require(keyFor.revision(value.revision_digest));
        if (target.payload.revision_id !== tail[0] || target.revision_digest !== value.revision_digest) fail();
        break;
      }
      case 'revision':
        for (const parent of value.payload.parents) if (!sameSlot(require(keyFor.revision(parent)).payload, value.payload)) fail();
        for (const dependency of value.payload.dependencies) if (!sameSlot(require(keyFor.revision(dependency.revision_digest)).payload, dependency)) fail();
        break;
      case 'policy': {
        const config = require(keyFor.config());
        const pinned = config.policies.find((policy: any) => policy.policy_id === value.policy_id && policy.policy_version === value.policy_version);
        if (!pinned || canonicalize(pinned) !== canonicalize(value)) fail();
        break;
      }
      case 'proposal': {
        const revision = require(keyFor.revision(value.revision_digest));
        const policy = require(keyFor.policy(value.policy_id, value.policy_version));
        if (!sameSlot(value, revision.payload) || !sameSlot(value, policy) || policy.membership_epoch !== value.membership_epoch || policy.role_binding_version !== value.role_binding_version || require(keyFor.reviewCounter(value.proposal_id)) !== value.review_counter) fail();
        break;
      }
      case 'decision': {
        const proposal = require(keyFor.proposal(value.proposal_id));
        const policy = require(keyFor.policy(value.policy_id, value.policy_version));
        if (!sameSlot(value, proposal) || value.revision_digest !== proposal.revision_digest || value.policy_id !== proposal.policy_id || value.policy_version !== proposal.policy_version || value.membership_epoch !== proposal.membership_epoch || value.role_binding_version !== proposal.role_binding_version || !policy.role_representatives.some((rep: any) => rep.domain_role === value.actor_domain_role && rep.actor_org_id === value.actor_org_id && rep.actor_id === value.actor_id)) fail();
        break;
      }
      case 'latest_decision': {
        const decision = require(keyFor.decision(value.decision_id));
        if (key !== keyFor.latestDecision(decision.proposal_id, decision.policy_version, decision.actor_domain_role, decision.actor_org_id, decision.actor_id)) fail();
        break;
      }
      case 'review_counter': if (require(keyFor.proposal(tail[0])).review_counter !== value) fail(); break;
      case 'active_slot':
        if (value.agreement_id !== null) {
          const agreement = require(keyFor.agreement(value.agreement_id));
          if (agreement.status !== 'active' || key !== keyFor.activeSlot(agreement)) fail();
        }
        break;
      case 'agreement': {
        const revision = require(keyFor.revision(value.revision_digest));
        const policy = require(keyFor.policy(value.policy_id, value.policy_version));
        if (!sameSlot(value, revision.payload) || !sameSlot(value, policy) || value.membership_epoch !== policy.membership_epoch || value.role_binding_version !== policy.role_binding_version || value.approval_decision_ids.length !== policy.required_domain_roles.length) fail();
        const approvals = value.approval_decision_ids.map((id: string) => require(keyFor.decision(id)));
        for (const representative of policy.role_representatives) {
          const matches = approvals.filter((decision: any) => decision.actor_domain_role === representative.domain_role && decision.actor_org_id === representative.actor_org_id && decision.actor_id === representative.actor_id);
          if (matches.length !== 1) fail();
          const decision = matches[0];
          if (decision.decision !== 'approve' || !sameSlot(decision, value) || decision.proposal_id !== value.proposal_id || decision.revision_digest !== value.revision_digest || decision.policy_id !== value.policy_id || decision.policy_version !== value.policy_version || decision.membership_epoch !== value.membership_epoch || decision.role_binding_version !== value.role_binding_version) fail();
        }
        break;
      }
    }
  } catch { fail(); }
}
