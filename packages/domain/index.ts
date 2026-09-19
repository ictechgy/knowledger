import { createHash } from "node:crypto";

/**
 * The Knowledger domain port deliberately depends on only a tiny transaction context.
 * A Fabric adapter and the local adapter both provide the same read/write
 * semantics.  The adapter is responsible for rolling back all writes when an
 * invocation throws and for applying MVCC/CAS at commit time.
 */

export type ActorKind = "human" | "agent";

export interface Actor {
  org_id: string;
  actor_id: string;
  kind: ActorKind;
}

export interface TxContext {
  actor: Actor;
  channel_id: string;
  tx_id: string;
  timestamp: string;
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface DomainCommand {
  command_id: string;
  type: string;
  input: unknown;
}

export interface Slot {
  channel_id: string;
  document_id: string;
  context_id: string;
  scope_id: string;
  usage_scope: string;
}

export interface RevisionDependency extends Slot {
  revision_digest: string;
  relationship: string;
  enforcement: "requires_active" | "informational";
}

export interface SharedAssertion {
  assertion_id: string;
  statement: string;
  source_visibility: "private_shared_assertion";
}

export interface DocumentRevisionPayload extends Slot {
  contract_type: "DocumentRevision";
  contract_version: 1;
  revision_id: string;
  visibility: "shared_channel";
  title: string;
  body_markdown: string;
  parents: string[];
  dependencies: RevisionDependency[];
  metadata: {
    author_id: string;
    created_at: string;
    source_kind: "human_authored" | "approved_import" | "llm_drafted";
    shared_assertions: SharedAssertion[];
    author_org_id: string;
  };
}

export interface DocumentRevision {
  revision_digest: string;
  payload: DocumentRevisionPayload;
}

export interface RoleRepresentative {
  domain_role: string;
  actor_org_id: string;
  actor_id: string;
}

export interface AgreementPolicy extends Slot {
  contract_type: "AgreementPolicy";
  contract_version: 1;
  policy_id: string;
  policy_version: number;
  membership_epoch: number;
  role_binding_version: number;
  acceptance_slot: string;
  required_domain_roles: string[];
  allowed_decisions: string[];
  role_decision_rule: "named_representatives";
  role_representatives: RoleRepresentative[];
}

export type ApprovalKind = "approve" | "object" | "abstain" | "retract";

export interface ApprovalDecision {
  contract_type: "ApprovalDecision";
  contract_version: 1;
  decision_id: string;
  revision_digest: string;
  document_id: string;
  context_id: string;
  scope_id: string;
  usage_scope: string;
  channel_id: string;
  policy_id: string;
  policy_version: number;
  membership_epoch: number;
  role_binding_version: number;
  actor_org_id: string;
  actor_id: string;
  subject_id: string;
  actor_domain_role: string;
  decision: ApprovalKind;
  rationale: string;
  decided_at: string;
  proposal_id: string;
  retracts_decision_id?: string;
}

export interface ConfigIdentity extends Actor {
  publish_contexts: string[];
  can_propose: boolean;
}

/**
 * `config_version` is intentionally an opaque immutable application version.
 * Deployments may use a numeric version or a named version such as `cfg-2026-09`.
 */
export type ConfigVersion = string | number;

export interface DomainConfig {
  config_version: ConfigVersion;
  channel_id: string;
  membership_epoch: number;
  role_binding_version: number;
  serving_enabled: boolean;
  identities: ConfigIdentity[];
  policies: AgreementPolicy[];
}

export interface ResolveResult {
  eligible: boolean;
  agreement?: AgreementRecord;
  revision?: DocumentRevision;
  reason?: string;
}

export interface AgreementRecord extends Slot {
  agreement_id: string;
  proposal_id: string;
  revision_digest: string;
  policy_id: string;
  policy_version: number;
  membership_epoch: number;
  role_binding_version: number;
  approval_decision_ids: string[];
  status: "active" | "superseded" | "withdrawn" | "suspended";
  activated_by: Actor;
  activated_at: string;
  status_reason?: string;
  status_changed_by?: Actor;
  status_changed_at?: string;
}

export interface AgreementProposalRecord extends Slot {
  record_type: "AgreementProposal";
  proposal_id: string;
  revision_digest: string;
  policy_id: string;
  policy_version: number;
  membership_epoch: number;
  role_binding_version: number;
  config_version: ConfigVersion;
  status: "open" | "activated";
  created_by: Actor;
  created_at: string;
  review_counter: number;
  agreement_id?: string;
}

export interface DomainErrorOptions {
  status?: number;
  retryable?: boolean;
  details?: unknown;
}

export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(code: string, message: string, options: DomainErrorOptions = {}) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = options.status ?? 400;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** Model adapter identifier contract shared by the server egress gate and the knowledge client. */
export const MODEL_ADAPTER_ID = /^[A-Za-z][A-Za-z0-9._:-]{2,127}$/u;

/** Manifest binding fields compared on revalidation — server and knowledge client must share this exact list. */
export const MANIFEST_BINDING_FIELDS = ['policy_id', 'policy_version', 'membership_epoch', 'model_egress_policy_version', 'retrieval_profile_id'] as const;

export const KEY_PREFIXES = Object.freeze({
  config: "kcl:v1:config",
  revision: "kcl:v1:revision",
  revision_id: "kcl:v1:revision_id",
  policy: "kcl:v1:policy",
  proposal: "kcl:v1:proposal",
  decision: "kcl:v1:decision",
  latest_decision: "kcl:v1:latest_decision",
  review_counter: "kcl:v1:review_counter",
  agreement: "kcl:v1:agreement",
  active_slot: "kcl:v1:active_slot",
  eligibility_epoch: "kcl:v1:eligibility_epoch",
  idempotency: "kcl:v1:idempotency",
  fence: "kcl:v1:fence",
} as const);

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export function stateKey(prefix: keyof typeof KEY_PREFIXES, ...parts: string[]): string {
  const base = KEY_PREFIXES[prefix];
  return parts.length === 0 ? base : `${base}:${parts.map(encoded).join(":")}`;
}

export const keyFor = Object.freeze({
  config: (): string => stateKey("config"),
  revision: (digest: string): string => stateKey("revision", digest),
  revisionId: (revisionId: string): string => stateKey("revision_id", revisionId),
  policy: (policyId: string, policyVersion: number): string => stateKey("policy", policyId, String(policyVersion)),
  proposal: (proposalId: string): string => stateKey("proposal", proposalId),
  decision: (decisionId: string): string => stateKey("decision", decisionId),
  latestDecision: (proposalId: string, policyVersion: number, role: string, orgId: string, actorId: string): string =>
    stateKey("latest_decision", proposalId, String(policyVersion), role, orgId, actorId),
  reviewCounter: (proposalId: string): string => stateKey("review_counter", proposalId),
  agreement: (agreementId: string): string => stateKey("agreement", agreementId),
  activeSlot: (slot: Slot): string => stateKey("active_slot", slotKey(slot)),
  eligibilityEpoch: (): string => stateKey("eligibility_epoch"),
  idempotency: (orgId: string, commandId: string): string => stateKey("idempotency", orgId, commandId),
  fence: (nonce: string): string => stateKey("fence", nonce),
});

/** Stable complete acceptance slot key.  The chosen separator is excluded by v1 ids. */
export function slotKey(slot: Slot): string {
  assertSlotShape(slot);
  return [slot.channel_id, slot.document_id, slot.context_id, slot.scope_id, slot.usage_scope].join("|");
}

const ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/u;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const USAGE_SCOPE_RE = /^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/u;
const RELATIONSHIP_RE = /^[a-z][a-z0-9_:-]{2,63}$/u;

function fail(code: string, message: string, options: DomainErrorOptions = {}): never {
  throw new DomainError(code, message, options);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail("INVALID_INPUT", `${label} must be a plain object`);
  }
}

function assertKeys(value: Record<string, unknown>, required: string[], optional: string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("INVALID_INPUT", `${label} has unknown property ${key}`);
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail("INVALID_INPUT", `${label}.${key} is required`);
  }
}

function assertId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID_RE.test(value)) fail("INVALID_INPUT", `${label} is not a valid Knowledger id`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST_RE.test(value)) fail("INVALID_INPUT", `${label} is not a sha256 digest`);
}

function assertUsageScope(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !USAGE_SCOPE_RE.test(value)) fail("INVALID_INPUT", `${label} is not a versioned usage scope`);
}

