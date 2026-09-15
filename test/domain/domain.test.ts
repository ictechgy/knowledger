import test from "node:test";
import assert from "node:assert/strict";
import {
  DomainError,
  type Actor,
  type DomainConfig,
  type DocumentRevision,
  type TxContext,
  digestPayload,
  execute,
  bootstrap,
  canonicalize,
  idempotencyDigest,
  keyFor,
  resolveAt,
  slotKey,
} from "../../packages/domain/index.ts";

type JsonMap = Map<string, unknown>;

const CHANNEL = "channel-test-001";
const SCOPE = "scope-order-001";
const CONFIG_VERSION = "cfg-test-v1";

const admin: Actor = { org_id: "org-test-admin", actor_id: "person-admin", kind: "human" };
const sales: Actor = { org_id: "org-test-sales", actor_id: "person-sales", kind: "human" };
const fulfillment: Actor = { org_id: "org-test-fulfillment", actor_id: "person-fulfillment", kind: "human" };
const salesAlt: Actor = { org_id: sales.org_id, actor_id: "person-sales-alt", kind: "human" };
const drafter: Actor = { org_id: "org-test-agent", actor_id: "agent-drafter", kind: "agent" };

function policy(
  policyId: string,
  documentId: string,
  contextId: string,
  usageScope: string,
  roles: Array<{ role: string; actor: Actor }>,
) {
  return {
    contract_type: "AgreementPolicy" as const,
    contract_version: 1 as const,
    policy_id: policyId,
    policy_version: 1,
    document_id: documentId,
    context_id: contextId,
    scope_id: SCOPE,
    usage_scope: usageScope,
    channel_id: CHANNEL,
    membership_epoch: 1,
    role_binding_version: 1,
    acceptance_slot: `${policyId}-slot`,
    required_domain_roles: roles.map((entry) => entry.role),
    allowed_decisions: ["approve", "object", "abstain", "retract"],
    role_decision_rule: "named_representatives" as const,
    role_representatives: roles.map((entry) => ({
      domain_role: entry.role,
      actor_org_id: entry.actor.org_id,
      actor_id: entry.actor.actor_id,
    })),
  };
}

const basePolicy = policy("policy-base-v1", "doc-base-001", "context-sales", "domain-definition/v1", [
  { role: "sales_owner", actor: sales },
]);
const reviewPolicy = policy("policy-review-v1", "doc-review-001", "context-review", "review-invitation/v1", [
  { role: "sales_owner", actor: sales },
  { role: "fulfillment_owner", actor: fulfillment },
]);

const config: DomainConfig = {
  config_version: CONFIG_VERSION,
  channel_id: CHANNEL,
  membership_epoch: 1,
  role_binding_version: 1,
  serving_enabled: true,
  identities: [
    { ...admin, publish_contexts: ["*"], can_propose: true },
    { ...sales, publish_contexts: ["context-sales", "context-review"], can_propose: true },
    { ...salesAlt, publish_contexts: ["context-sales"], can_propose: true },
    { ...fulfillment, publish_contexts: ["context-review"], can_propose: true },
    { ...drafter, publish_contexts: ["*"], can_propose: true },
  ],
  policies: [basePolicy, reviewPolicy],
};