function assertNonEmptyString(value: unknown, label: string, maxLength = 1000): asserts value is string {
  if (typeof value !== "string") {
    fail("INVALID_INPUT", `${label} must be a non-empty string of at most ${maxLength} characters`);
  }
  assertValidUnicode(value, label);
  if (Array.from(value).length < 1 || Array.from(value).length > maxLength) {
    fail("INVALID_INPUT", `${label} must be a non-empty string of at most ${maxLength} characters`);
  }
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    fail("INVALID_INPUT", `${label} must be a safe integer >= ${minimum}`);
  }
}

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) fail("INVALID_INPUT", `${label} contains an unpaired surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      fail("INVALID_INPUT", `${label} contains an unpaired surrogate`);
    }
  }
}

function assertSlotShape(value: unknown): asserts value is Slot {
  assertRecord(value, "slot");
  for (const field of ["channel_id", "document_id", "context_id", "scope_id"] as const) assertId(value[field], `slot.${field}`);
  assertUsageScope(value.usage_scope, "slot.usage_scope");
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalize(value)) as T;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) && !Number.isSafeInteger(Math.trunc(value))) {
    // RFC 8785 permits non-integer IEEE-754 values, but all values used by
    // Knowledger must be exactly representable and finite.  The second clause keeps
    // ordinary fractional IEEE-754 values while rejecting unsafe integer-like
    // values such as 9007199254740992.
    if (!Number.isFinite(value)) fail("INVALID_INPUT", "non-finite numbers are not valid JSON");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) fail("INVALID_INPUT", "unsafe integer is not canonical JSON");
  }
  if (Object.is(value, -0)) return "0";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) fail("INVALID_INPUT", "unsupported number");
  return serialized;
}

const MAX_CANONICAL_DEPTH = 128;
const MAX_CANONICAL_ARRAY_ITEMS = 65536;

interface CanonicalState {
  stack: Set<object>;
}

function assertDataDescriptor(value: object, property: string, allowNonEnumerable = false): void {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (!descriptor || !("value" in descriptor) || (!allowNonEnumerable && descriptor.enumerable !== true)) {
    fail("INVALID_INPUT", "accessor and non-enumerable properties are not canonicalizable");
  }
}

/**
 * RFC 8785 JSON Canonicalization Scheme for the JSON subset accepted by Knowledger.
 * Node's JSON number serializer is ECMAScript-compatible with JCS; sorting
 * object keys with the default JS comparator gives UTF-16 code-unit order.
 * Cycles, accessors, custom properties, and excessive nesting are rejected
 * before recursion can escape the bounded protocol input.
 */
function canonicalizeValue(value: unknown, state: CanonicalState, depth: number): string {
  if (depth > MAX_CANONICAL_DEPTH) fail("CANONICALIZATION_LIMIT", "canonical JSON nesting exceeds the supported limit");
  if (value === null) return "null";
  if (typeof value === "string") {
    assertValidUnicode(value, "string");
    return JSON.stringify(value);
  }
  if (typeof value === "number") return canonicalNumber(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol" || value === undefined) {
    fail("INVALID_INPUT", "only JSON values are canonicalizable");
  }
  if (typeof value !== "object") fail("INVALID_INPUT", "only JSON values are canonicalizable");
  if (state.stack.has(value)) fail("INVALID_INPUT", "cyclic values are not canonicalizable");
  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_CANONICAL_ARRAY_ITEMS) fail("CANONICALIZATION_LIMIT", "canonical JSON array exceeds the supported limit");
      if (Object.getOwnPropertySymbols(value).length > 0) fail("INVALID_INPUT", "symbol keys are not canonicalizable");
      const own = Object.getOwnPropertyNames(value);
      for (const property of own) {
        if (property === "length") {
          assertDataDescriptor(value, property, true);
        } else {
          if (!/^(?:0|[1-9][0-9]*)$/u.test(property)) fail("INVALID_INPUT", "array has unsupported properties");
          assertDataDescriptor(value, property);
        }
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail("INVALID_INPUT", "sparse arrays are not canonicalizable");
        items.push(canonicalizeValue(value[index], state, depth + 1));
      }
      return `[${items.join(",")}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) fail("INVALID_INPUT", "only plain JSON objects are canonicalizable");
    if (Object.getOwnPropertySymbols(value).length > 0) fail("INVALID_INPUT", "symbol keys are not canonicalizable");
    const keys = Object.getOwnPropertyNames(value).sort();
    for (const key of keys) assertDataDescriptor(value, key);
    const fields = keys.map((key) => {
      assertValidUnicode(key, "object key");
      return `${JSON.stringify(key)}:${canonicalizeValue((value as Record<string, unknown>)[key], state, depth + 1)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    state.stack.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return canonicalizeValue(value, { stack: new Set<object>() }, 0);
}

export function digestPayload(payload: DocumentRevisionPayload): string {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalize(payload), "utf8")).digest("hex")}`;
}

function assertContext(ctx: TxContext): void {
  assertRecord(ctx.actor, "actor");
  assertKeys(ctx.actor, ["org_id", "actor_id", "kind"], [], "actor");
  assertId(ctx.actor.org_id, "actor.org_id");
  assertId(ctx.actor.actor_id, "actor.actor_id");
  if (ctx.actor.kind !== "human" && ctx.actor.kind !== "agent") fail("INVALID_INPUT", "actor.kind is invalid");
  assertId(ctx.channel_id, "channel_id");
  assertNonEmptyString(ctx.tx_id, "tx_id", 200);
  assertNonEmptyString(ctx.timestamp, "timestamp", 80);
}

function assertVersion(value: unknown, label: string): asserts value is ConfigVersion {
  if (typeof value === "number") {
    assertSafeInteger(value, label, 1);
    return;
  }
  assertId(value, label);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left) === canonicalize(right);
  } catch {
    return false;
  }
}

function sameActor(left: Actor, right: Actor): boolean {
  return left.org_id === right.org_id && left.actor_id === right.actor_id && left.kind === right.kind;
}

function sameSlot(left: Slot, right: Slot): boolean {
  return slotKey(left) === slotKey(right);
}

function slotFields(value: Slot): Slot {
  return {
    channel_id: value.channel_id,
    document_id: value.document_id,
    context_id: value.context_id,
    scope_id: value.scope_id,
    usage_scope: value.usage_scope,
  };
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail("INVALID_INPUT", `${label} must be an array`);
}

function assertUniqueCanonical(values: unknown[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = canonicalize(value);
    if (seen.has(key)) fail("INVALID_INPUT", `${label} contains duplicates`);
    seen.add(key);
  }
}

function assertNoAgreementId(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAgreementId(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, "agreement_id")) fail("INVALID_INPUT", `${path}.agreement_id is forbidden in immutable revisions`);
  for (const [key, entry] of Object.entries(value)) assertNoAgreementId(entry, `${path}.${key}`);
}

function validateDependency(value: unknown, index: number, channelId: string): RevisionDependency {
  assertRecord(value, `dependencies[${index}]`);
  assertKeys(value, ["revision_digest", "context_id", "usage_scope", "relationship", "enforcement", "document_id", "scope_id", "channel_id"], [], `dependencies[${index}]`);
  assertDigest(value.revision_digest, `dependencies[${index}].revision_digest`);
  assertId(value.context_id, `dependencies[${index}].context_id`);
  assertUsageScope(value.usage_scope, `dependencies[${index}].usage_scope`);
  if (typeof value.relationship !== "string" || !RELATIONSHIP_RE.test(value.relationship)) fail("INVALID_INPUT", `dependencies[${index}].relationship is invalid`);
  if (value.enforcement !== "requires_active" && value.enforcement !== "informational") fail("INVALID_INPUT", `dependencies[${index}].enforcement is invalid`);
  assertId(value.document_id, `dependencies[${index}].document_id`);
  assertId(value.scope_id, `dependencies[${index}].scope_id`);
  if (value.channel_id !== channelId) fail("INVALID_INPUT", `dependencies[${index}].channel_id must match the revision channel`);
  canonicalize(value);
  const dependency: RevisionDependency = {
    revision_digest: value.revision_digest,
    context_id: value.context_id,
    usage_scope: value.usage_scope,
    relationship: value.relationship,
    enforcement: value.enforcement,
    document_id: value.document_id,
    scope_id: value.scope_id,
    channel_id: value.channel_id,
  };
  return cloneCanonical(dependency);
}

export function validateRevision(revision: unknown): DocumentRevision {
  assertRecord(revision, "revision");
  assertKeys(revision, ["revision_digest", "payload"], [], "revision");
  assertDigest(revision.revision_digest, "revision.revision_digest");
  assertRecord(revision.payload, "revision.payload");
  const payload = revision.payload;
  assertKeys(payload, ["contract_type", "contract_version", "revision_id", "document_id", "context_id", "scope_id", "usage_scope", "channel_id", "visibility", "title", "body_markdown", "parents", "dependencies", "metadata"], [], "revision.payload");
  if (payload.contract_type !== "DocumentRevision" || payload.contract_version !== 1) fail("INVALID_INPUT", "revision payload contract is invalid");
  assertId(payload.revision_id, "revision.payload.revision_id");
  assertId(payload.document_id, "revision.payload.document_id");
  assertId(payload.context_id, "revision.payload.context_id");
  assertId(payload.scope_id, "revision.payload.scope_id");
  assertUsageScope(payload.usage_scope, "revision.payload.usage_scope");
  assertId(payload.channel_id, "revision.payload.channel_id");
  if (payload.visibility !== "shared_channel") fail("INVALID_INPUT", "revision visibility must be shared_channel");
  assertNonEmptyString(payload.title, "revision.payload.title", 200);
  assertNonEmptyString(payload.body_markdown, "revision.payload.body_markdown", 262144);
  if (Buffer.byteLength(payload.body_markdown, "utf8") > 262144) fail("INVALID_INPUT", "revision body exceeds 256 KiB UTF-8 limit");
  assertArray(payload.parents, "revision.payload.parents");
  if (payload.parents.length > 2) fail("INVALID_INPUT", "at most two parents are allowed");
  const parents = payload.parents.map((parent, index): string => {
    assertDigest(parent, `revision.payload.parents[${index}]`);
    return parent;
  });
  assertUniqueCanonical(parents, "revision.payload.parents");
  assertArray(payload.dependencies, "revision.payload.dependencies");
  if (payload.dependencies.length > 32) fail("INVALID_INPUT", "at most 32 dependencies are allowed");
  const channelId = payload.channel_id;
  const dependencies = payload.dependencies.map((dependency, index) => validateDependency(dependency, index, channelId));
  assertUniqueCanonical(dependencies, "revision.payload.dependencies");
  assertRecord(payload.metadata, "revision.payload.metadata");
  assertKeys(payload.metadata, ["author_id", "created_at", "source_kind", "shared_assertions", "author_org_id"], [], "revision.payload.metadata");
  assertId(payload.metadata.author_id, "revision.payload.metadata.author_id");
  assertNonEmptyString(payload.metadata.created_at, "revision.payload.metadata.created_at", 80);
  if (!["human_authored", "approved_import", "llm_drafted"].includes(payload.metadata.source_kind as string)) fail("INVALID_INPUT", "revision source_kind is invalid");
  assertArray(payload.metadata.shared_assertions, "revision.payload.metadata.shared_assertions");
  const assertions = payload.metadata.shared_assertions.map((entry, index): SharedAssertion => {
    assertRecord(entry, `shared_assertions[${index}]`);
    assertKeys(entry, ["assertion_id", "statement", "source_visibility"], [], `shared_assertions[${index}]`);
    assertId(entry.assertion_id, `shared_assertions[${index}].assertion_id`);
    assertNonEmptyString(entry.statement, `shared_assertions[${index}].statement`, 300);
    if (entry.source_visibility !== "private_shared_assertion") fail("INVALID_INPUT", `shared_assertions[${index}].source_visibility is invalid`);
    canonicalize(entry);
    const assertion: SharedAssertion = {
      assertion_id: entry.assertion_id,
      statement: entry.statement,
      source_visibility: "private_shared_assertion",
    };
    return cloneCanonical(assertion);
  });
  assertUniqueCanonical(assertions, "revision.payload.metadata.shared_assertions");
  assertId(payload.metadata.author_org_id, "revision.payload.metadata.author_org_id");
  assertNoAgreementId(payload);
  const normalizedPayload: DocumentRevisionPayload = {
    contract_type: "DocumentRevision",
    contract_version: 1,
    revision_id: payload.revision_id,
    document_id: payload.document_id,
    context_id: payload.context_id,
    scope_id: payload.scope_id,
    usage_scope: payload.usage_scope,
    channel_id: payload.channel_id,
    visibility: "shared_channel",
    title: payload.title,
    body_markdown: payload.body_markdown,
    parents,
    dependencies,
    metadata: {
      author_id: payload.metadata.author_id,
      created_at: payload.metadata.created_at,
      source_kind: payload.metadata.source_kind as DocumentRevisionPayload["metadata"]["source_kind"],
      shared_assertions: assertions,
      author_org_id: payload.metadata.author_org_id,
    },
  };
  const canonicalPayload = canonicalize(normalizedPayload);
  if (Buffer.byteLength(canonicalPayload, "utf8") > 524288) fail("INVALID_INPUT", "canonical revision payload exceeds 512 KiB limit");
  const expectedDigest = digestPayload(normalizedPayload);
  if (revision.revision_digest !== expectedDigest) fail("DIGEST_MISMATCH", "revision_digest does not match the canonical payload", { status: 400 });
  return { revision_digest: revision.revision_digest, payload: normalizedPayload };
}

export function validatePolicy(value: unknown): AgreementPolicy {
  assertRecord(value, "policy");
  assertKeys(value, ["contract_type", "contract_version", "policy_id", "policy_version", "document_id", "context_id", "scope_id", "usage_scope", "channel_id", "membership_epoch", "role_binding_version", "acceptance_slot", "required_domain_roles", "allowed_decisions", "role_decision_rule", "role_representatives"], [], "policy");
  if (value.contract_type !== "AgreementPolicy" || value.contract_version !== 1) fail("INVALID_INPUT", "policy contract is invalid");
  assertId(value.policy_id, "policy.policy_id");
  assertSafeInteger(value.policy_version, "policy.policy_version", 1);
  assertId(value.document_id, "policy.document_id");
  assertId(value.context_id, "policy.context_id");
  assertId(value.scope_id, "policy.scope_id");
  assertUsageScope(value.usage_scope, "policy.usage_scope");
  assertId(value.channel_id, "policy.channel_id");
  assertSafeInteger(value.membership_epoch, "policy.membership_epoch", 1);
  assertSafeInteger(value.role_binding_version, "policy.role_binding_version", 1);
  assertId(value.acceptance_slot, "policy.acceptance_slot");
  assertArray(value.required_domain_roles, "policy.required_domain_roles");
  if (value.required_domain_roles.length < 1 || value.required_domain_roles.length > 32) fail("INVALID_INPUT", "policy must require one to 32 roles");
  value.required_domain_roles.forEach((role, index) => assertId(role, `policy.required_domain_roles[${index}]`));
  assertUniqueCanonical(value.required_domain_roles, "policy.required_domain_roles");
  assertArray(value.allowed_decisions, "policy.allowed_decisions");
  if (value.allowed_decisions.length < 1) fail("INVALID_INPUT", "policy.allowed_decisions cannot be empty");
  value.allowed_decisions.forEach((decision, index) => assertId(decision, `policy.allowed_decisions[${index}]`));
  assertUniqueCanonical(value.allowed_decisions, "policy.allowed_decisions");
  if (value.role_decision_rule !== "named_representatives") fail("INVALID_INPUT", "only named_representatives is supported in v1");
  assertArray(value.role_representatives, "policy.role_representatives");
  if (value.role_representatives.length !== value.required_domain_roles.length) fail("INVALID_INPUT", "policy must have exactly one representative per required role");
  const roles = new Set<string>();
  const representatives = new Set<string>();
  const normalizedRepresentatives: RoleRepresentative[] = [];
  for (const [index, representative] of value.role_representatives.entries()) {
    assertRecord(representative, `policy.role_representatives[${index}]`);
    assertKeys(representative, ["domain_role", "actor_org_id", "actor_id"], [], `policy.role_representatives[${index}]`);
    assertId(representative.domain_role, `policy.role_representatives[${index}].domain_role`);
    assertId(representative.actor_org_id, `policy.role_representatives[${index}].actor_org_id`);
    assertId(representative.actor_id, `policy.role_representatives[${index}].actor_id`);
    if (!value.required_domain_roles.includes(representative.domain_role)) fail("INVALID_INPUT", "policy representative role is not required");
    if (roles.has(representative.domain_role)) fail("INVALID_INPUT", "policy has duplicate role representatives");
    const repKey = `${representative.actor_org_id}|${representative.actor_id}`;
    if (representatives.has(repKey)) fail("INVALID_INPUT", "one actor cannot fill multiple required roles");
    roles.add(representative.domain_role);
    representatives.add(repKey);
    canonicalize(representative);
    const normalizedRepresentative: RoleRepresentative = {
      domain_role: representative.domain_role,
      actor_org_id: representative.actor_org_id,
      actor_id: representative.actor_id,
    };
    normalizedRepresentatives.push(cloneCanonical(normalizedRepresentative));
  }
  if (roles.size !== value.required_domain_roles.length) fail("INVALID_INPUT", "policy representative roles are incomplete");
  return {
    contract_type: "AgreementPolicy",
    contract_version: 1,
    policy_id: value.policy_id,
    policy_version: value.policy_version,
    document_id: value.document_id,
    context_id: value.context_id,
    scope_id: value.scope_id,
    usage_scope: value.usage_scope,
    channel_id: value.channel_id,
    membership_epoch: value.membership_epoch,
    role_binding_version: value.role_binding_version,
    acceptance_slot: value.acceptance_slot,
    required_domain_roles: [...value.required_domain_roles] as string[],
    allowed_decisions: [...value.allowed_decisions] as string[],
    role_decision_rule: "named_representatives",
    role_representatives: normalizedRepresentatives,
  };
}

export function validateConfig(value: unknown): DomainConfig {
  assertRecord(value, "config");
  assertKeys(value, ["config_version", "channel_id", "membership_epoch", "role_binding_version", "serving_enabled", "identities", "policies"], [], "config");
  assertVersion(value.config_version, "config.config_version");
  assertId(value.channel_id, "config.channel_id");
  assertSafeInteger(value.membership_epoch, "config.membership_epoch", 1);
  assertSafeInteger(value.role_binding_version, "config.role_binding_version", 1);
  if (typeof value.serving_enabled !== "boolean") fail("INVALID_INPUT", "config.serving_enabled must be boolean");
  assertArray(value.identities, "config.identities");
  if (value.identities.length < 1) fail("INVALID_INPUT", "config.identities cannot be empty");
  const identityKeys = new Set<string>();
  const identities: ConfigIdentity[] = [];
  for (const [index, entry] of value.identities.entries()) {
    assertRecord(entry, `config.identities[${index}]`);
    assertKeys(entry, ["org_id", "actor_id", "kind", "publish_contexts", "can_propose"], [], `config.identities[${index}]`);
    assertId(entry.org_id, `config.identities[${index}].org_id`);
    assertId(entry.actor_id, `config.identities[${index}].actor_id`);
    if (entry.kind !== "human" && entry.kind !== "agent") fail("INVALID_INPUT", `config.identities[${index}].kind is invalid`);
    assertArray(entry.publish_contexts, `config.identities[${index}].publish_contexts`);
    entry.publish_contexts.forEach((context, contextIndex) => {
      if (context !== "*") assertId(context, `config.identities[${index}].publish_contexts[${contextIndex}]`);
    });
    assertUniqueCanonical(entry.publish_contexts, `config.identities[${index}].publish_contexts`);
    if (typeof entry.can_propose !== "boolean") fail("INVALID_INPUT", `config.identities[${index}].can_propose must be boolean`);
    const identityKey = `${entry.org_id}|${entry.actor_id}`;
    if (identityKeys.has(identityKey)) fail("INVALID_INPUT", "config contains duplicate identities");
    identityKeys.add(identityKey);
    identities.push({ org_id: entry.org_id, actor_id: entry.actor_id, kind: entry.kind, publish_contexts: [...entry.publish_contexts] as string[], can_propose: entry.can_propose });
  }
  assertArray(value.policies, "config.policies");
  if (value.policies.length < 1) fail("INVALID_INPUT", "config.policies cannot be empty");
  const policyKeys = new Set<string>();
  const policyIds = new Set<string>();
  const policies: AgreementPolicy[] = [];
  for (const [index, entry] of value.policies.entries()) {
    const policy = validatePolicy(entry);
    if (policy.channel_id !== value.channel_id) fail("INVALID_INPUT", `config.policies[${index}] channel differs from config`);
    if (policy.membership_epoch !== value.membership_epoch) fail("INVALID_INPUT", `config.policies[${index}] membership epoch differs from config`);
    if (policy.role_binding_version !== value.role_binding_version) fail("INVALID_INPUT", `config.policies[${index}] role binding version differs from config`);
    const policyKey = `${policy.policy_id}|${policy.policy_version}`;
    if (policyKeys.has(policyKey)) fail("INVALID_INPUT", "config contains duplicate policy versions");
    policyKeys.add(policyKey);
    policyIds.add(policy.policy_id);
    for (const representative of policy.role_representatives) {
      const identity = identities.find((candidate) => candidate.org_id === representative.actor_org_id && candidate.actor_id === representative.actor_id);
      if (!identity || identity.kind !== "human") fail("INVALID_INPUT", "policy representative must be a configured human identity");
    }
    policies.push(policy);
  }
  return {
    config_version: value.config_version,
    channel_id: value.channel_id,
    membership_epoch: value.membership_epoch,
    role_binding_version: value.role_binding_version,
    serving_enabled: value.serving_enabled,
    identities,
    policies,
  };
}

function assertConfigVersionEqual(left: ConfigVersion, right: ConfigVersion, label: string): void {
  if (canonicalize(left) !== canonicalize(right)) fail("STALE_CONFIGURATION", `${label} does not match the current immutable config`, { status: 409 });
}

async function readConfig(ctx: TxContext): Promise<DomainConfig> {
  const value = await ctx.get(keyFor.config());
  if (value === undefined || value === null) fail("NOT_BOOTSTRAPPED", "channel configuration has not been bootstrapped", { status: 503, retryable: true });
  return validateConfig(value);
}