function revision(input: {
  revisionId: string;
  documentId: string;
  contextId: string;
  usageScope: string;
  title?: string;
  body?: string;
  dependencies?: unknown[];
  parents?: string[];
  sourceKind?: "human_authored" | "approved_import" | "llm_drafted";
}): DocumentRevision {
  const payload = {
    contract_type: "DocumentRevision" as const,
    contract_version: 1 as const,
    revision_id: input.revisionId,
    document_id: input.documentId,
    context_id: input.contextId,
    scope_id: SCOPE,
    usage_scope: input.usageScope,
    channel_id: CHANNEL,
    visibility: "shared_channel" as const,
    title: input.title ?? input.revisionId,
    body_markdown: input.body ?? `# ${input.revisionId}\n\nShared rule.`,
    parents: input.parents ?? [],
    dependencies: input.dependencies ?? [],
    metadata: {
      author_id: sales.actor_id,
      created_at: "2026-09-15T00:00:00Z",
      source_kind: input.sourceKind ?? "human_authored",
      shared_assertions: [],
      author_org_id: sales.org_id,
    },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function memoryContext(store: JsonMap, actor: Actor, sequence: number): TxContext {
  return {
    actor,
    channel_id: CHANNEL,
    tx_id: `tx-${sequence}`,
    timestamp: `2026-09-15T00:00:${String(sequence).padStart(2, "0")}Z`,
    async get(key) {
      return store.get(key);
    },
    async put(key, value) {
      store.set(key, structuredClone(value));
    },
  };
}

async function command(store: JsonMap, actor: Actor, sequence: number, commandId: string, type: string, input: unknown) {
  return execute(memoryContext(store, actor, sequence), { command_id: commandId, type, input });
}

async function publish(store: JsonMap, actor: Actor, sequence: number, commandId: string, value: DocumentRevision) {
  return command(store, actor, sequence, commandId, "publish_revision", {
    revision: value,
    publication: { revision_digest: value.revision_digest, config_version: CONFIG_VERSION, membership_epoch: 1 },
  });
}

async function propose(store: JsonMap, actor: Actor, sequence: number, commandId: string, proposalId: string, value: DocumentRevision, policyId: string) {
  return command(store, actor, sequence, commandId, "propose", {
    proposal_id: proposalId,
    revision_digest: value.revision_digest,
    policy_id: policyId,
    policy_version: 1,
  });
}

async function approve(store: JsonMap, actor: Actor, sequence: number, commandId: string, proposalId: string, value: DocumentRevision, policyId: string, role: string, decisionId = commandId) {
  return command(store, actor, sequence, commandId, "decide", {
    decision: {
      contract_type: "ApprovalDecision",
      contract_version: 1,
      decision_id: decisionId,
      revision_digest: value.revision_digest,
      document_id: value.payload.document_id,
      context_id: value.payload.context_id,
      scope_id: value.payload.scope_id,
      usage_scope: value.payload.usage_scope,
      channel_id: CHANNEL,
      policy_id: policyId,
      policy_version: 1,
      membership_epoch: 1,
      role_binding_version: 1,
      actor_org_id: actor.org_id,
      actor_id: actor.actor_id,
      subject_id: `subject-${proposalId}`,
      actor_domain_role: role,
      decision: "approve",
      rationale: "Reviewed against the bounded context.",
      decided_at: "2026-09-15T00:00:00Z",
      proposal_id: proposalId,
    },
  });
}

async function activate(store: JsonMap, actor: Actor, sequence: number, commandId: string, proposalId: string, agreementId: string, expected: string | null) {
  return command(store, actor, sequence, commandId, "activate", {
    proposal_id: proposalId,
    agreement_id: agreementId,
    expected_active_agreement_id: expected,
  });
}

async function expectDomain(code: string, action: () => Promise<unknown>) {
  await assert.rejects(action, (error: unknown) => error instanceof DomainError && error.code === code);
}

function graphSlot(label: string) {
  return {
    channel_id: CHANNEL,
    document_id: `doc-${label}`,
    context_id: `context-${label}`,
    scope_id: SCOPE,
    usage_scope: "domain-definition/v1",
  };
}

function graphPolicy(label: string, slot: ReturnType<typeof graphSlot>) {
  return policy(`policy-${label}`, slot.document_id, slot.context_id, slot.usage_scope, [{ role: "graph_owner", actor: admin }]);
}

function graphRevision(label: string, slot: ReturnType<typeof graphSlot>, dependencies: unknown[] = []): DocumentRevision {
  const payload = {
    contract_type: "DocumentRevision" as const,
    contract_version: 1 as const,
    revision_id: `rev-${label}`,
    document_id: slot.document_id,
    context_id: slot.context_id,
    scope_id: slot.scope_id,
    usage_scope: slot.usage_scope,
    channel_id: slot.channel_id,
    visibility: "shared_channel" as const,
    title: `Graph ${label}`,
    body_markdown: `# Graph ${label}`,
    parents: [],
    dependencies,
    metadata: {
      author_id: admin.actor_id,
      created_at: "2026-09-15T00:00:00Z",
      source_kind: "human_authored" as const,
      shared_assertions: [],
      author_org_id: admin.org_id,
    },
  };
  return { revision_digest: digestPayload(payload), payload };
}

function graphDependency(value: DocumentRevision) {
  return {
    revision_digest: value.revision_digest,
    context_id: value.payload.context_id,
    usage_scope: value.payload.usage_scope,
    relationship: "graph_dependency",
    enforcement: "requires_active" as const,
    document_id: value.payload.document_id,
    scope_id: value.payload.scope_id,
    channel_id: value.payload.channel_id,
  };
}

function installGraphAgreement(store: JsonMap, value: DocumentRevision, policyValue: ReturnType<typeof graphPolicy>, label: string) {
  store.set(keyFor.revision(value.revision_digest), value);
  store.set(keyFor.agreement(`agreement-${label}`), {
    agreement_id: `agreement-${label}`,
    proposal_id: `proposal-${label}`,
    revision_digest: value.revision_digest,
    policy_id: policyValue.policy_id,
    policy_version: 1,
    membership_epoch: 1,
    role_binding_version: 1,
    approval_decision_ids: [`decision-${label}`],
    status: "active",
    activated_by: admin,
    activated_at: "2026-09-15T00:00:00Z",
    channel_id: value.payload.channel_id,
    document_id: value.payload.document_id,
    context_id: value.payload.context_id,
    scope_id: value.payload.scope_id,
    usage_scope: value.payload.usage_scope,
  });
  store.set(keyFor.activeSlot(value.payload), { agreement_id: `agreement-${label}` });
}

async function boot(): Promise<JsonMap> {
  const store: JsonMap = new Map();
  await bootstrap(memoryContext(store, admin, 1), config);
  return store;
}

test("JCS digest binds the full immutable revision and rejects malformed input", async () => {
  const store = await boot();
  const value = revision({ revisionId: "rev-base-001", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, sales, 2, "cmd-publish-base", value);
  assert.deepEqual(store.get(keyFor.revisionId(value.payload.revision_id)), { revision_digest: value.revision_digest });
  const changed = structuredClone(value);
  changed.payload.body_markdown = "# Changed";
  await expectDomain("DIGEST_MISMATCH", () => publish(store, sales, 3, "cmd-publish-changed", changed));
  const bad = structuredClone(value) as unknown as Record<string, unknown>;
  (bad.payload as Record<string, unknown>).agreement_id = "agreement-forbidden";
  await expectDomain("INVALID_INPUT", () => publish(store, sales, 4, "cmd-publish-agreement-field", bad as unknown as DocumentRevision));
  const unknown = structuredClone(value) as unknown as Record<string, unknown>;
  (unknown.payload as Record<string, unknown>).unexpected = true;
  await expectDomain("INVALID_INPUT", () => publish(store, sales, 5, "cmd-publish-unknown-field", unknown as unknown as DocumentRevision));
});

test("authorization, idempotency binding, and agent approval restrictions are enforced", async () => {
  const store = await boot();
  const drafted = revision({ revisionId: "rev-agent-001", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", sourceKind: "llm_drafted" });
  await publish(store, drafter, 2, "cmd-agent-publish", drafted);
  const human = revision({ revisionId: "rev-human-001", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, drafter, 3, "cmd-agent-human-publish", human);
  const proposalId = "proposal-agent-001";
  await propose(store, drafter, 4, "cmd-agent-propose", proposalId, drafted, basePolicy.policy_id);
  await expectDomain("FORBIDDEN", () => command(store, drafter, 5, "cmd-agent-decide", "decide", { decision: { contract_type: "ApprovalDecision", contract_version: 1, decision_id: "decision-agent-001", revision_digest: drafted.revision_digest, document_id: drafted.payload.document_id, context_id: drafted.payload.context_id, scope_id: SCOPE, usage_scope: drafted.payload.usage_scope, channel_id: CHANNEL, policy_id: basePolicy.policy_id, policy_version: 1, membership_epoch: 1, role_binding_version: 1, actor_org_id: drafter.org_id, actor_id: drafter.actor_id, subject_id: "subject-agent", actor_domain_role: "sales_owner", decision: "approve", rationale: "agent must be rejected", decided_at: "2026-09-15T00:00:00Z", proposal_id: proposalId } }));
  await expectDomain("IDEMPOTENCY_CONFLICT", () => publish(store, drafter, 6, "cmd-agent-human-publish", drafted));
});

test("named representatives, exact proposal binding, dependency activation, and resolver are enforced", async () => {
  const store = await boot();
  const base = revision({ revisionId: "rev-base-002", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, sales, 2, "cmd-pub-base", base);
  await propose(store, sales, 3, "cmd-prop-base", "proposal-base-001", base, basePolicy.policy_id);
  await approve(store, sales, 4, "cmd-dec-base", "proposal-base-001", base, basePolicy.policy_id, "sales_owner");
  await activate(store, admin, 5, "cmd-act-base", "proposal-base-001", "agreement-base-001", null);
  const dependent = revision({
    revisionId: "rev-review-001",
    documentId: "doc-review-001",
    contextId: "context-review",
    usageScope: "review-invitation/v1",
    dependencies: [{ revision_digest: base.revision_digest, context_id: base.payload.context_id, usage_scope: base.payload.usage_scope, relationship: "order_definition", enforcement: "requires_active", document_id: base.payload.document_id, scope_id: SCOPE, channel_id: CHANNEL }],
  });
  await publish(store, sales, 6, "cmd-pub-review", dependent);
  await propose(store, sales, 7, "cmd-prop-review", "proposal-review-001", dependent, reviewPolicy.policy_id);
  await approve(store, sales, 8, "cmd-dec-review-sales", "proposal-review-001", dependent, reviewPolicy.policy_id, "sales_owner");
  await approve(store, fulfillment, 9, "cmd-dec-review-fulfillment", "proposal-review-001", dependent, reviewPolicy.policy_id, "fulfillment_owner");
  const activation = await activate(store, admin, 10, "cmd-act-review", "proposal-review-001", "agreement-review-001", null) as { agreement_id: string };
  assert.equal(activation.agreement_id, "agreement-review-001");
  const resolved = await resolveAt((key) => Promise.resolve(store.get(key)), dependent.payload);
  assert.equal(resolved.eligible, true);
  assert.equal(resolved.revision?.revision_digest, dependent.revision_digest);
  const wrongProposalDecision = structuredClone((await store.get(keyFor.decision("cmd-dec-review-sales"))) as Record<string, unknown>);
  (wrongProposalDecision as Record<string, unknown>).decision_id = "decision-replay-001";
  (wrongProposalDecision as Record<string, unknown>).proposal_id = "proposal-other-001";
  await expectDomain("PROPOSAL_NOT_FOUND", () => command(store, sales, 11, "cmd-replay-decision", "decide", { decision: wrongProposalDecision }));
});

test("publication validates dependency existence and exact target slots while allowing inactive prerequisites", async () => {
  const store = await boot();
  const base = revision({ revisionId: "rev-dep-publish-base", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, sales, 2, "cmd-dep-publish-base", base);
  const inactiveDependency = revision({
    revisionId: "rev-dep-publish-dependent",
    documentId: "doc-review-001",
    contextId: "context-review",
    usageScope: "review-invitation/v1",
    dependencies: [graphDependency(base)],
  });
  await publish(store, sales, 3, "cmd-dep-publish-dependent", inactiveDependency);
  const unknownDependency = revision({
    revisionId: "rev-dep-publish-unknown",
    documentId: "doc-review-001",
    contextId: "context-review",
    usageScope: "review-invitation/v1",
    dependencies: [{ ...graphDependency(base), revision_digest: `sha256:${"a".repeat(64)}` }],
  });
  await expectDomain("DEPENDENCY_NOT_FOUND", () => publish(store, sales, 4, "cmd-dep-publish-unknown", unknownDependency));
  const wrongSlotDependency = revision({
    revisionId: "rev-dep-publish-wrong-slot",
    documentId: "doc-review-001",
    contextId: "context-review",
    usageScope: "review-invitation/v1",
    dependencies: [{ ...graphDependency(base), context_id: "context-other" }],
  });
  await expectDomain("DEPENDENCY_SCOPE_MISMATCH", () => publish(store, sales, 5, "cmd-dep-publish-wrong-slot", wrongSlotDependency));
});

test("active objections and approval retractions suspend without reviving prior approvals", async () => {
  const store = await boot();
  const base = revision({ revisionId: "rev-base-003", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, sales, 2, "cmd-pub-base-003", base);
  await propose(store, sales, 3, "cmd-prop-base-003", "proposal-base-003", base, basePolicy.policy_id);
  await approve(store, sales, 4, "cmd-dec-base-003", "proposal-base-003", base, basePolicy.policy_id, "sales_owner", "decision-base-003");
  await activate(store, admin, 5, "cmd-act-base-003", "proposal-base-003", "agreement-base-003", null);
  const objectDecision = {
    contract_type: "ApprovalDecision",
    contract_version: 1,
    decision_id: "decision-object-003",
    revision_digest: base.revision_digest,
    document_id: base.payload.document_id,
    context_id: base.payload.context_id,
    scope_id: SCOPE,
    usage_scope: base.payload.usage_scope,
    channel_id: CHANNEL,
    policy_id: basePolicy.policy_id,
    policy_version: 1,
    membership_epoch: 1,
    role_binding_version: 1,
    actor_org_id: sales.org_id,
    actor_id: sales.actor_id,
    subject_id: "subject-base-003",
    actor_domain_role: "sales_owner",
    decision: "object",
    rationale: "The active rule needs review.",
    decided_at: "2026-09-15T00:01:00Z",
    proposal_id: "proposal-base-003",
  };
  await command(store, sales, 6, "cmd-object-003", "decide", { decision: objectDecision });
  const afterObject = await resolveAt((key) => Promise.resolve(store.get(key)), base.payload);
  assert.equal(afterObject.eligible, false);
  assert.match(afterObject.reason ?? "", /NO_ACTIVE|SUSPENDED/);
  const retractObject = structuredClone(objectDecision) as Record<string, unknown>;
  retractObject.decision_id = "decision-retract-object-003";
  retractObject.decision = "retract";
  retractObject.retracts_decision_id = "decision-object-003";
  retractObject.rationale = "Retracting the objection does not silently resume the agreement.";
  await command(store, sales, 7, "cmd-retract-object-003", "decide", { decision: retractObject });
  const afterRetract = await resolveAt((key) => Promise.resolve(store.get(key)), base.payload);
  assert.equal(afterRetract.eligible, false);
  await expectDomain("PROPOSAL_REPLAY", () => activate(store, admin, 8, "cmd-resume-old-proposal", "proposal-base-003", "agreement-base-004", null));

  await propose(store, sales, 9, "cmd-prop-base-003-fresh", "proposal-base-003-fresh", base, basePolicy.policy_id);
  await approve(store, sales, 10, "cmd-dec-base-003-fresh", "proposal-base-003-fresh", base, basePolicy.policy_id, "sales_owner", "decision-base-003-fresh");
  await activate(store, admin, 11, "cmd-act-base-003-fresh", "proposal-base-003-fresh", "agreement-base-003-fresh", null);
  const abstainDecision = structuredClone(objectDecision) as Record<string, unknown>;
  abstainDecision.decision_id = "decision-abstain-003";
  abstainDecision.decision = "abstain";
  abstainDecision.proposal_id = "proposal-base-003-fresh";
  abstainDecision.rationale = "The representative abstains pending a fresh review.";
  delete abstainDecision.retracts_decision_id;
  await command(store, sales, 12, "cmd-abstain-003", "decide", { decision: abstainDecision });
  assert.equal((await resolveAt((key) => Promise.resolve(store.get(key)), base.payload)).eligible, false);
  const retractAbstain = structuredClone(abstainDecision);
  retractAbstain.decision_id = "decision-retract-abstain-003";
  retractAbstain.decision = "retract";
  retractAbstain.retracts_decision_id = "decision-abstain-003";
  retractAbstain.rationale = "Clearing abstention does not auto-resume the suspended agreement.";
  await command(store, sales, 13, "cmd-retract-abstain-003", "decide", { decision: retractAbstain });
  assert.equal((await resolveAt((key) => Promise.resolve(store.get(key)), base.payload)).eligible, false);

  await propose(store, sales, 14, "cmd-prop-base-003-reapprove", "proposal-base-003-reapprove", base, basePolicy.policy_id);
  await approve(store, sales, 15, "cmd-dec-base-003-reapprove", "proposal-base-003-reapprove", base, basePolicy.policy_id, "sales_owner", "decision-base-003-reapprove");
  await activate(store, admin, 16, "cmd-act-base-003-reapprove", "proposal-base-003-reapprove", "agreement-base-003-reapprove", null);
  const retractApprove = structuredClone(abstainDecision) as Record<string, unknown>;
  retractApprove.decision_id = "decision-retract-approve-003";
  retractApprove.decision = "retract";
  retractApprove.proposal_id = "proposal-base-003-reapprove";
  retractApprove.retracts_decision_id = "decision-base-003-reapprove";
  retractApprove.rationale = "The fresh approval was explicitly retracted.";
  await command(store, sales, 17, "cmd-retract-approve-003", "decide", { decision: retractApprove });
  assert.equal((await resolveAt((key) => Promise.resolve(store.get(key)), base.payload)).eligible, false);
});

test("withdrawal invalidates dependent resolution and activation uses an explicit active-slot CAS", async () => {
  const store = await boot();
  const base = revision({ revisionId: "rev-base-004", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await publish(store, sales, 2, "cmd-pub-base-004", base);
  await propose(store, sales, 3, "cmd-prop-base-004", "proposal-base-004", base, basePolicy.policy_id);
  await approve(store, sales, 4, "cmd-dec-base-004", "proposal-base-004", base, basePolicy.policy_id, "sales_owner");
  await activate(store, admin, 5, "cmd-act-base-004", "proposal-base-004", "agreement-base-004", null);
  const dependent = revision({
    revisionId: "rev-review-004",
    documentId: "doc-review-001",
    contextId: "context-review",
    usageScope: "review-invitation/v1",
    dependencies: [{ revision_digest: base.revision_digest, context_id: base.payload.context_id, usage_scope: base.payload.usage_scope, relationship: "order_definition", enforcement: "requires_active", document_id: base.payload.document_id, scope_id: SCOPE, channel_id: CHANNEL }],
  });
  await publish(store, sales, 6, "cmd-pub-review-004", dependent);
  await propose(store, sales, 7, "cmd-prop-review-004", "proposal-review-004", dependent, reviewPolicy.policy_id);
  await approve(store, sales, 8, "cmd-dec-review-sales-004", "proposal-review-004", dependent, reviewPolicy.policy_id, "sales_owner");
  await approve(store, fulfillment, 9, "cmd-dec-review-fulfillment-004", "proposal-review-004", dependent, reviewPolicy.policy_id, "fulfillment_owner");
  await activate(store, admin, 10, "cmd-act-review-004", "proposal-review-004", "agreement-review-004", null);
  await command(store, sales, 11, "cmd-withdraw-base-004", "withdraw", { agreement_id: "agreement-base-004", reason: "Source definition withdrawn for correction." });
  const resolved = await resolveAt((key) => Promise.resolve(store.get(key)), dependent.payload);
  assert.equal(resolved.eligible, false);
  assert.match(resolved.reason ?? "", /DEPENDENCY_INELIGIBLE/);

  const replacement = revision({ revisionId: "rev-review-004b", documentId: "doc-review-001", contextId: "context-review", usageScope: "review-invitation/v1", body: "# Replacement\n\nA new interpretation." });
  await publish(store, sales, 12, "cmd-pub-review-004b", replacement);
  await propose(store, sales, 13, "cmd-prop-review-004b-a", "proposal-review-004b-a", replacement, reviewPolicy.policy_id);
  await propose(store, sales, 14, "cmd-prop-review-004b-b", "proposal-review-004b-b", replacement, reviewPolicy.policy_id);
  await approve(store, sales, 15, "cmd-dec-review-004b-a-sales", "proposal-review-004b-a", replacement, reviewPolicy.policy_id, "sales_owner");
  await approve(store, fulfillment, 16, "cmd-dec-review-004b-a-fulfillment", "proposal-review-004b-a", replacement, reviewPolicy.policy_id, "fulfillment_owner");
  await activate(store, admin, 17, "cmd-act-review-004b-a", "proposal-review-004b-a", "agreement-review-004b-a", "agreement-review-004");
  await expectDomain("STALE_PRECONDITION", () => activate(store, admin, 18, "cmd-act-review-004b-b", "proposal-review-004b-b", "agreement-review-004b-b", "agreement-review-004"));
});

test("fences persist only nonce, epoch, and transaction id", async () => {
  const store = await boot();
  const result = await command(store, admin, 2, "cmd-fence-001", "fence", { nonce: "nonce-1234567890abcdef" }) as { eligibility_epoch: number; tx_id: string };
  assert.equal(result.eligibility_epoch, 0);
  assert.equal(result.tx_id, "tx-2");
  const stored = store.get(keyFor.fence("nonce-1234567890abcdef")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(stored).sort(), ["eligibility_epoch", "nonce", "tx_id"]);
  await expectDomain("IMMUTABLE_CONFLICT", () => command(store, admin, 3, "cmd-fence-002", "fence", { nonce: "nonce-1234567890abcdef" }));
});

test("slot key includes every acceptance dimension", () => {
  assert.equal(slotKey({ channel_id: CHANNEL, document_id: "doc-a", context_id: "context-a", scope_id: SCOPE, usage_scope: "domain-definition/v1" }), `${CHANNEL}|doc-a|context-a|${SCOPE}|domain-definition/v1`);
  assert.notEqual(slotKey({ channel_id: CHANNEL, document_id: "doc-a", context_id: "context-a", scope_id: SCOPE, usage_scope: "domain-definition/v1" }), slotKey({ channel_id: CHANNEL, document_id: "doc-a", context_id: "context-b", scope_id: SCOPE, usage_scope: "domain-definition/v1" }));
});

test("canonicalization rejects lone surrogates, cycles, accessors, and unbounded nesting", () => {
  assert.throws(() => canonicalize("\ud800"), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT");
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalize(cyclic), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT");
  const accessor = {};
  Object.defineProperty(accessor, "value", { enumerable: true, get: () => "unstable" });
  assert.throws(() => canonicalize(accessor), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT");
  const customArray: unknown[] = [];
  Object.defineProperty(customArray, "metadata", { enumerable: true, value: "unexpected" });
  assert.throws(() => canonicalize(customArray), (error: unknown) => error instanceof DomainError && error.code === "INVALID_INPUT");
  let nested: unknown = null;
  for (let index = 0; index < 140; index += 1) nested = { nested };
  assert.throws(() => canonicalize(nested), (error: unknown) => error instanceof DomainError && error.code === "CANONICALIZATION_LIMIT");
});

test("UTF-8 body limit is byte exact and CRLF remains an immutable authored byte sequence", async () => {
  const store = await boot();
  const exact = revision({ revisionId: "rev-byte-exact", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "a".repeat(262144) });
  await publish(store, sales, 2, "cmd-byte-exact", exact);
  const crlf = revision({ revisionId: "rev-crlf", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "line one\r\nline two" });
  await publish(store, sales, 3, "cmd-crlf", crlf);
  const tooLarge = revision({ revisionId: "rev-byte-too-large", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "a".repeat(262145) });
  await expectDomain("INVALID_INPUT", () => publish(store, sales, 4, "cmd-byte-too-large", tooLarge));
});

test("idempotency digest is stable and the organization scoped key rejects a different actor", async () => {
  const store = await boot();
  const value = revision({ revisionId: "rev-idempotency", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  const first = { command_id: "cmd-org-collision", type: "publish_revision", input: { revision: value, publication: { revision_digest: value.revision_digest, config_version: CONFIG_VERSION, membership_epoch: 1 } } } as const;
  assert.equal(idempotencyDigest(first), idempotencyDigest(structuredClone(first)));
  await execute(memoryContext(store, sales, 2), first);
  await expectDomain("IDEMPOTENCY_CONFLICT", () => execute(memoryContext(store, salesAlt, 3), first));
});

test("frozen serving configuration fails closed for publication and authoritative resolution", async () => {
  const store: JsonMap = new Map();
  await bootstrap(memoryContext(store, admin, 1), { ...config, serving_enabled: false });
  const value = revision({ revisionId: "rev-frozen", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  await expectDomain("SERVING_FROZEN", () => publish(store, sales, 2, "cmd-frozen-publish", value));
  const resolved = await resolveAt((key) => Promise.resolve(store.get(key)), value.payload);
  assert.equal(resolved.eligible, false);
  assert.equal(resolved.reason, "SERVING_FROZEN");
});

test("approval events reject stale proposal, revision, policy, and scope bindings", async () => {
  const store = await boot();
  const base = revision({ revisionId: "rev-binding-base", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  const otherRevision = revision({ revisionId: "rev-binding-other", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "# Different immutable revision" });
  await publish(store, sales, 2, "cmd-binding-pub-base", base);
  await publish(store, sales, 3, "cmd-binding-pub-other", otherRevision);
  await propose(store, sales, 4, "cmd-binding-proposal", "proposal-binding", base, basePolicy.policy_id);
  await expectDomain("PROPOSAL_NOT_FOUND", () => command(store, sales, 5, "cmd-binding-missing-proposal", "decide", { decision: { contract_type: "ApprovalDecision", contract_version: 1, decision_id: "decision-binding-missing-proposal", revision_digest: base.revision_digest, document_id: base.payload.document_id, context_id: base.payload.context_id, scope_id: SCOPE, usage_scope: base.payload.usage_scope, channel_id: CHANNEL, policy_id: basePolicy.policy_id, policy_version: 1, membership_epoch: 1, role_binding_version: 1, actor_org_id: sales.org_id, actor_id: sales.actor_id, subject_id: "subject-binding", actor_domain_role: "sales_owner", decision: "approve", rationale: "missing proposal", decided_at: "2026-09-15T00:00:00Z", proposal_id: "proposal-does-not-exist" } }));
  const validDecision = {
    contract_type: "ApprovalDecision",
    contract_version: 1,
    decision_id: "decision-binding-valid",
    revision_digest: base.revision_digest,
    document_id: base.payload.document_id,
    context_id: base.payload.context_id,
    scope_id: SCOPE,
    usage_scope: base.payload.usage_scope,
    channel_id: CHANNEL,
    policy_id: basePolicy.policy_id,
    policy_version: 1,
    membership_epoch: 1,
    role_binding_version: 1,
    actor_org_id: sales.org_id,
    actor_id: sales.actor_id,
    subject_id: "subject-binding",
    actor_domain_role: "sales_owner",
    decision: "approve",
    rationale: "valid binding",
    decided_at: "2026-09-15T00:00:00Z",
    proposal_id: "proposal-binding",
  };
  const wrongRevision = structuredClone(validDecision);
  wrongRevision.decision_id = "decision-binding-wrong-revision";
  wrongRevision.revision_digest = otherRevision.revision_digest;
  await expectDomain("STALE_DECISION", () => command(store, sales, 6, "cmd-binding-wrong-revision", "decide", { decision: wrongRevision }));
  const wrongPolicy = structuredClone(validDecision);
  wrongPolicy.decision_id = "decision-binding-wrong-policy";
  wrongPolicy.policy_id = reviewPolicy.policy_id;
  await expectDomain("STALE_DECISION", () => command(store, sales, 7, "cmd-binding-wrong-policy", "decide", { decision: wrongPolicy }));
  const wrongScope = structuredClone(validDecision);
  wrongScope.decision_id = "decision-binding-wrong-scope";
  wrongScope.scope_id = "scope-other-001";
  await expectDomain("STALE_DECISION", () => command(store, sales, 8, "cmd-binding-wrong-scope", "decide", { decision: wrongScope }));
  await command(store, sales, 9, "cmd-binding-valid", "decide", { decision: validDecision });
  const active = await activate(store, admin, 10, "cmd-binding-activate", "proposal-binding", "agreement-binding", null) as { agreement_id: string };
  assert.equal(active.agreement_id, "agreement-binding");
  const storedAgreement = store.get(keyFor.agreement("agreement-binding")) as Record<string, unknown>;
  assert.deepEqual(storedAgreement.approval_decision_ids, ["decision-binding-valid"]);
  const replay = structuredClone(validDecision);
  await expectDomain("IMMUTABLE_CONFLICT", () => command(store, sales, 11, "cmd-binding-replay", "decide", { decision: replay }));
});

test("immutable parent history is not truncated at the dependency traversal limit", async () => {
  const store = await boot();
  let parent: string | undefined;
  for (let index = 0; index < 10; index += 1) {
    const value = revision({
      revisionId: `rev-parent-${String(index).padStart(2, "0")}`,
      documentId: "doc-base-001",
      contextId: "context-sales",
      usageScope: "domain-definition/v1",
      body: `# Parent ${index}\n\nExact immutable snapshot ${index}.`,
      parents: parent ? [parent] : [],
    });
    await publish(store, sales, index + 2, `cmd-parent-${index}`, value);
    parent = value.revision_digest;
  }
  assert.ok(parent);
  assert.ok(store.get(keyFor.revision(parent)));
});

test("two different immutable revisions in one slot still obey the active agreement CAS", async () => {
  const store = await boot();
  const first = revision({ revisionId: "rev-cas-first", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1" });
  const second = revision({ revisionId: "rev-cas-second", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "# Second\n\nAnother immutable interpretation." });
  const third = revision({ revisionId: "rev-cas-third", documentId: "doc-base-001", contextId: "context-sales", usageScope: "domain-definition/v1", body: "# Third\n\nA competing immutable interpretation." });
  await publish(store, sales, 2, "cmd-cas-publish-first", first);
  await propose(store, sales, 3, "cmd-cas-propose-first", "proposal-cas-first", first, basePolicy.policy_id);
  await approve(store, sales, 4, "cmd-cas-decide-first", "proposal-cas-first", first, basePolicy.policy_id, "sales_owner");
  await activate(store, admin, 5, "cmd-cas-activate-first", "proposal-cas-first", "agreement-cas-first", null);
  await publish(store, sales, 6, "cmd-cas-publish-second", second);
  await publish(store, sales, 7, "cmd-cas-publish-third", third);
  await propose(store, sales, 8, "cmd-cas-propose-second", "proposal-cas-second", second, basePolicy.policy_id);
  await propose(store, sales, 9, "cmd-cas-propose-third", "proposal-cas-third", third, basePolicy.policy_id);
  await approve(store, sales, 10, "cmd-cas-decide-second", "proposal-cas-second", second, basePolicy.policy_id, "sales_owner");
  await approve(store, sales, 11, "cmd-cas-decide-third", "proposal-cas-third", third, basePolicy.policy_id, "sales_owner");
  await activate(store, admin, 12, "cmd-cas-activate-second", "proposal-cas-second", "agreement-cas-second", "agreement-cas-first");
  const staleObject = structuredClone((await store.get(keyFor.decision("cmd-cas-decide-first"))) as Record<string, unknown>);
  staleObject.decision_id = "decision-cas-old-object";
  staleObject.decision = "object";
  staleObject.rationale = "An old proposal must not suspend a newer active agreement.";
  await command(store, sales, 13, "cmd-cas-old-object", "decide", { decision: staleObject });
  assert.equal((await resolveAt((key) => Promise.resolve(store.get(key)), second.payload)).eligible, true);
  await expectDomain("STALE_PRECONDITION", () => activate(store, admin, 14, "cmd-cas-activate-third", "proposal-cas-third", "agreement-cas-third", "agreement-cas-first"));
});

test("resolver fails closed for dependency depth and distinct-node budgets", async () => {
  const store = await boot();
  const graphPolicies = [...config.policies];
  const chain: Array<{ value: DocumentRevision; slot: ReturnType<typeof graphSlot>; policy: ReturnType<typeof graphPolicy> }> = [];
  let child: DocumentRevision | undefined;
  for (let index = 10; index >= 0; index -= 1) {
    const label = `depth-${String(index).padStart(2, "0")}`;
    const slot = graphSlot(label);
    const policyValue = graphPolicy(label, slot);
    const value = graphRevision(label, slot, child ? [graphDependency(child)] : []);
    graphPolicies.push(policyValue);
    installGraphAgreement(store, value, policyValue, label);
    chain.unshift({ value, slot, policy: policyValue });
    child = value;
  }
  store.set(keyFor.config(), { ...config, policies: graphPolicies });
  const depthResult = await resolveAt((key) => Promise.resolve(store.get(key)), chain[0].slot);
  assert.equal(depthResult.eligible, false);
  assert.match(depthResult.reason ?? "", /DEPENDENCY_INELIGIBLE|DEPENDENCY_DEPTH/);

  const fanoutPolicies = [...graphPolicies];
  const branches: DocumentRevision[] = [];
  for (let branchIndex = 0; branchIndex < 32; branchIndex += 1) {
    const leaves: DocumentRevision[] = [];
    for (let leafIndex = 0; leafIndex < 8; leafIndex += 1) {
      const label = `fanout-${String(branchIndex).padStart(2, "0")}-${String(leafIndex).padStart(2, "0")}`;
      const slot = graphSlot(label);
      const policyValue = graphPolicy(label, slot);
      const value = graphRevision(label, slot);
      fanoutPolicies.push(policyValue);
      installGraphAgreement(store, value, policyValue, label);
      leaves.push(value);
    }
    const branchLabel = `fanout-branch-${String(branchIndex).padStart(2, "0")}`;
    const branchSlot = graphSlot(branchLabel);
    const branchPolicy = graphPolicy(branchLabel, branchSlot);
    const branch = graphRevision(branchLabel, branchSlot, leaves.map(graphDependency));
    fanoutPolicies.push(branchPolicy);
    installGraphAgreement(store, branch, branchPolicy, branchLabel);
    branches.push(branch);
  }
  const rootLabel = "fanout-root";
  const rootSlot = graphSlot(rootLabel);
  const rootPolicy = graphPolicy(rootLabel, rootSlot);
  const root = graphRevision(rootLabel, rootSlot, branches.map(graphDependency));
  fanoutPolicies.push(rootPolicy);
  installGraphAgreement(store, root, rootPolicy, rootLabel);
  store.set(keyFor.config(), { ...config, policies: fanoutPolicies });
  const fanoutResult = await resolveAt((key) => Promise.resolve(store.get(key)), rootSlot);
  assert.equal(fanoutResult.eligible, false);
  assert.match(fanoutResult.reason ?? "", /DEPENDENCY_INELIGIBLE|DEPENDENCY_NODE_LIMIT/);
});