function configuredIdentity(config: DomainConfig, actor: Actor): ConfigIdentity {
  const identity = config.identities.find((candidate) => candidate.org_id === actor.org_id && candidate.actor_id === actor.actor_id && candidate.kind === actor.kind);
  if (!identity) fail("FORBIDDEN", "actor is not a member of the configured application entitlement", { status: 403 });
  return identity;
}

function requireHuman(ctx: TxContext, config: DomainConfig): ConfigIdentity {
  if (ctx.actor.kind !== "human") fail("FORBIDDEN", "this command requires a human actor", { status: 403 });
  return configuredIdentity(config, ctx.actor);
}

function validateCommand(command: DomainCommand): void {
  assertRecord(command, "command");
  assertKeys(command, ["command_id", "type", "input"], [], "command");
  assertId(command.command_id, "command.command_id");
  assertNonEmptyString(command.type, "command.type", 80);
  assertRecord(command.input, "command.input");
}

export function idempotencyDigest(command: Pick<DomainCommand, "type" | "input">): string {
  return `sha256:${createHash("sha256").update(Buffer.from(canonicalize({ type: command.type, input: command.input }), "utf8")).digest("hex")}`;
}

interface IdempotencyRecord {
  record_type: "IdempotencyRecord";
  command_id: string;
  command_type: string;
  command_digest: string;
  actor: Actor;
  result: unknown;
  tx_id: string;
}

function cloneActor(actor: Actor): Actor {
  return { org_id: actor.org_id, actor_id: actor.actor_id, kind: actor.kind };
}

function validatePublication(input: Record<string, unknown>): { revision: DocumentRevision; publication: { revision_digest: string; config_version: ConfigVersion; membership_epoch: number } } {
  assertKeys(input, ["revision", "publication"], [], "publish_revision input");
  const revision = validateRevision(input.revision);
  assertRecord(input.publication, "publish_revision.publication");
  assertKeys(input.publication, ["revision_digest", "config_version", "membership_epoch"], [], "publish_revision.publication");
  assertDigest(input.publication.revision_digest, "publication.revision_digest");
  assertVersion(input.publication.config_version, "publication.config_version");
  assertSafeInteger(input.publication.membership_epoch, "publication.membership_epoch", 1);
  if (input.publication.revision_digest !== revision.revision_digest) fail("INVALID_INPUT", "publication digest does not match revision");
  return { revision, publication: { revision_digest: input.publication.revision_digest, config_version: input.publication.config_version, membership_epoch: input.publication.membership_epoch } };
}

async function readRevisionById(ctx: TxContext, revisionId: string): Promise<DocumentRevision | undefined> {
  const pointerValue = await ctx.get(keyFor.revisionId(revisionId));
  if (pointerValue === undefined || pointerValue === null) return undefined;
  if (isRecord(pointerValue) && Object.keys(pointerValue).length === 1 && typeof pointerValue.revision_digest === "string") {
    assertKeys(pointerValue, ["revision_digest"], [], "revision id pointer");
    assertDigest(pointerValue.revision_digest, "revision id pointer.revision_digest");
    const revisionValue = await ctx.get(keyFor.revision(pointerValue.revision_digest));
    if (revisionValue === undefined || revisionValue === null) fail("CORRUPT_STATE", "revision id pointer targets a missing revision", { status: 500, retryable: true });
    return validateRevision(revisionValue);
  }
  // Read compatibility for the pre-pointer local prototype. New writes below
  // always use the compact pointer shape so full Markdown is stored once.
  return validateRevision(pointerValue);
}

async function validatePublishedDependencyGraph(ctx: TxContext, root: DocumentRevision): Promise<void> {
  const seen = new Set<string>();
  const path = new Set<string>();
  async function walk(current: DocumentRevision, depth: number): Promise<void> {
    if (depth > 8) fail("DEPENDENCY_LIMIT", "dependency graph exceeds depth eight", { status: 409 });
    if (path.has(current.revision_digest)) fail("DEPENDENCY_CYCLE", "dependency graph contains a cycle", { status: 409 });
    if (seen.has(current.revision_digest)) return;
    seen.add(current.revision_digest);
    if (seen.size > 256) fail("DEPENDENCY_LIMIT", "dependency graph exceeds 256 distinct revisions", { status: 409 });
    path.add(current.revision_digest);
    for (const dependency of current.payload.dependencies) {
      const targetValue = await ctx.get(keyFor.revision(dependency.revision_digest));
      if (targetValue === undefined || targetValue === null) fail("DEPENDENCY_NOT_FOUND", "every dependency revision must already be published", { status: 409, details: { dependency_digest: dependency.revision_digest } });
      const target = validateRevision(targetValue);
      if (target.revision_digest !== dependency.revision_digest || !sameSlot(target.payload, dependency)) fail("DEPENDENCY_SCOPE_MISMATCH", "dependency reference must bind the target revision's full slot", { status: 409, details: { dependency_digest: dependency.revision_digest } });
      await walk(target, depth + 1);
    }
    path.delete(current.revision_digest);
  }
  await walk(root, 0);
}

async function executePublish(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>): Promise<unknown> {
  const identity = configuredIdentity(config, ctx.actor);
  const { revision, publication } = validatePublication(input);
  if (ctx.channel_id !== config.channel_id || revision.payload.channel_id !== config.channel_id) fail("SCOPE_MISMATCH", "revision channel does not match transaction channel", { status: 409 });
  if (!identity.publish_contexts.includes("*") && !identity.publish_contexts.includes(revision.payload.context_id)) fail("FORBIDDEN", "actor cannot publish in this bounded context", { status: 403 });
  if (!config.serving_enabled) fail("SERVING_FROZEN", "publication is frozen while serving is disabled", { status: 409 });
  assertConfigVersionEqual(publication.config_version, config.config_version, "publication.config_version");
  if (publication.membership_epoch !== config.membership_epoch) fail("STALE_CONFIGURATION", "publication membership epoch is stale", { status: 409 });
  const existing = await ctx.get(keyFor.revision(revision.revision_digest));
  if (existing !== undefined && existing !== null) {
    const existingRevision = validateRevision(existing);
    if (!sameJson(existingRevision, revision)) fail("IMMUTABLE_CONFLICT", "revision digest already stores different content", { status: 409 });
    return { status: "already_published", revision_digest: revision.revision_digest, slot: slotKey(revision.payload) };
  }
  const existingRevision = await readRevisionById(ctx, revision.payload.revision_id);
  if (existingRevision !== undefined) {
    if (existingRevision.revision_digest !== revision.revision_digest) fail("IMMUTABLE_CONFLICT", "revision_id cannot be reused for another digest", { status: 409 });
    return { status: "already_published", revision_digest: revision.revision_digest, slot: slotKey(revision.payload) };
  }
  for (const parentDigest of revision.payload.parents) {
    const parentValue = await ctx.get(keyFor.revision(parentDigest));
    if (parentValue === undefined || parentValue === null) fail("PARENT_NOT_FOUND", "every parent revision must already be published", { status: 409, details: { parent_digest: parentDigest } });
    const parent = validateRevision(parentValue);
    if (!sameSlot(parent.payload, revision.payload)) fail("SCOPE_MISMATCH", "revision parents must use the same full slot", { status: 409 });
  }
  await validatePublishedDependencyGraph(ctx, revision);
  const stored = cloneCanonical(revision);
  await ctx.put(keyFor.revision(revision.revision_digest), stored);
  await ctx.put(keyFor.revisionId(revision.payload.revision_id), { revision_digest: revision.revision_digest });
  return { status: "published", revision_digest: revision.revision_digest, slot: slotKey(revision.payload) };
}

function policyFor(config: DomainConfig, policyId: string, policyVersion: number): AgreementPolicy {
  const policy = config.policies.find((candidate) => candidate.policy_id === policyId && candidate.policy_version === policyVersion);
  if (!policy) fail("POLICY_NOT_FOUND", "policy is not present in the immutable channel config", { status: 404 });
  return policy;
}

function assertPolicyMatchesRevision(policy: AgreementPolicy, revision: DocumentRevision): void {
  if (!sameSlot(policy, revision.payload)) fail("SCOPE_MISMATCH", "policy and revision must use the same full slot", { status: 409 });
}

async function executePropose(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>): Promise<unknown> {
  const identity = configuredIdentity(config, ctx.actor);
  assertKeys(input, ["proposal_id", "revision_digest", "policy_id", "policy_version"], [], "propose input");
  assertId(input.proposal_id, "proposal_id");
  assertDigest(input.revision_digest, "revision_digest");
  assertId(input.policy_id, "policy_id");
  assertSafeInteger(input.policy_version, "policy_version", 1);
  if (!identity.can_propose) fail("FORBIDDEN", "actor is not allowed to create proposals", { status: 403 });
  const revisionValue = await ctx.get(keyFor.revision(input.revision_digest));
  if (revisionValue === undefined || revisionValue === null) fail("REVISION_NOT_FOUND", "proposal revision is not published", { status: 404 });
  const revision = validateRevision(revisionValue);
  const policy = policyFor(config, input.policy_id, input.policy_version);
  assertPolicyMatchesRevision(policy, revision);
  const existingValue = await ctx.get(keyFor.proposal(input.proposal_id));
  if (existingValue !== undefined && existingValue !== null) {
    const existing = validateProposal(existingValue);
    if (existing.revision_digest === revision.revision_digest && existing.policy_id === policy.policy_id && existing.policy_version === policy.policy_version) {
      fail("PROPOSAL_REPLAY", "proposal_id has already been used", { status: 409 });
    }
    fail("IMMUTABLE_CONFLICT", "proposal_id cannot be reused", { status: 409 });
  }
  const proposal: AgreementProposalRecord = {
    record_type: "AgreementProposal",
    proposal_id: input.proposal_id,
    revision_digest: revision.revision_digest,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    membership_epoch: config.membership_epoch,
    role_binding_version: config.role_binding_version,
    config_version: config.config_version,
    status: "open",
    created_by: cloneActor(ctx.actor),
    created_at: ctx.timestamp,
    review_counter: 0,
    ...slotFields(revision.payload),
  };
  await ctx.put(keyFor.proposal(proposal.proposal_id), cloneCanonical(proposal));
  await ctx.put(keyFor.reviewCounter(proposal.proposal_id), 0);
  await ctx.put(keyFor.policy(policy.policy_id, policy.policy_version), cloneCanonical(policy));
  return { status: "proposed", proposal_id: proposal.proposal_id, revision_digest: revision.revision_digest, slot: slotKey(revision.payload) };
}

export function validateProposal(value: unknown): AgreementProposalRecord {
  assertRecord(value, "proposal record");
  const required = ["record_type", "proposal_id", "revision_digest", "policy_id", "policy_version", "membership_epoch", "role_binding_version", "config_version", "status", "created_by", "created_at", "review_counter", "channel_id", "document_id", "context_id", "scope_id", "usage_scope"];
  assertKeys(value, required, ["agreement_id"], "proposal record");
  if (value.record_type !== "AgreementProposal") fail("CORRUPT_STATE", "stored proposal has invalid record type", { status: 500, retryable: true });
  assertId(value.proposal_id, "proposal.proposal_id");
  assertDigest(value.revision_digest, "proposal.revision_digest");
  assertId(value.policy_id, "proposal.policy_id");
  assertSafeInteger(value.policy_version, "proposal.policy_version", 1);
  assertSafeInteger(value.membership_epoch, "proposal.membership_epoch", 1);
  assertSafeInteger(value.role_binding_version, "proposal.role_binding_version", 1);
  assertVersion(value.config_version, "proposal.config_version");
  if (value.status !== "open" && value.status !== "activated") fail("CORRUPT_STATE", "stored proposal has invalid status", { status: 500, retryable: true });
  assertRecord(value.created_by, "proposal.created_by");
  assertKeys(value.created_by, ["org_id", "actor_id", "kind"], [], "proposal.created_by");
  assertId(value.created_by.org_id, "proposal.created_by.org_id");
  assertId(value.created_by.actor_id, "proposal.created_by.actor_id");
  if (value.created_by.kind !== "human" && value.created_by.kind !== "agent") fail("CORRUPT_STATE", "stored proposal actor kind invalid", { status: 500, retryable: true });
  assertNonEmptyString(value.created_at, "proposal.created_at", 80);
  assertSafeInteger(value.review_counter, "proposal.review_counter", 0);
  if (value.agreement_id !== undefined) assertId(value.agreement_id, "proposal.agreement_id");
  assertSlotShape(value);
  canonicalize(value);
  const proposal: AgreementProposalRecord = {
    record_type: "AgreementProposal",
    proposal_id: value.proposal_id,
    revision_digest: value.revision_digest,
    policy_id: value.policy_id,
    policy_version: value.policy_version,
    membership_epoch: value.membership_epoch,
    role_binding_version: value.role_binding_version,
    config_version: value.config_version,
    status: value.status,
    created_by: {
      org_id: value.created_by.org_id,
      actor_id: value.created_by.actor_id,
      kind: value.created_by.kind,
    },
    created_at: value.created_at,
    review_counter: value.review_counter,
    ...slotFields(value),
  };
  if (value.agreement_id !== undefined) proposal.agreement_id = value.agreement_id;
  return cloneCanonical(proposal);
}

export function validateDecision(value: unknown): ApprovalDecision {
  assertRecord(value, "decision");
  assertKeys(value, ["contract_type", "contract_version", "decision_id", "revision_digest", "document_id", "context_id", "scope_id", "usage_scope", "channel_id", "policy_id", "policy_version", "membership_epoch", "role_binding_version", "actor_org_id", "actor_id", "subject_id", "actor_domain_role", "decision", "rationale", "decided_at", "proposal_id"], ["retracts_decision_id"], "decision");
  if (value.contract_type !== "ApprovalDecision" || value.contract_version !== 1) fail("INVALID_INPUT", "decision contract is invalid");
  assertId(value.decision_id, "decision.decision_id");
  assertDigest(value.revision_digest, "decision.revision_digest");
  const documentId = value.document_id;
  const contextId = value.context_id;
  const scopeId = value.scope_id;
  const channelId = value.channel_id;
  const policyId = value.policy_id;
  const actorOrgId = value.actor_org_id;
  const actorId = value.actor_id;
  const subjectId = value.subject_id;
  const actorDomainRole = value.actor_domain_role;
  const proposalId = value.proposal_id;
  assertId(documentId, "decision.document_id");
  assertId(contextId, "decision.context_id");
  assertId(scopeId, "decision.scope_id");
  assertId(channelId, "decision.channel_id");
  assertId(policyId, "decision.policy_id");
  assertId(actorOrgId, "decision.actor_org_id");
  assertId(actorId, "decision.actor_id");
  assertId(subjectId, "decision.subject_id");
  assertId(actorDomainRole, "decision.actor_domain_role");
  assertId(proposalId, "decision.proposal_id");
  assertUsageScope(value.usage_scope, "decision.usage_scope");
  assertSafeInteger(value.policy_version, "decision.policy_version", 1);
  assertSafeInteger(value.membership_epoch, "decision.membership_epoch", 1);
  assertSafeInteger(value.role_binding_version, "decision.role_binding_version", 1);
  const decisionKind = value.decision;
  if (decisionKind !== "approve" && decisionKind !== "object" && decisionKind !== "abstain" && decisionKind !== "retract") {
    fail("INVALID_INPUT", "decision.decision is invalid");
  }
  assertNonEmptyString(value.rationale, "decision.rationale", 1000);
  assertNonEmptyString(value.decided_at, "decision.decided_at", 80);
  if (decisionKind === "retract") {
    assertId(value.retracts_decision_id, "decision.retracts_decision_id");
  } else if (value.retracts_decision_id !== undefined) {
    fail("INVALID_INPUT", "retracts_decision_id is only valid for retract decisions");
  }
  assertSlotShape(value);
  canonicalize(value);
  const decision: ApprovalDecision = {
    contract_type: "ApprovalDecision",
    contract_version: 1,
    decision_id: value.decision_id,
    revision_digest: value.revision_digest,
    document_id: value.document_id,
    context_id: value.context_id,
    scope_id: value.scope_id,
    usage_scope: value.usage_scope,
    channel_id: value.channel_id,
    policy_id: policyId,
    policy_version: value.policy_version,
    membership_epoch: value.membership_epoch,
    role_binding_version: value.role_binding_version,
    actor_org_id: actorOrgId,
    actor_id: actorId,
    subject_id: subjectId,
    actor_domain_role: actorDomainRole,
    decision: decisionKind,
    rationale: value.rationale,
    decided_at: value.decided_at,
    proposal_id: proposalId,
  };
  if (value.retracts_decision_id !== undefined) decision.retracts_decision_id = value.retracts_decision_id;
  return cloneCanonical(decision);
}

function decisionLatestKey(decision: ApprovalDecision): string {
  return keyFor.latestDecision(decision.proposal_id, decision.policy_version, decision.actor_domain_role, decision.actor_org_id, decision.actor_id);
}

async function getLatestDecision(ctx: TxContext, decision: ApprovalDecision): Promise<ApprovalDecision | undefined> {
  const latestValue = await ctx.get(decisionLatestKey(decision));
  if (latestValue === undefined || latestValue === null) return undefined;
  assertRecord(latestValue, "latest decision reference");
  assertKeys(latestValue, ["decision_id"], [], "latest decision reference");
  assertId(latestValue.decision_id, "latest decision reference.decision_id");
  const value = await ctx.get(keyFor.decision(latestValue.decision_id));
  if (value === undefined || value === null) fail("CORRUPT_STATE", "latest decision points to a missing decision", { status: 500, retryable: true });
  return validateDecision(value);
}

async function incrementEpoch(ctx: TxContext): Promise<number> {
  const existing = await ctx.get(keyFor.eligibilityEpoch());
  if (existing === undefined || existing === null) {
    await ctx.put(keyFor.eligibilityEpoch(), 1);
    return 1;
  }
  assertSafeInteger(existing, "eligibility_epoch", 0);
  const next = existing + 1;
  if (!Number.isSafeInteger(next)) fail("STATE_LIMIT", "eligibility epoch exhausted", { status: 409 });
  await ctx.put(keyFor.eligibilityEpoch(), next);
  return next;
}

async function readReviewCounter(ctx: TxContext, proposal: AgreementProposalRecord): Promise<number> {
  const value = await ctx.get(keyFor.reviewCounter(proposal.proposal_id));
  if (value === undefined || value === null) return proposal.review_counter;
  assertSafeInteger(value, "proposal.review_counter", 0);
  if (value !== proposal.review_counter) fail("CORRUPT_STATE", "proposal and review counter records disagree", { status: 500, retryable: true });
  return value;
}

async function getActiveAgreement(ctx: TxContext, slot: Slot): Promise<AgreementRecord | undefined> {
  const pointer = await ctx.get(keyFor.activeSlot(slot));
  if (pointer === undefined || pointer === null) return undefined;
  let agreementId: string;
  if (typeof pointer === "string") agreementId = pointer;
  else {
    assertRecord(pointer, "active slot pointer");
    assertKeys(pointer, ["agreement_id"], [], "active slot pointer");
    if (pointer.agreement_id === null) return undefined;
    assertId(pointer.agreement_id, "active slot pointer.agreement_id");
    agreementId = pointer.agreement_id;
  }
  const value = await ctx.get(keyFor.agreement(agreementId));
  if (value === undefined || value === null) fail("CORRUPT_STATE", "active slot points to a missing agreement", { status: 500, retryable: true });
  const agreement = validateAgreement(value);
  if (!sameSlot(agreement, slot)) fail("CORRUPT_STATE", "active agreement slot does not match active slot key", { status: 500, retryable: true });
  return agreement;
}

export function validateAgreement(value: unknown): AgreementRecord {
  assertRecord(value, "agreement");
  assertKeys(value, ["agreement_id", "proposal_id", "revision_digest", "policy_id", "policy_version", "membership_epoch", "role_binding_version", "approval_decision_ids", "status", "activated_by", "activated_at", "channel_id", "document_id", "context_id", "scope_id", "usage_scope"], ["status_reason", "status_changed_by", "status_changed_at"], "agreement");
  assertId(value.agreement_id, "agreement.agreement_id");
  assertId(value.proposal_id, "agreement.proposal_id");
  assertDigest(value.revision_digest, "agreement.revision_digest");
  assertId(value.policy_id, "agreement.policy_id");
  assertSafeInteger(value.policy_version, "agreement.policy_version", 1);
  assertSafeInteger(value.membership_epoch, "agreement.membership_epoch", 1);
  assertSafeInteger(value.role_binding_version, "agreement.role_binding_version", 1);
  assertArray(value.approval_decision_ids, "agreement.approval_decision_ids");
  if (value.approval_decision_ids.length < 1 || value.approval_decision_ids.length > 32) fail("CORRUPT_STATE", "stored agreement approval manifest is invalid", { status: 500, retryable: true });
  const approvalDecisionIds = value.approval_decision_ids.map((decisionId, index): string => {
    assertId(decisionId, `agreement.approval_decision_ids[${index}]`);
    return decisionId;
  });
  assertUniqueCanonical(approvalDecisionIds, "agreement.approval_decision_ids");
  const agreementStatus = value.status;
  if (agreementStatus !== "active" && agreementStatus !== "superseded" && agreementStatus !== "withdrawn" && agreementStatus !== "suspended") {
    fail("CORRUPT_STATE", "stored agreement status invalid", { status: 500, retryable: true });
  }
  assertRecord(value.activated_by, "agreement.activated_by");
  assertKeys(value.activated_by, ["org_id", "actor_id", "kind"], [], "agreement.activated_by");
  assertId(value.activated_by.org_id, "agreement.activated_by.org_id");
  assertId(value.activated_by.actor_id, "agreement.activated_by.actor_id");
  const activatedByKind = value.activated_by.kind;
  if (activatedByKind !== "human" && activatedByKind !== "agent") fail("CORRUPT_STATE", "agreement actor kind invalid", { status: 500, retryable: true });
  assertNonEmptyString(value.activated_at, "agreement.activated_at", 80);
  if (value.status_reason !== undefined) assertNonEmptyString(value.status_reason, "agreement.status_reason", 1000);
  let normalizedStatusChangedBy: Actor | undefined;
  if (value.status_changed_by !== undefined) {
    assertRecord(value.status_changed_by, "agreement.status_changed_by");
    assertKeys(value.status_changed_by, ["org_id", "actor_id", "kind"], [], "agreement.status_changed_by");
    const statusChangedByOrgId = value.status_changed_by.org_id;
    const statusChangedByActorId = value.status_changed_by.actor_id;
    assertId(statusChangedByOrgId, "agreement.status_changed_by.org_id");
    assertId(statusChangedByActorId, "agreement.status_changed_by.actor_id");
    const statusChangedByKind = value.status_changed_by.kind;
    if (statusChangedByKind !== "human" && statusChangedByKind !== "agent") fail("CORRUPT_STATE", "agreement status actor kind invalid", { status: 500, retryable: true });
    normalizedStatusChangedBy = {
      org_id: statusChangedByOrgId,
      actor_id: statusChangedByActorId,
      kind: statusChangedByKind,
    };
  }
  if (value.status_changed_at !== undefined) assertNonEmptyString(value.status_changed_at, "agreement.status_changed_at", 80);
  assertSlotShape(value);
  canonicalize(value);
  const agreement: AgreementRecord = {
    agreement_id: value.agreement_id,
    proposal_id: value.proposal_id,
    revision_digest: value.revision_digest,
    policy_id: value.policy_id,
    policy_version: value.policy_version,
    membership_epoch: value.membership_epoch,
    role_binding_version: value.role_binding_version,
    approval_decision_ids: approvalDecisionIds,
    status: agreementStatus,
    activated_by: {
      org_id: value.activated_by.org_id,
      actor_id: value.activated_by.actor_id,
      kind: activatedByKind,
    },
    activated_at: value.activated_at,
    ...slotFields(value),
  };
  if (value.status_reason !== undefined) agreement.status_reason = value.status_reason;
  if (normalizedStatusChangedBy !== undefined) agreement.status_changed_by = normalizedStatusChangedBy;
  if (value.status_changed_at !== undefined) agreement.status_changed_at = value.status_changed_at;
  return cloneCanonical(agreement);
}

function corruptApprovalState(message: string): never {
  fail("CORRUPT_STATE", message, { status: 500, retryable: true });
}

/**
 * Validate the immutable approval manifest attached to an agreement against
 * the current immutable policy and the decision records it names.  This is
 * intentionally separate from activation's latest-decision read: activation
 * selects the latest decision for each representative, while this helper
 * proves that an already committed agreement still cites exactly one valid
 * approval from every required representative.
 */
export async function validateAgreementApprovals(
  get: (key: string) => Promise<unknown | undefined>,
  agreementInput: AgreementRecord,
): Promise<ApprovalDecision[]> {
  let agreement: AgreementRecord;
  let config: DomainConfig;
  try {
    agreement = validateAgreement(agreementInput);
    const configValue = await get(keyFor.config());
    if (configValue === undefined || configValue === null) corruptApprovalState("agreement approval validation has no channel config");
    config = validateConfig(configValue);
  } catch (error) {
    if (error instanceof DomainError && error.code === "CORRUPT_STATE") throw error;
    corruptApprovalState("agreement approval manifest or channel config is malformed");
  }
  if (agreement.membership_epoch !== config.membership_epoch || agreement.role_binding_version !== config.role_binding_version) corruptApprovalState("agreement approval manifest uses a stale entitlement epoch");
  const policy = config.policies.find((candidate) => candidate.policy_id === agreement.policy_id && candidate.policy_version === agreement.policy_version);
  if (!policy || !sameSlot(policy, agreement)) corruptApprovalState("agreement approval manifest does not match its immutable policy and slot");
  if (agreement.approval_decision_ids.length !== policy.required_domain_roles.length) corruptApprovalState("agreement approval manifest does not contain exactly one decision per required role");
  const selected = new Set<string>();
  const decisions: ApprovalDecision[] = [];
  for (const role of policy.required_domain_roles) {
    const representative = policy.role_representatives.find((candidate) => candidate.domain_role === role);
    if (!representative) corruptApprovalState(`agreement policy has no representative for ${role}`);
    let found: ApprovalDecision | undefined;
    for (const candidateId of agreement.approval_decision_ids) {
      if (selected.has(candidateId)) continue;
      const value = await get(keyFor.decision(candidateId));
      if (value === undefined || value === null) corruptApprovalState("agreement approval manifest points to a missing decision");
      let decision: ApprovalDecision;
      try {
        decision = validateDecision(value);
      } catch {
        corruptApprovalState("agreement approval manifest points to a malformed decision");
      }
      if (decision.decision !== "approve") corruptApprovalState("agreement approval manifest points to a non-approval decision");
      if (decision.actor_domain_role === role && decision.actor_org_id === representative.actor_org_id && decision.actor_id === representative.actor_id) {
        found = decision;
        selected.add(candidateId);
        break;
      }
    }
    if (!found) corruptApprovalState(`agreement approval manifest has no approval from required role ${role}`);
    if (found.revision_digest !== agreement.revision_digest || found.proposal_id !== agreement.proposal_id || !sameSlot(found, agreement) || found.policy_id !== agreement.policy_id || found.policy_version !== agreement.policy_version || found.membership_epoch !== agreement.membership_epoch || found.role_binding_version !== agreement.role_binding_version) corruptApprovalState(`agreement approval for ${role} is bound to a different immutable target`);
    decisions.push(found);
  }
  if (selected.size !== agreement.approval_decision_ids.length) corruptApprovalState("agreement approval manifest contains an approval for an unrequired representative");
  return decisions;
}

async function suspendActiveAgreement(ctx: TxContext, slot: Slot, reason: string, expectedProposalId?: string): Promise<AgreementRecord | undefined> {
  const active = await getActiveAgreement(ctx, slot);
  if (!active || active.status !== "active") return undefined;
  if (expectedProposalId !== undefined && active.proposal_id !== expectedProposalId) return undefined;
  const suspended: AgreementRecord = {
    ...active,
    status: "suspended",
    status_reason: reason,
    status_changed_by: cloneActor(ctx.actor),
    status_changed_at: ctx.timestamp,
  };
  await ctx.put(keyFor.agreement(active.agreement_id), cloneCanonical(suspended));
  await ctx.put(keyFor.activeSlot(slot), { agreement_id: null });
  await incrementEpoch(ctx);
  return suspended;
}

async function executeDecide(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>): Promise<unknown> {
  requireHuman(ctx, config);
  assertKeys(input, ["decision"], [], "decide input");
  const decision = validateDecision(input.decision);
  const proposalValue = await ctx.get(keyFor.proposal(decision.proposal_id));
  if (proposalValue === undefined || proposalValue === null) fail("PROPOSAL_NOT_FOUND", "decision proposal does not exist", { status: 404 });
  const proposal = validateProposal(proposalValue);
  const revisionValue = await ctx.get(keyFor.revision(decision.revision_digest));
  if (revisionValue === undefined || revisionValue === null) fail("REVISION_NOT_FOUND", "decision revision does not exist", { status: 404 });
  const revision = validateRevision(revisionValue);
  if (proposal.revision_digest !== decision.revision_digest || !sameSlot(proposal, decision) || !sameSlot(revision.payload, decision)) fail("STALE_DECISION", "decision does not bind the exact proposal revision and slot", { status: 409 });
  if (proposal.policy_id !== decision.policy_id || proposal.policy_version !== decision.policy_version || proposal.membership_epoch !== decision.membership_epoch || proposal.role_binding_version !== decision.role_binding_version) fail("STALE_DECISION", "decision policy or entitlement epoch is stale", { status: 409 });
  if (decision.channel_id !== config.channel_id || decision.membership_epoch !== config.membership_epoch || decision.role_binding_version !== config.role_binding_version) fail("STALE_CONFIGURATION", "decision configuration is stale", { status: 409 });
  const policy = policyFor(config, decision.policy_id, decision.policy_version);
  assertPolicyMatchesRevision(policy, revision);
  if (!policy.allowed_decisions.includes(decision.decision)) fail("DECISION_NOT_ALLOWED", "policy does not permit this decision", { status: 409 });
  const representative = policy.role_representatives.find((candidate) => candidate.domain_role === decision.actor_domain_role);
  if (!representative || representative.actor_org_id !== ctx.actor.org_id || representative.actor_id !== ctx.actor.actor_id) fail("FORBIDDEN", "actor is not the named representative for this role", { status: 403 });
  if (decision.actor_org_id !== ctx.actor.org_id || decision.actor_id !== ctx.actor.actor_id) fail("FORBIDDEN", "decision actor fields must match the authenticated actor", { status: 403 });
  const existingDecision = await ctx.get(keyFor.decision(decision.decision_id));
  if (existingDecision !== undefined && existingDecision !== null) fail("IMMUTABLE_CONFLICT", "decision_id cannot be reused", { status: 409 });
  const latest = await getLatestDecision(ctx, decision);
  if (decision.decision === "retract") {
    const targetValue = await ctx.get(keyFor.decision(decision.retracts_decision_id as string));
    if (targetValue === undefined || targetValue === null) fail("RETRACT_TARGET_NOT_FOUND", "retract target does not exist", { status: 409 });
    const target = validateDecision(targetValue);
    if (target.actor_org_id !== decision.actor_org_id || target.actor_id !== decision.actor_id || target.proposal_id !== decision.proposal_id || target.actor_domain_role !== decision.actor_domain_role) fail("FORBIDDEN", "retract target is not the actor's decision", { status: 403 });
    if (target.decision === "retract") fail("RETRACT_INVALID", "a retract cannot retract another retract", { status: 409 });
    if (!latest || latest.decision_id !== target.decision_id) fail("RETRACT_NOT_LATEST", "only the latest decision can be retracted", { status: 409 });
  } else if (latest && latest.decision === "retract") {
    // A new decision after a retract is allowed and deliberately does not
    // revive the old approval; this new immutable decision is the only latest
    // state considered by activation.
  }
  const currentCounter = await readReviewCounter(ctx, proposal);
  const nextCounter = currentCounter + 1;
  if (!Number.isSafeInteger(nextCounter)) fail("STATE_LIMIT", "proposal review counter exhausted", { status: 409 });
  await ctx.put(keyFor.decision(decision.decision_id), cloneCanonical(decision));
  await ctx.put(decisionLatestKey(decision), { decision_id: decision.decision_id });
  const updatedProposal: AgreementProposalRecord = { ...proposal, review_counter: nextCounter };
  await ctx.put(keyFor.proposal(proposal.proposal_id), cloneCanonical(updatedProposal));
  await ctx.put(keyFor.reviewCounter(proposal.proposal_id), nextCounter);
  let suspended: AgreementRecord | undefined;
  if (decision.decision !== "approve") {
    suspended = await suspendActiveAgreement(ctx, proposal, decision.decision === "object" ? "required_representative_objected" : decision.decision === "abstain" ? "required_representative_abstained" : "required_decision_retracted", decision.proposal_id);
  }
  return {
    status: "recorded",
    decision_id: decision.decision_id,
    proposal_id: decision.proposal_id,
    ...(suspended ? { suspended_agreement_id: suspended.agreement_id } : {}),
  };
}

async function dependencyEligible(ctx: TxContext, revision: DocumentRevision, depth = 0, seen = new Set<string>()): Promise<void> {
  if (depth > 8) fail("DEPENDENCY_LIMIT", "dependency graph exceeds depth eight", { status: 409 });
  const currentSlot = slotKey(revision.payload);
  if (seen.has(currentSlot)) fail("DEPENDENCY_CYCLE", "dependency graph contains a cycle", { status: 409 });
  const nextSeen = new Set(seen);
  nextSeen.add(currentSlot);
  let traversed = 0;
  const budget = { count: 0 };
  for (const dependency of revision.payload.dependencies) {
    if (dependency.enforcement !== "requires_active") continue;
    traversed += 1;
    if (traversed > 256) fail("DEPENDENCY_LIMIT", "dependency graph exceeds 256 nodes", { status: 409 });
    if (sameSlot(dependency, revision.payload)) fail("DEPENDENCY_CYCLE", "revision cannot require its own acceptance slot", { status: 409 });
    const resolved = await resolveAt(ctx.get.bind(ctx), dependency, nextSeen, depth + 1, budget);
    if (!resolved.eligible || !resolved.revision || resolved.revision.revision_digest !== dependency.revision_digest) {
      fail("DEPENDENCY_INELIGIBLE", "a required active dependency is unavailable or has a different active revision", { status: 409, details: { dependency_digest: dependency.revision_digest, dependency_slot: slotKey(dependency), reason: resolved.reason } });
    }
  }
}

async function executeActivate(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>): Promise<unknown> {
  requireHuman(ctx, config);
  assertKeys(input, ["proposal_id", "agreement_id", "expected_active_agreement_id"], [], "activate input");
  assertId(input.proposal_id, "proposal_id");
  assertId(input.agreement_id, "agreement_id");
  if (input.expected_active_agreement_id !== null) assertId(input.expected_active_agreement_id, "expected_active_agreement_id");
  const proposalValue = await ctx.get(keyFor.proposal(input.proposal_id));
  if (proposalValue === undefined || proposalValue === null) fail("PROPOSAL_NOT_FOUND", "activation proposal does not exist", { status: 404 });
  const proposal = validateProposal(proposalValue);
  await readReviewCounter(ctx, proposal);
  if (proposal.status !== "open") fail("PROPOSAL_REPLAY", "proposal has already been consumed; resume requires a new proposal id", { status: 409 });
  const revisionValue = await ctx.get(keyFor.revision(proposal.revision_digest));
  if (revisionValue === undefined || revisionValue === null) fail("REVISION_NOT_FOUND", "proposal revision does not exist", { status: 404 });
  const revision = validateRevision(revisionValue);
  const policy = policyFor(config, proposal.policy_id, proposal.policy_version);
  assertPolicyMatchesRevision(policy, revision);
  if (proposal.membership_epoch !== config.membership_epoch || proposal.role_binding_version !== config.role_binding_version) fail("STALE_CONFIGURATION", "proposal was made under stale application configuration", { status: 409 });
  const currentActive = await getActiveAgreement(ctx, proposal);
  const currentId = currentActive?.agreement_id ?? null;
  if (currentId !== input.expected_active_agreement_id) fail("STALE_PRECONDITION", "active agreement changed since the proposal was reviewed", { status: 409, details: { expected_active_agreement_id: input.expected_active_agreement_id, actual_active_agreement_id: currentId } });
  if (currentActive && currentActive.revision_digest === revision.revision_digest) fail("ALREADY_ACTIVE", "the same revision is already active for this slot", { status: 409 });
  const existingAgreement = await ctx.get(keyFor.agreement(input.agreement_id));
  if (existingAgreement !== undefined && existingAgreement !== null) fail("IMMUTABLE_CONFLICT", "agreement_id cannot be reused", { status: 409 });
  const approvalDecisionIds: string[] = [];
  for (const role of policy.required_domain_roles) {
    const representative = policy.role_representatives.find((candidate) => candidate.domain_role === role) as RoleRepresentative;
    const latestValue = await ctx.get(keyFor.latestDecision(proposal.proposal_id, proposal.policy_version, role, representative.actor_org_id, representative.actor_id));
    if (latestValue === undefined || latestValue === null) fail("APPROVAL_INCOMPLETE", `required role ${role} has no latest decision`, { status: 409 });
    assertRecord(latestValue, "latest decision reference");
    assertKeys(latestValue, ["decision_id"], [], "latest decision reference");
    const decisionValue = await ctx.get(keyFor.decision(latestValue.decision_id as string));
    if (decisionValue === undefined || decisionValue === null) fail("CORRUPT_STATE", "latest decision points to a missing decision", { status: 500, retryable: true });
    const decision = validateDecision(decisionValue);
    if (decision.decision !== "approve") fail("APPROVAL_INCOMPLETE", `required role ${role} does not currently approve`, { status: 409 });
    if (decision.actor_org_id !== representative.actor_org_id || decision.actor_id !== representative.actor_id || decision.actor_domain_role !== representative.domain_role) fail("STALE_DECISION", `required role ${role} was approved by a different representative`, { status: 409 });
    if (decision.revision_digest !== proposal.revision_digest || decision.proposal_id !== proposal.proposal_id || !sameSlot(decision, proposal) || decision.policy_id !== proposal.policy_id || decision.policy_version !== proposal.policy_version || decision.membership_epoch !== proposal.membership_epoch || decision.role_binding_version !== proposal.role_binding_version) fail("STALE_DECISION", `required role ${role} approved a different immutable target`, { status: 409 });
    if (approvalDecisionIds.includes(decision.decision_id)) fail("CORRUPT_STATE", "multiple required roles selected the same immutable approval decision", { status: 500, retryable: true });
    approvalDecisionIds.push(decision.decision_id);
  }
  await dependencyEligible(ctx, revision);
  const agreement: AgreementRecord = {
    agreement_id: input.agreement_id,
    proposal_id: proposal.proposal_id,
    revision_digest: revision.revision_digest,
    policy_id: policy.policy_id,
    policy_version: policy.policy_version,
    membership_epoch: config.membership_epoch,
    role_binding_version: config.role_binding_version,
    approval_decision_ids: approvalDecisionIds,
    status: "active",
    activated_by: cloneActor(ctx.actor),
    activated_at: ctx.timestamp,
    ...slotFields(revision.payload),
  };
  const epoch = await incrementEpoch(ctx);
  if (currentActive) {
    const superseded: AgreementRecord = { ...currentActive, status: "superseded", status_reason: "replaced_by_new_active_agreement", status_changed_by: cloneActor(ctx.actor), status_changed_at: ctx.timestamp };
    await ctx.put(keyFor.agreement(currentActive.agreement_id), cloneCanonical(superseded));
  }
  await ctx.put(keyFor.agreement(agreement.agreement_id), cloneCanonical(agreement));
  await ctx.put(keyFor.activeSlot(proposal), { agreement_id: agreement.agreement_id });
  await ctx.put(keyFor.proposal(proposal.proposal_id), cloneCanonical({ ...proposal, status: "activated", agreement_id: agreement.agreement_id }));
  return { status: "active", agreement_id: agreement.agreement_id, revision_digest: agreement.revision_digest, eligibility_epoch: epoch, slot: slotKey(agreement) };
}

async function executeStatusChange(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>, desired: "withdrawn" | "suspended"): Promise<unknown> {
  requireHuman(ctx, config);
  assertKeys(input, ["agreement_id", "reason"], [], `${desired} input`);
  assertId(input.agreement_id, "agreement_id");
  assertNonEmptyString(input.reason, "reason", 1000);
  const value = await ctx.get(keyFor.agreement(input.agreement_id));
  if (value === undefined || value === null) fail("AGREEMENT_NOT_FOUND", "agreement does not exist", { status: 404 });
  const agreement = validateAgreement(value);
  const policy = policyFor(config, agreement.policy_id, agreement.policy_version);
  const authorized = policy.role_representatives.some((representative) => representative.actor_org_id === ctx.actor.org_id && representative.actor_id === ctx.actor.actor_id);
  if (!authorized) fail("FORBIDDEN", "only a named domain representative can change agreement status", { status: 403 });
  if (agreement.status !== "active") fail("AGREEMENT_NOT_ACTIVE", "only an active agreement can be withdrawn or suspended", { status: 409 });
  const updated: AgreementRecord = { ...agreement, status: desired, status_reason: input.reason, status_changed_by: cloneActor(ctx.actor), status_changed_at: ctx.timestamp };
  await ctx.put(keyFor.agreement(agreement.agreement_id), cloneCanonical(updated));
  await ctx.put(keyFor.activeSlot(agreement), { agreement_id: null });
  const epoch = await incrementEpoch(ctx);
  return { status: desired, agreement_id: agreement.agreement_id, eligibility_epoch: epoch };
}

async function executeFence(ctx: TxContext, config: DomainConfig, input: Record<string, unknown>): Promise<unknown> {
  configuredIdentity(config, ctx.actor);
  assertKeys(input, ["nonce"], [], "fence input");
  if (typeof input.nonce !== "string" || !/^[A-Za-z0-9._:-]{16,128}$/u.test(input.nonce)) fail("INVALID_INPUT", "fence nonce must be 16 to 128 safe characters");
  if (!config.serving_enabled) fail("SERVING_FROZEN", "serving is disabled", { status: 409 });
  const existing = await ctx.get(keyFor.fence(input.nonce));
  if (existing !== undefined && existing !== null) fail("IMMUTABLE_CONFLICT", "fence nonce has already been used", { status: 409 });
  const epochValue = await ctx.get(keyFor.eligibilityEpoch());
  const epoch = epochValue === undefined || epochValue === null ? 0 : epochValue;
  assertSafeInteger(epoch, "eligibility_epoch", 0);
  await ctx.put(keyFor.fence(input.nonce), { nonce: input.nonce, eligibility_epoch: epoch, tx_id: ctx.tx_id });
  return { status: "fenced", nonce: input.nonce, eligibility_epoch: epoch, tx_id: ctx.tx_id };
}

async function performCommand(ctx: TxContext, config: DomainConfig, command: DomainCommand): Promise<unknown> {
  const input = command.input as Record<string, unknown>;
  switch (command.type) {
    case "publish_revision":
      return executePublish(ctx, config, input);
    case "propose":
      return executePropose(ctx, config, input);
    case "decide":
      return executeDecide(ctx, config, input);
    case "activate":
      return executeActivate(ctx, config, input);
    case "withdraw":
      return executeStatusChange(ctx, config, input, "withdrawn");
    case "suspend":
      return executeStatusChange(ctx, config, input, "suspended");
    case "fence":
      return executeFence(ctx, config, input);
    default:
      fail("UNSUPPORTED_COMMAND", `unsupported domain command ${command.type}`, { status: 400 });
  }
}

/** Bootstrap is intentionally separate from execute: v0.1 has no governance update shortcut. */
export async function bootstrap(ctx: TxContext, configInput: unknown): Promise<unknown> {
  assertContext(ctx);
  if (ctx.actor.kind !== "human") fail("FORBIDDEN", "only a human bootstrap actor is accepted", { status: 403 });
  if (ctx.channel_id !== (isRecord(configInput) ? configInput.channel_id : undefined)) fail("SCOPE_MISMATCH", "bootstrap transaction channel does not match config", { status: 409 });
  const config = validateConfig(configInput);
  const existing = await ctx.get(keyFor.config());
  if (existing !== undefined && existing !== null) fail("ALREADY_BOOTSTRAPPED", "channel configuration is immutable and already exists", { status: 409 });
  await ctx.put(keyFor.config(), cloneCanonical(config));
  await ctx.put(keyFor.eligibilityEpoch(), 0);
  for (const policy of config.policies) await ctx.put(keyFor.policy(policy.policy_id, policy.policy_version), cloneCanonical(policy));
  return { status: "bootstrapped", channel_id: config.channel_id, config_version: config.config_version, membership_epoch: config.membership_epoch, role_binding_version: config.role_binding_version };
}

/** Execute one deterministic state transition. The adapter supplies atomic rollback and MVCC. */
export async function execute(ctx: TxContext, command: DomainCommand): Promise<unknown> {
  assertContext(ctx);
  validateCommand(command);
  const config = await readConfig(ctx);
  if (ctx.channel_id !== config.channel_id) fail("SCOPE_MISMATCH", "transaction channel does not match configured channel", { status: 409 });
  const identity = configuredIdentity(config, ctx.actor);
  const idempotencyKey = keyFor.idempotency(ctx.actor.org_id, command.command_id);
  const requestDigest = idempotencyDigest(command);
  const priorValue = await ctx.get(idempotencyKey);
  if (priorValue !== undefined && priorValue !== null) {
    assertRecord(priorValue, "idempotency record");
    assertKeys(priorValue, ["record_type", "command_id", "command_type", "command_digest", "actor", "result", "tx_id"], [], "idempotency record");
    if (priorValue.record_type !== "IdempotencyRecord") fail("CORRUPT_STATE", "idempotency record type invalid", { status: 500, retryable: true });
    if (priorValue.command_digest !== requestDigest || priorValue.command_type !== command.type || !sameActor(priorValue.actor as Actor, ctx.actor)) fail("IDEMPOTENCY_CONFLICT", "command_id is already bound to another actor or request payload", { status: 409 });
    return cloneCanonical(priorValue.result);
  }
  // Keep the variable read above: config identity is part of the auth check and
  // intentionally occurs before any idempotency result is accepted.
  void identity;
  const result = await performCommand(ctx, config, command);
  const record: IdempotencyRecord = {
    record_type: "IdempotencyRecord",
    command_id: command.command_id,
    command_type: command.type,
    command_digest: requestDigest,
    actor: cloneActor(ctx.actor),
    result: cloneCanonical(result),
    tx_id: ctx.tx_id,
  };
  await ctx.put(idempotencyKey, cloneCanonical(record));
  return result;
}

async function resolveInternal(get: (key: string) => Promise<unknown | undefined>, config: DomainConfig, slot: Slot, seen: Set<string>, depth: number, budget: { count: number }): Promise<ResolveResult> {
  assertSlotShape(slot);
  if (slot.channel_id !== config.channel_id) return { eligible: false, reason: "SCOPE_MISMATCH" };
  if (depth > 8) return { eligible: false, reason: "DEPENDENCY_DEPTH" };
  const currentSlot = slotKey(slot);
  if (seen.has(currentSlot)) return { eligible: false, reason: "DEPENDENCY_CYCLE" };
  budget.count += 1;
  if (budget.count > 256) return { eligible: false, reason: "DEPENDENCY_NODE_LIMIT" };
  const nextSeen = new Set(seen);
  nextSeen.add(currentSlot);
  const pointer = await get(keyFor.activeSlot(slot));
  if (pointer === undefined || pointer === null) return { eligible: false, reason: "NO_ACTIVE_AGREEMENT" };
  let agreementId: string;
  if (typeof pointer === "string") agreementId = pointer;
  else if (isRecord(pointer) && pointer.agreement_id === null) return { eligible: false, reason: "NO_ACTIVE_AGREEMENT" };
  else if (isRecord(pointer) && typeof pointer.agreement_id === "string") agreementId = pointer.agreement_id;
  else return { eligible: false, reason: "CORRUPT_ACTIVE_POINTER" };
  const agreementValue = await get(keyFor.agreement(agreementId));
  if (agreementValue === undefined || agreementValue === null) return { eligible: false, reason: "MISSING_AGREEMENT" };
  let agreement: AgreementRecord;
  try {
    agreement = validateAgreement(agreementValue);
  } catch {
    return { eligible: false, reason: "CORRUPT_AGREEMENT" };
  }
  if (agreement.status !== "active") return { eligible: false, reason: `AGREEMENT_${agreement.status.toUpperCase()}` };
  if (!sameSlot(agreement, slot)) return { eligible: false, reason: "AGREEMENT_SLOT_MISMATCH" };
  if (agreement.membership_epoch !== config.membership_epoch || agreement.role_binding_version !== config.role_binding_version) return { eligible: false, reason: "STALE_CONFIGURATION" };
  const policy = config.policies.find((candidate) => candidate.policy_id === agreement.policy_id && candidate.policy_version === agreement.policy_version);
  if (!policy || !sameSlot(policy, agreement)) return { eligible: false, reason: "STALE_POLICY" };
  try {
    await validateAgreementApprovals(get, agreement);
  } catch (error) {
    if (error instanceof DomainError && error.code === "CORRUPT_STATE") return { eligible: false, reason: "CORRUPT_APPROVALS" };
    throw error;
  }
  const revisionValue = await get(keyFor.revision(agreement.revision_digest));
  if (revisionValue === undefined || revisionValue === null) return { eligible: false, reason: "MISSING_REVISION" };
  let revision: DocumentRevision;
  try {
    revision = validateRevision(revisionValue);
  } catch {
    return { eligible: false, reason: "CORRUPT_REVISION" };
  }
  if (revision.revision_digest !== agreement.revision_digest || !sameSlot(revision.payload, slot)) return { eligible: false, reason: "REVISION_SLOT_MISMATCH" };
  for (const dependency of revision.payload.dependencies) {
    if (dependency.enforcement !== "requires_active") continue;
    const dependencyResult = await resolveInternal(get, config, dependency, nextSeen, depth + 1, budget);
    if (!dependencyResult.eligible) return { eligible: false, reason: `DEPENDENCY_INELIGIBLE:${dependencyResult.reason ?? "UNKNOWN"}` };
    if (!dependencyResult.revision || dependencyResult.revision.revision_digest !== dependency.revision_digest) return { eligible: false, reason: "DEPENDENCY_REVISION_MISMATCH" };
  }
  return { eligible: true, agreement, revision };
}

/** Resolve only from committed authoritative state. Vector indexes and caches are outside this port. */
export async function resolveAt(get: (key: string) => Promise<unknown | undefined>, slot: Slot, seen = new Set<string>(), depth = 0, budget = { count: 0 }): Promise<ResolveResult> {
  assertSlotShape(slot);
  const configValue = await get(keyFor.config());
  if (configValue === undefined || configValue === null) return { eligible: false, reason: "CONFIG_NOT_BOOTSTRAPPED" };
  let config: DomainConfig;
  try {
    config = validateConfig(configValue);
  } catch {
    return { eligible: false, reason: "CORRUPT_CONFIG" };
  }
  if (!config.serving_enabled) return { eligible: false, reason: "SERVING_FROZEN" };
  return resolveInternal(get, config, slot, seen, depth, budget);
}
