import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import * as domain from '../../packages/domain/index.ts';
import type { ApplicationLedger } from '../../packages/storage/ledger-port.ts';
import type { BrowseQuery, BrowseResult, RevisionBrowseRef, ProposalBrowseRef, AgreementBrowseRef, RevisionBrowseAnnotation } from '../../packages/storage/browse-contract.ts';
import { ScanningBrowseQueries } from '../../packages/storage/scanning-browse.ts';
import { cosineSimilarity, developmentEmbedding } from '../../packages/storage/vector-index.ts';
import type { VectorCandidateIndex } from '../../packages/storage/vector-index.ts';
import { SearchMatchCache } from './search-matches.ts';
import type { Actor, Checkpoint } from '../../packages/storage/local-ledger.ts';
import { PrivateStore } from '../../packages/storage/private-store.ts';
import { decodeMarkdownImport, validateMarkdownFilename, MAX_MARKDOWN_BYTES } from '../../packages/import/markdown.ts';
import { slotFields } from '../../packages/config/types.ts';
import { sourceId, sourceMapping, validateSourceManifest } from '../../packages/connectors/source-contract.ts';
import { SourceStore, SourceStoreError } from '../../packages/connectors/source-store.ts';
import { parseJsonStrict } from './json.ts';
import type { ApplicationDefinition, Persona } from '../../packages/config/types.ts';

const P = 'kcl:v1:';
const ID = /^[A-Za-z][A-Za-z0-9._:-]{2,63}$/;
const newId = (prefix: string) => `${prefix}-${randomUUID()}`;
const stableId = (prefix: string, actor: Actor, commandId: string) => `${prefix}-${createHash('sha256').update(`${actor.org_id}:${actor.actor_id}:${commandId}`).digest('hex').slice(0,32)}`;
const sameSlot = (a: any, b: any) => ['channel_id', 'document_id', 'context_id', 'scope_id', 'usage_scope'].every(field => a[field] === b[field]);
const slotKey = (payload: any) => JSON.stringify(slotFields(payload));
interface PageInput { limit?: number; cursor?: string }
interface PageContext { limit: number; offset: number; checkpoint: Checkpoint; binding: string }
interface OverviewInput extends PageInput { proposal_limit?: number; proposal_cursor?: string }
interface BrowseRequestContext {
  checkpoint: Checkpoint;
  config: any;
  eligibility: Map<string, ReturnType<typeof domain.resolveAt>>;
  annotations: Map<string, RevisionBrowseAnnotation>;
  revisions: Map<string, any>;
  /** 체크포인트에 바인드된 검증된 읽기 캐시. null은 검증된 부재를 뜻한다. */
  values: Map<string, any>;
}

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

/** API orchestration over verified application-ledger reads and actor-private storage. */
export class KnowledgerService {
  readonly ledger: ApplicationLedger;
  private vault: PrivateStore;
  private personas: Persona[];
  readonly definition: ApplicationDefinition;
  private bootId = randomUUID();
  private commandQueue: Promise<unknown> = Promise.resolve();
  private queuedCommands = 0;
  private readonly cursorKey = randomBytes(32);
  private scanningBrowse: ScanningBrowseQueries | undefined;
  private readonly searchMatches = new SearchMatchCache();
  private readonly vectorIndex: VectorCandidateIndex | undefined;
  private readonly embedQuery: (text: string) => readonly number[];
  private readonly embedRevision: (title: string, body: string) => readonly number[];

  constructor(ledger: ApplicationLedger, vault: PrivateStore, definition: ApplicationDefinition, personas: Persona[] = definition.personas,
    options: { vectorIndex?: VectorCandidateIndex; embedQuery?: (text: string) => readonly number[]; embedRevision?: (title: string, body: string) => readonly number[] } = {}) {
    this.definition = definition;
    this.ledger = ledger;
    this.vault = vault;
    this.personas = personas;
    this.vectorIndex = options.vectorIndex;
    this.embedQuery = options.embedQuery ?? (text => developmentEmbedding(text));
    this.embedRevision = options.embedRevision ?? ((title, body) => developmentEmbedding(`${title}\n${body}`));
  }
  async refresh(): Promise<void> {
    try { await this.ledger.refresh(); }
    catch (error: any) {
      if (typeof error?.code === 'string' && Number.isInteger(error?.status)) throw new ApiError(error.code, typeof error.message === 'string' ? error.message : '원장에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', error.status, Boolean(error.retryable));
      throw new ApiError('LEDGER_UNAVAILABLE', '원장에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.', 503, true);
    }
  }
  config(at?: Checkpoint) { return this.ledger.read(`${P}config`, at); }
  values(kind: string, at?: Checkpoint): any[] { return this.ledger.entries(`${P}${kind}:`, at).map(([, value]) => value); }
  actor(actor: Actor): void {
    const config = this.config();
    if (!this.personas.some(item => item.org_id === actor.org_id && item.actor_id === actor.actor_id && item.kind === actor.kind)) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없거나 접근할 수 없습니다.', 404);
    if (!config || !Array.isArray(config.identities)) throw new ApiError('LEDGER_NOT_READY', '원장 구성을 확인할 수 없습니다.', 503, true);
    if (!config?.identities.some((item: any) => item.org_id === actor.org_id && item.actor_id === actor.actor_id && item.kind === actor.kind)) throw new ApiError('NOT_FOUND', '대상을 찾을 수 없거나 접근할 수 없습니다.', 404);
    if (!config.serving_enabled) throw new ApiError('SERVING_FROZEN', '현재 공유 지식 제공이 중지되어 있습니다.', 503, true);
  }
  private revision(digest: string, at?: Checkpoint) {
    const value = this.ledger.read(domain.keyFor.revision(digest), at);
    if (!value) throw new ApiError('NOT_FOUND', '개정본을 찾을 수 없거나 접근할 수 없습니다.', 404);
    return value;
  }
  private proposal(id: string) {
    const value = this.ledger.read(domain.keyFor.proposal(id));
    if (!value) throw new ApiError('NOT_FOUND', '제안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    return value;
  }
  private policy(id: string, version?: number) {
    const value = this.config().policies.find((item: any) => item.policy_id === id && (version === undefined || item.policy_version === version));
    if (!value) throw new ApiError('POLICY_NOT_FOUND', '이 범위의 합의 정책이 없습니다.', 409);
    return value;
  }

  async initialize(): Promise<void> {
    await this.refresh();
    const existing = this.config();
    if (!existing) {
      if (this.ledger.mode !== 'local-simulation' || !this.ledger.bootstrap) throw new ApiError('LEDGER_NOT_READY', '원장의 초기 정책 구성을 확인할 수 없습니다.', 503, true);
      await this.ledger.bootstrap(this.definition.bootstrap_actor, this.definition.genesis);
    } else if (domain.canonicalize(existing) !== domain.canonicalize(this.definition.genesis)) {
      throw new ApiError('CONFIGURATION_MISMATCH', '저장된 초기 정책이 선택한 구성과 다릅니다. 기존 원장을 덮어쓸 수 없습니다.', 409);
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

  /** Build and validate the same private revision shape for manual and imported drafts. */
  private buildDraftRevision(actor: Actor, input: any, bodyMarkdown: string, sourceKind: 'human_authored' | 'approved_import' | 'llm_drafted') {
    const base = input.base_revision_digest ? this.revision(input.base_revision_digest) : undefined;
    const payload = base ? structuredClone(base.payload) : {
      contract_type: 'DocumentRevision', contract_version: 1, channel_id: this.ledger.channelId,
      document_id: input.document_id ?? newId('doc'), context_id: input.context_id,
      scope_id: input.scope_id, usage_scope: input.usage_scope, visibility: 'shared_channel', dependencies: [],
    };
    Object.assign(payload, { revision_id: newId('rev'), title: input.title, body_markdown: bodyMarkdown,
      parents: base ? [base.revision_digest] : [], metadata: { author_id: actor.actor_id, author_org_id: actor.org_id,
        created_at: new Date().toISOString(), source_kind: sourceKind, shared_assertions: [] } });
    const revision = { revision_digest: domain.digestPayload(payload), payload };
    domain.validateRevision(revision);
    return revision;
  }

  private buildResumedRevision(actor: Actor, base: any, title: string, bodyMarkdown: string, sourceKind: 'human_authored' | 'approved_import' | 'llm_drafted') {
    const payload = structuredClone(base.payload);
    Object.assign(payload, {
      revision_id: newId('rev'), title, body_markdown: bodyMarkdown,
      metadata: { ...payload.metadata, author_id: actor.actor_id, author_org_id: actor.org_id, created_at: new Date().toISOString(), source_kind: sourceKind },
    });
    const revision = { revision_digest: domain.digestPayload(payload), payload };
    domain.validateRevision(revision);
    return revision;
  }

  private readPrivateDraft(actor: Actor, draftId: string, storedOverride?: any): { stored: any; revision: any } {
    let stored = storedOverride;
    if (stored === undefined) {
      try { stored = this.vault.get('draft', draftId, actor); }
      catch { throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true); }
    }
    if (!stored) throw new ApiError('NOT_FOUND', '초안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    try {
      const revision = domain.validateRevision(stored.revision);
      if (revision.payload.metadata.author_id !== actor.actor_id || revision.payload.metadata.author_org_id !== actor.org_id) throw new Error('author binding');
      return { stored, revision };
    } catch { throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true); }
  }

  private privateDraftMetadata(stored: any): { import?: any; source_draft_id?: string; source?: any } {
    const metadata: { import?: any; source_draft_id?: string; source?: any } = {};
    if (stored.import !== undefined) {
      const value = stored.import;
      try {
        if (!value || typeof value !== 'object' || Array.isArray(value) || value.kind !== 'local_markdown') throw new Error('invalid import');
        validateMarkdownFilename(value.filename);
        const body = stored.revision.payload.body_markdown;
        if (!Number.isSafeInteger(value.byte_length) || value.byte_length < 1 || value.byte_length > MAX_MARKDOWN_BYTES || value.byte_length !== Buffer.byteLength(body)
          || value.sha256 !== createHash('sha256').update(body, 'utf8').digest('hex')) throw new Error('import bytes mismatch');
      } catch { throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true); }
      metadata.import = { kind: value.kind, filename: value.filename, byte_length: value.byte_length, sha256: value.sha256 };
    }
    if (stored.source !== undefined) {
      try {
        const value=stored.source;sourceId(value.source_id);
        const mapping=sourceMapping({path:value.path,policy_id:value.policy_id,policy_version:value.policy_version,title:stored.revision.payload.title});
        metadata.source={source_id:value.source_id,path:mapping.path,policy_id:mapping.policy_id,policy_version:mapping.policy_version};
      } catch {throw new ApiError('PRIVATE_DRAFT_CORRUPT','비공개 원본 연결을 확인할 수 없습니다.',503,true);}
    }
    if (stored.source_draft_id !== undefined) {
      try { metadata.source_draft_id = identifier(stored.source_draft_id); }
      catch { throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true); }
    }
    return metadata;
  }

  private page(actor: Actor, kind: string, input: PageInput = {}, filter: unknown = null, at?: Checkpoint): PageContext {
    const limit = input.limit === undefined ? 20 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError('INVALID_QUERY', '목록 크기는 1부터 50까지여야 합니다.');
    const binding = createHash('sha256').update(domain.canonicalize([actor.org_id, actor.actor_id, actor.kind, kind, filter])).digest('hex');
    let checkpoint = at ?? this.ledger.checkpoint()!;
    let offset = 0;
    if (input.cursor !== undefined) {
      try {
        if (typeof input.cursor !== 'string' || input.cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(input.cursor)) throw new Error('format');
        const [encoded, signature] = input.cursor.split('.');
        const expected = createHmac('sha256', this.cursorKey).update(encoded).digest();
        if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) throw new Error('signature');
        const cursor = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
        if (cursor.version !== 1 || cursor.binding !== binding || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('binding');
        this.ledger.assertCheckpoint(cursor.checkpoint);
        if (at && domain.canonicalize(cursor.checkpoint) !== domain.canonicalize(at)) throw new Error('snapshot');
        checkpoint = cursor.checkpoint; offset = cursor.offset;
      } catch { throw new ApiError('INVALID_CURSOR', '목록 조건이나 계정이 바뀌었습니다. 첫 페이지부터 다시 불러오세요.'); }
    }
    return { limit, offset, checkpoint, binding };
  }

  private nextCursor(page: PageContext, total: number): string | null {
    const offset = page.offset + page.limit;
    if (offset >= total) return null;
    const encoded = Buffer.from(JSON.stringify({ version: 1, binding: page.binding, checkpoint: page.checkpoint, offset })).toString('base64url');
    return `${encoded}.${createHmac('sha256', this.cursorKey).update(encoded).digest('hex')}`;
  }

  private queryBrowse<Q extends BrowseQuery>(query: Q): BrowseResult<Q> {
    if (this.ledger.queryBrowse) return this.ledger.queryBrowse(query);
    this.scanningBrowse ??= new ScanningBrowseQueries(this.ledger);
    return this.scanningBrowse.query(query);
  }

  private browseContext(checkpoint: Checkpoint): BrowseRequestContext {
    const config = this.config(checkpoint);
    const values = new Map<string, any>([[domain.keyFor.config(), config ?? null]]);
    return { checkpoint, config, eligibility: new Map(), annotations: new Map(), revisions: new Map(), values };
  }

  /** 요청 범위 캐시를 통한 읽기. 모든 값은 ledger.read와 동일한 무결성 검증을 거친다. */
  private readAt(context: BrowseRequestContext, key: string): any {
    if (!context.values.has(key)) context.values.set(key, this.ledger.read(key, context.checkpoint) ?? null);
    const value = context.values.get(key);
    // 캐시된 객체는 요청 안에서 공유되므로, 호출자의 in-place 변형이 다른 소비자를
    // 오염시키지 않도록 read()와 같은 격리를 위해 복제본을 돌려준다.
    return value === undefined || value === null ? undefined : structuredClone(value);
  }

  /** 알려진 키를 한 번의 배치 조회로 미리 적재한다. 어댑터가 readMany를 제공하지 않으면 순차 읽기로 되돌아간다. */
  private prefetch(context: BrowseRequestContext, keys: Iterable<string | undefined>): void {
    const missing = new Set<string>();
    for (const key of keys) if (typeof key === 'string' && !context.values.has(key)) missing.add(key);
    if (!missing.size) return;
    if (this.ledger.readMany) {
      const found = this.ledger.readMany([...missing], context.checkpoint);
      for (const key of missing) context.values.set(key, found.get(key) ?? null);
    } else {
      for (const key of missing) context.values.set(key, this.ledger.read(key, context.checkpoint) ?? null);
    }
  }

  /** 개정본 페이지의 읽기를 세 단계로 적재한다: 본문·슬롯 포인터 → 활성 합의 → 승인 결정·합의 대상 개정본. */
  private prefetchRevisionSet(context: BrowseRequestContext, refs: RevisionBrowseRef[]): void {
    this.prefetch(context, refs.flatMap(ref => [ref.key, domain.keyFor.activeSlot(ref.slot), context.annotations.get(ref.revision_digest)?.agreement?.key]));
    const agreementIds = new Set<string>();
    for (const ref of refs) {
      const pointer = this.readAt(context, domain.keyFor.activeSlot(ref.slot));
      // active_slot 값은 { agreement_id } 객체다 — 커밋 시 상태 검증이 보장한다.
      const id = pointer?.agreement_id;
      if (typeof id === 'string') agreementIds.add(id);
    }
    this.prefetch(context, [...agreementIds].map(id => domain.keyFor.agreement(id)));
    const followup: string[] = [];
    for (const id of agreementIds) {
      const agreement = this.readAt(context, domain.keyFor.agreement(id));
      for (const decisionId of agreement?.approval_decision_ids ?? []) if (typeof decisionId === 'string') followup.push(domain.keyFor.decision(decisionId));
      if (typeof agreement?.revision_digest === 'string') followup.push(domain.keyFor.revision(agreement.revision_digest));
    }
    this.prefetch(context, followup);
  }

  private annotate(context: BrowseRequestContext, digests: string[]): void {
    const missing = [...new Set(digests)].filter(digest => !context.annotations.has(digest));
    if (!missing.length) return;
    const annotations = this.queryBrowse({ kind: 'revision-annotations', at: context.checkpoint, revision_digests: missing });
    for (const annotation of annotations) context.annotations.set(annotation.revision_digest, annotation);
  }

  private revisionRef(digest: string, context: BrowseRequestContext): RevisionBrowseRef {
    this.annotate(context, [digest]);
    const reference = context.annotations.get(digest)?.revision;
    if (!reference) throw new ApiError('NOT_FOUND', '개정본을 찾을 수 없거나 접근할 수 없습니다.', 404);
    return reference;
  }

  /** 브라우즈 색인 참조와 canonical 개정본의 일치를 검증한다 — 색인은 참조일 뿐 값의 근거가 아니다. */
  private checkIndexedRevision(reference: RevisionBrowseRef, revision: any): void {
    if (reference.key !== domain.keyFor.revision(reference.revision_digest) || !revision?.payload
      || revision.revision_digest !== reference.revision_digest || !sameSlot(revision.payload, reference.slot)) {
      throw new ApiError('PROJECTION_INVALID', '검증된 원장 참조와 개정본이 일치하지 않습니다.', 503);
    }
  }

  private readIndexedRevision(reference: RevisionBrowseRef, context: BrowseRequestContext) {
    const revision = this.readAt(context, reference.key);
    this.checkIndexedRevision(reference, revision);
    return { ...revision, published_checkpoint: reference.published_checkpoint };
  }

  private pageRevision(reference: RevisionBrowseRef, context: BrowseRequestContext) {
    let value = context.revisions.get(reference.revision_digest);
    if (!value) { value = this.readIndexedRevision(reference, context); context.revisions.set(reference.revision_digest, value); }
    return value;
  }

  private readIndexedProposal(reference: ProposalBrowseRef, context: BrowseRequestContext) {
    const proposal = this.readAt(context, reference.key);
    if (reference.key !== domain.keyFor.proposal(reference.proposal_id) || !proposal || proposal.proposal_id !== reference.proposal_id
      || proposal.revision_digest !== reference.revision_digest || proposal.created_at !== reference.created_at || !sameSlot(proposal, reference.slot)) {
      throw new ApiError('PROJECTION_INVALID', '검증된 원장 참조와 제안이 일치하지 않습니다.', 503);
    }
    return proposal;
  }

  private readIndexedAgreement(reference: AgreementBrowseRef, context: BrowseRequestContext) {
    const agreement = this.readAt(context, reference.key);
    if (reference.key !== domain.keyFor.agreement(reference.agreement_id) || !agreement || agreement.agreement_id !== reference.agreement_id
      || agreement.revision_digest !== reference.revision_digest || agreement.activated_at !== reference.activated_at || !sameSlot(agreement, reference.slot)) {
      throw new ApiError('PROJECTION_INVALID', '검증된 원장 참조와 합의가 일치하지 않습니다.', 503);
    }
    return agreement;
  }

  private async describeRevision(revision: any, context: BrowseRequestContext, full = false) {
    const key = slotKey(revision.payload);
    let pending = context.eligibility.get(key);
    if (!pending) { pending = domain.resolveAt(async stateKey => this.readAt(context, stateKey), slotFields(revision.payload)); context.eligibility.set(key, pending); }
    const eligibility = await pending;
    this.annotate(context, [revision.revision_digest]);
    const annotation = context.annotations.get(revision.revision_digest);
    const agreement = eligibility.agreement?.revision_digest === revision.revision_digest ? eligibility.agreement
      : annotation?.agreement ? this.readIndexedAgreement(annotation.agreement, context) : undefined;
    const { body_markdown, ...summary } = revision.payload;
    return { view: full ? 'full' : 'summary', revision_digest: revision.revision_digest, payload: full ? revision.payload : summary,
      published_checkpoint: revision.published_checkpoint, agreement,
      active_agreement: eligibility.agreement?.status === 'active' ? eligibility.agreement : null,
      eligible: eligibility.eligible && eligibility.revision?.revision_digest === revision.revision_digest,
      reason: eligibility.reason, proposed: annotation?.has_proposal ?? false };
  }

  /** 제안이 바인딩된 정책 버전의 책임자 슬롯 목록을 반환한다. 정책이 없으면 예외 — 설정과 제안의 정합성은 커밋 시 보장된다. */
  private proposalRepresentatives(context: BrowseRequestContext, proposal: any): any[] {
    return context.config.policies.find((policy: any) => policy.policy_id === proposal.policy_id && policy.policy_version === proposal.policy_version).role_representatives;
  }

  /** 제안 페이지가 읽을 키를 세 단계로 미리 적재한다: 제안/개정본 → 합의·최신 결정 포인터 → 결정 본문. */
  private prefetchProposalPage(context: BrowseRequestContext, proposals: any[]): void {
    const pointerKeys: string[] = [];
    const dependencyKeys: (string | undefined)[] = [];
    for (const proposal of proposals) {
      dependencyKeys.push(proposal.agreement_id ? domain.keyFor.agreement(proposal.agreement_id) : undefined);
      for (const representative of this.proposalRepresentatives(context, proposal)) {
        pointerKeys.push(domain.keyFor.latestDecision(proposal.proposal_id, proposal.policy_version, representative.domain_role, representative.actor_org_id, representative.actor_id));
      }
    }
    this.prefetch(context, [...dependencyKeys, ...pointerKeys]);
    this.prefetch(context, pointerKeys
      .map(key => this.readAt(context, key)?.decision_id)
      .filter((id): id is string => typeof id === 'string')
      .map(id => domain.keyFor.decision(id)));
  }

  private describeProposal(proposal: any, context: BrowseRequestContext, revision: any) {
    const representatives = this.proposalRepresentatives(context, proposal);
    const { body_markdown, ...payload } = revision.payload;
    return { ...proposal, agreement: proposal.agreement_id ? this.readAt(context, domain.keyFor.agreement(proposal.agreement_id)) : undefined,
      revision_summary: { view: 'summary', revision_digest: revision.revision_digest, payload, published_checkpoint: revision.published_checkpoint },
      decisions: representatives.map((rep: any) => {
        const pointer = this.readAt(context, domain.keyFor.latestDecision(proposal.proposal_id, proposal.policy_version, rep.domain_role, rep.actor_org_id, rep.actor_id));
        return pointer ? this.readAt(context, domain.keyFor.decision(pointer.decision_id)) : undefined;
      }).filter(Boolean), required_representatives: representatives };
  }

  private proposalPage(page: PageContext, context: BrowseRequestContext, digest?: string) {
    const result = this.queryBrowse({ kind: 'proposals', at: page.checkpoint, offset: page.offset, limit: page.limit, revision_digest: digest });
    this.annotate(context, result.items.map(reference => reference.revision_digest));
    this.prefetch(context, result.items.flatMap(reference => [reference.key, context.annotations.get(reference.revision_digest)?.revision?.key]));
    const proposals = result.items.map(reference => this.readIndexedProposal(reference, context));
    this.prefetchProposalPage(context, proposals);
    return { proposals: proposals.map(proposal => {
      const revision = this.pageRevision(this.revisionRef(proposal.revision_digest, context), context);
      return this.describeProposal(proposal, context, revision);
    }), proposals_total: result.total, proposals_next_cursor: this.nextCursor(page, result.total) };
  }

  async getProposal(actor: Actor, id: string) {
    identifier(id); await this.refresh(); this.actor(actor);
    const checkpoint = this.ledger.checkpoint()!;
    const proposal = this.ledger.read(domain.keyFor.proposal(id), checkpoint);
    if (!proposal) throw new ApiError('NOT_FOUND', '제안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    const context = this.browseContext(checkpoint);
    const revision = this.pageRevision(this.revisionRef(proposal.revision_digest, context), context);
    return { ...this.describeProposal(proposal, context, revision), checkpoint };
  }

  async overview(actor: Actor, input: OverviewInput = {}) {
    onlyFields(input, ['limit', 'cursor', 'proposal_limit', 'proposal_cursor']);
    await this.refresh(); this.actor(actor);
    let page = this.page(actor, 'overview', input);
    const proposals = this.page(actor, 'proposals', { limit: input.proposal_limit, cursor: input.proposal_cursor }, null, input.cursor ? page.checkpoint : undefined);
    if (!input.cursor && input.proposal_cursor) page = this.page(actor, 'overview', input, null, proposals.checkpoint);
    const checkpoint = page.checkpoint;
    const context = this.browseContext(checkpoint);
    const result = this.queryBrowse({ kind: 'revisions', mode: 'latest-per-slot', at: checkpoint, offset: page.offset, limit: page.limit });
    this.annotate(context, result.items.map(reference => reference.revision_digest));
    this.prefetchRevisionSet(context, result.items);
    const documents = await Promise.all(result.items.map(reference => this.describeRevision(this.pageRevision(reference, context), context)));
    const config = context.config;
    const proposalPage = this.proposalPage({ ...proposals, checkpoint }, context);
    this.actor(actor);
    return { view: 'summary', workspace: this.definition.workspace, organizations: this.definition.organizations, demo: this.definition.demo, mode: this.ledger.mode,
      channel: { channel_id: config.channel_id, org_ids: [...new Set(config.identities.map((item: any) => item.org_id))], config_version: config.config_version, membership_epoch: config.membership_epoch },
      actor, documents, documents_total: result.total, next_cursor: this.nextCursor(page, result.total),
      ...proposalPage, policies: config.policies, checkpoint };
  }

  /** 운영 관측 스냅샷. 원장이 읽히지 않는 장애 상황에서도 인증된 세션에는 부분 상태를 반환한다. */
  async operations(actor: Actor) {
    try { await this.refresh(); } catch { /* 갱신 실패 상태도 관측 대상이다. */ }
    try { this.actor(actor); }
    catch (error: any) {
      // 제공 중지·미초기화 상태에서도 관측은 허용하되, 미등록 신원은 그대로 거부한다.
      if (!(error instanceof ApiError && (error.code === 'SERVING_FROZEN' || error.code === 'LEDGER_NOT_READY'))) throw error;
    }
    const readSafe = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
    const checkpoint = readSafe(() => this.ledger.checkpoint());
    const config = readSafe(() => this.config());
    const counts = checkpoint ? readSafe(() => ({
      documents: this.queryBrowse({ kind: 'revisions', mode: 'latest-per-slot', at: checkpoint, offset: 0, limit: 1 }).total,
      proposals: this.queryBrowse({ kind: 'proposals', at: checkpoint, offset: 0, limit: 1 }).total,
      agreements: this.values('agreement').length,
    })) : null;
    const events = readSafe(() => this.ledger.events(Math.max(0, (checkpoint?.block_number ?? 0) - 10), 100))
      ?.slice(-10).reverse()
      .map(event => ({ checkpoint: event.checkpoint, timestamp: event.timestamp, writes: event.writes.length,
        kinds: [...new Set(event.writes.map(([key]) => key.split(':')[2]))].sort() }));
    let fabric: Record<string, unknown> | null = null;
    try { fabric = await this.ledger.operations?.() ?? null; } catch { fabric = null; }
    return { view: 'operations', mode: this.ledger.mode, workspace: this.definition.workspace, demo: this.definition.demo,
      generated_at: new Date().toISOString(), channel_id: this.ledger.channelId,
      ledger_available: checkpoint !== null, checkpoint,
      configuration: config ? { config_version: config.config_version, membership_epoch: config.membership_epoch,
        organizations: [...new Set((config.identities ?? []).map((item: any) => item.org_id))],
        identities: (config.identities ?? []).length, policies: (config.policies ?? []).length,
        serving_enabled: config.serving_enabled } : null,
      counts, recent_events: events ?? [], fabric };
  }

  async revisionView(actor: Actor, digest: string, input: { proposal_limit?: number; proposal_cursor?: string } = {}) {
    onlyFields(input, ['proposal_limit', 'proposal_cursor']);
    await this.refresh(); this.actor(actor);
    const page = this.page(actor, 'revision-proposals', { limit: input.proposal_limit, cursor: input.proposal_cursor }, digest);
    const context = this.browseContext(page.checkpoint);
    const revision = this.pageRevision(this.revisionRef(digest, context), context);
    const view = await this.describeRevision(revision, context, true);
    const proposals = this.proposalPage(page, context, digest);
    this.actor(actor);
    return { ...view, ...proposals, checkpoint: page.checkpoint };
  }

  async revisionHistory(actor: Actor, digest: string, input: PageInput = {}) {
    onlyFields(input, ['limit', 'cursor']);
    await this.refresh(); this.actor(actor);
    const page = this.page(actor, 'revision-history', input, digest);
    const context = this.browseContext(page.checkpoint);
    const target = this.revisionRef(digest, context);
    this.pageRevision(target, context);
    const result = this.queryBrowse({ kind: 'revisions', mode: 'slot', slot: target.slot, at: page.checkpoint, offset: page.offset, limit: page.limit });
    this.annotate(context, result.items.map(reference => reference.revision_digest));
    this.prefetchRevisionSet(context, result.items);
    const revisions = await Promise.all(result.items.map(reference => this.describeRevision(this.pageRevision(reference, context), context)));
    this.actor(actor);
    return { revisions, total: result.total, next_cursor: this.nextCursor(page, result.total), checkpoint: page.checkpoint };
  }

  async documentRevisions(actor: Actor, id: string, input: PageInput = {}) {
    identifier(id); onlyFields(input, ['limit', 'cursor']);
    await this.refresh(); this.actor(actor);
    const page = this.page(actor, 'document-revisions', input, id);
    const context = this.browseContext(page.checkpoint);
    const result = this.queryBrowse({ kind: 'revisions', mode: 'document', document_id: id, at: page.checkpoint, offset: page.offset, limit: page.limit });
    if (!result.total) throw new ApiError('NOT_FOUND', '문서를 찾을 수 없거나 접근할 수 없습니다.', 404);
    this.annotate(context, result.items.map(reference => reference.revision_digest));
    this.prefetchRevisionSet(context, result.items);
    const revisions = await Promise.all(result.items.map(reference => this.describeRevision(this.pageRevision(reference, context), context)));
    this.actor(actor);
    return { revisions, total: result.total, next_cursor: this.nextCursor(page, result.total), checkpoint: page.checkpoint };
  }

  async draft(actor: Actor, input: any) {
    await this.refresh();
    this.actor(actor);
    onlyFields(input, ['base_revision_digest', 'title', 'body_markdown', 'source_kind', 'context_id', 'scope_id', 'usage_scope', 'document_id']);
    const revision = this.buildDraftRevision(actor, input, input.body_markdown, input.source_kind ?? (actor.kind === 'agent' ? 'llm_drafted' : 'human_authored'));
    const draftId = newId('draft');
    this.vault.put('draft', draftId, actor, { revision });
    return { draft_id: draftId, revision };
  }

  async listDrafts(actor: Actor, limit: number, cursor?: string) {
    await this.refresh();
    this.actor(actor);
    const result = this.vault.listDrafts(actor, limit, cursor);
    if (result.total < 0) throw new ApiError('NOT_FOUND', '초안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    if (result.corrupt) throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true);
    return {
      drafts: result.rows.map(row => ({ draft_id: row.record_id, title: row.title, revision_digest: row.revision_digest,
        document_id: row.document_id, context_id: row.context_id, scope_id: row.scope_id, usage_scope: row.usage_scope, source_kind: row.source_kind, created_at: row.created_at })),
      total: result.total, next_cursor: result.nextCursor,
    };
  }

  async getDraft(actor: Actor, draftId: string) {
    await this.refresh();
    this.actor(actor);
    identifier(draftId);
    const { stored, revision } = this.readPrivateDraft(actor, draftId);
    const response: any = { draft_id: draftId, revision };
    Object.assign(response, this.privateDraftMetadata(stored));
    return response;
  }

  async resumeDraft(actor: Actor, draftId: string, input: any) {
    onlyFields(input, ['edit_id', 'title', 'body_markdown', 'source_kind']);
    identifier(draftId);
    identifier(input.edit_id);
    if (typeof input.title !== 'string' || typeof input.body_markdown !== 'string') throw new ApiError('INVALID_INPUT', '초안 제목과 본문이 필요합니다.');
    if (input.source_kind !== undefined && !['human_authored', 'approved_import', 'llm_drafted'].includes(input.source_kind)) throw new ApiError('INVALID_INPUT', '올바른 초안 source_kind가 필요합니다.');
    return this.privateWrite(actor, () => {
      const source = this.readPrivateDraft(actor, draftId);
      const base = source.revision;
      const requestDigest = createHash('sha256').update(domain.canonicalize({ route: 'draft-edit', source_draft_id: draftId, input })).digest('hex');
      const newDraftId = `draft-edit-${createHash('sha256').update(`${actor.org_id}:${actor.actor_id}:${input.edit_id}`).digest('hex').slice(0, 48)}`;
      let existing: any;
      try { existing = this.vault.get('draft', newDraftId, actor); }
      catch { throw new ApiError('PRIVATE_DRAFT_CORRUPT', '비공개 초안을 읽을 수 없습니다. 관리자 확인이 필요합니다.', 503, true); }
      if (existing) {
        if (existing.request_digest !== requestDigest || existing.source_draft_id !== draftId) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 edit_id로 다른 요청을 보낼 수 없습니다.', 409);
        const existingRevision = this.readPrivateDraft(actor, newDraftId, existing).revision;
        return { draft_id: newDraftId, revision: existingRevision, source_draft_id: draftId };
      }
      const sourceKind = input.source_kind ?? base.payload.metadata.source_kind;
      let revision: any;
      try { revision = this.buildResumedRevision(actor, base, input.title, input.body_markdown, sourceKind); }
      catch { throw new ApiError('INVALID_INPUT', '초안 제목 또는 본문이 올바르지 않습니다.'); }
      this.vault.put('draft', newDraftId, actor, { revision, source_draft_id: draftId, request_digest: requestDigest });
      return { draft_id: newDraftId, revision, source_draft_id: draftId };
    });
  }

  async importMarkdown(actor: Actor, input: any) {
    onlyFields(input, ['import_id', 'filename', 'content_base64', 'title', 'context_id', 'scope_id', 'usage_scope', 'document_id', 'base_revision_digest']);
    identifier(input.import_id);
    if (input.base_revision_digest !== undefined && (typeof input.base_revision_digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.base_revision_digest))) throw new ApiError('INVALID_INPUT', '올바른 기존 개정 digest가 필요합니다.');
    return this.privateWrite(actor, () => {
      const requestDigest = createHash('sha256').update(domain.canonicalize({ route: 'markdown-import', input })).digest('hex');
      const draftId = `draft-import-${createHash('sha256').update(`${actor.org_id}:${actor.actor_id}:${actor.kind}:${input.import_id}`).digest('hex').slice(0, 48)}`;
      const existing = this.vault.get('draft', draftId, actor);
      if (existing) {
        if (existing.request_digest !== requestDigest || !existing.import) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 import_id로 다른 요청을 보낼 수 없습니다.', 409);
        return { draft_id: draftId, revision: existing.revision, import: existing.import };
      }
      let imported;
      try {
        imported = decodeMarkdownImport(input.filename, input.content_base64);
      } catch (error: any) {
        if (error?.code === 'INVALID_INPUT' && typeof error.message === 'string') throw new ApiError('INVALID_INPUT', error.message);
        throw error;
      }
      const revision = this.buildDraftRevision(actor, input, imported.content, 'approved_import');
      const metadata = { kind: 'local_markdown' as const, filename: imported.filename, byte_length: imported.byteLength, sha256: imported.sha256 };
      this.vault.put('draft', draftId, actor, { revision, import: metadata, request_digest: requestDigest });
      return { draft_id: draftId, revision, import: metadata };
    });
  }

  async validateSourceManifest(actor:Actor,input:any) {
    await this.refresh();this.actor(actor);onlyFields(input,['manifest_json']);
    if(typeof input.manifest_json!=='string'||Buffer.byteLength(input.manifest_json)>128*1024)throw new ApiError('INVALID_SOURCE','원본 manifest는 128 KiB 이하 JSON이어야 합니다.');
    let value;try{value=parseJsonStrict(input.manifest_json);}catch{throw new ApiError('INVALID_SOURCE','중복 필드 없는 올바른 원본 manifest가 필요합니다.');}
    const manifest=validateSourceManifest(value);
    for(const file of manifest.files)this.policy(file.policy_id,file.policy_version);
    return {manifest};
  }
  async listSources(actor:Actor,limit=20,cursor?:string) {
    await this.refresh();this.actor(actor);return new SourceStore(this.vault).list(actor,limit,cursor);
  }
  async getSource(actor:Actor,id:string) {
    await this.refresh();this.actor(actor);const source=new SourceStore(this.vault).get(actor,id);
    if(!source)throw new SourceStoreError('NOT_FOUND',404);return source;
  }
  private async privateWrite<T>(actor: Actor, operation: () => T): Promise<T> {
    await this.refresh();
    this.actor(actor);
    // No await inside operation: validation, CAS, and private writes finish atomically
    // with respect to other JS tasks, without waiting for public transport submission.
    return operation();
  }
  importSourceMarkdown(actor:Actor,id:string,input:any) {
    onlyFields(input,['operation_id','expected_version','path','policy_id','policy_version','title','content_base64']);
    return this.privateWrite(actor,()=>{
      const mapping=sourceMapping({path:input.path,policy_id:input.policy_id,policy_version:input.policy_version,title:input.title});
      const policy=this.policy(mapping.policy_id,mapping.policy_version);
      return new SourceStore(this.vault).importMarkdown(actor,id,input,(_mapping,content)=>{
        const candidates=this.values('revision').filter(revision=>sameSlot(revision.payload,policy)).map(revision=>({revision,at:this.ledger.checkpointForStateCreation(domain.keyFor.revision(revision.revision_digest))}));
        candidates.sort((a,b)=>a.at.block_number-b.at.block_number||a.at.transaction_index-b.at.transaction_index);
        const base=candidates.at(-1)?.revision;
        const revision=this.buildDraftRevision(actor,{...slotFields(policy),title:mapping.title,...(base?{base_revision_digest:base.revision_digest}:{})},content,'approved_import');
        return {draft_id:newId('draft'),revision};
      });
    });
  }
  reconcileSource(actor:Actor,id:string,input:any) {
    onlyFields(input,['operation_id','expected_version','present_paths']);
    return this.privateWrite(actor,()=>new SourceStore(this.vault).reconcile(actor,id,input));
  }
  async getRevision(actor:Actor,digest:string) {
    if(!/^sha256:[a-f0-9]{64}$/.test(digest))throw new ApiError('INVALID_INPUT','올바른 개정 digest가 필요합니다.');
    await this.refresh();this.actor(actor);
    const revision=this.ledger.read(domain.keyFor.revision(digest));
    if(!revision)throw new ApiError('NOT_FOUND','개정본을 찾을 수 없거나 접근할 수 없습니다.',404);
    return domain.validateRevision(revision);
  }

  async getAgreement(actor: Actor, id: string) {
    identifier(id); await this.refresh(); this.actor(actor);
    const agreement = this.ledger.read(domain.keyFor.agreement(id));
    if (!agreement) throw new ApiError('NOT_FOUND', '합의를 찾을 수 없거나 접근할 수 없습니다.', 404);
    return agreement;
  }

  async preview(actor: Actor, input: any) {
    await this.refresh();
    this.actor(actor); onlyFields(input, ['draft_id']);
    const draft = this.vault.get('draft', identifier(input.draft_id), actor);
    if (!draft) throw new ApiError('NOT_FOUND', '초안을 찾을 수 없거나 접근할 수 없습니다.', 404);
    const config = this.config();
    const registered = config.identities.find((item: any) => item.org_id === actor.org_id && item.actor_id === actor.actor_id);
    if (!registered.publish_contexts.includes('*') && !registered.publish_contexts.includes(draft.revision.payload.context_id)) throw new ApiError('PUBLISH_FORBIDDEN', '이 맥락의 공유 권한이 없습니다.', 403);
    const preview = { preview_id: newId('preview'), revision_digest: draft.revision.revision_digest,
      recipients: [...new Set(config.identities.map((item: any) => item.org_id))],
      config_version: config.config_version, membership_epoch: config.membership_epoch,
      body_bytes: Buffer.byteLength(draft.revision.payload.body_markdown), expires_at: new Date(Date.now() + 300_000).toISOString(), revision: draft.revision };
    this.vault.put('preview', preview.preview_id, actor, preview);
    return preview;
  }

  private serializeCommand<T>(operation: () => Promise<T>): Promise<T> {
    if (this.queuedCommands >= 32) return Promise.reject(new ApiError('COMMAND_QUEUE_FULL', '원장 요청이 많습니다. 잠시 후 같은 요청으로 다시 시도하세요.', 503, true));
    this.queuedCommands++;
    const run = this.commandQueue.then(operation).finally(() => { this.queuedCommands--; });
    this.commandQueue = run.catch(() => undefined);
    return run;
  }

  /** Persist the exact generated command before execution so HTTP retries bind identical timestamps/IDs. */
  private command(actor: Actor, route: string, input: any, build: () => any): Promise<any> {
    identifier(input.command_id);
    return this.serializeCommand(async () => {
      await this.refresh();
      this.actor(actor);
      const digest = createHash('sha256').update(domain.canonicalize({ route, input })).digest('hex');
      let stored = this.vault.get('command', input.command_id, actor);
      if (stored && stored.request_digest !== digest) throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 command_id로 다른 요청을 보낼 수 없습니다.', 409);
      if (!stored) {
        stored = { request_digest: digest, command: { command_id: input.command_id, ...build() }, tracking: {created_at:new Date().toISOString(),status:'pending'} };
        this.vault.put('command', input.command_id, actor, stored);
      }
      return this.executeStoredCommand(actor, stored);

    });
  }

  private storedCommand(actor: Actor, id: string, supplied?: any): any {
    let stored: any;
    try {
      stored = supplied ?? this.vault.get('command', id, actor);
      if (!stored) throw new ApiError('NOT_FOUND', '요청을 찾을 수 없거나 접근할 수 없습니다.', 404);
      if (!/^[a-f0-9]{64}$/.test(stored.request_digest) || stored.command?.command_id !== id
        || !['publish_revision','propose','decide','activate','withdraw','suspend'].includes(stored.command.type)) throw new Error('Invalid command');
      domain.idempotencyDigest(stored.command);
      if (stored.tracking !== undefined && (!stored.tracking || !['pending','rejected'].includes(stored.tracking.status)
        || !Number.isFinite(Date.parse(stored.tracking.created_at))
        || (stored.tracking.code !== undefined && !/^[A-Z][A-Z0-9_]{1,63}$/.test(stored.tracking.code)))) throw new Error('Invalid tracking metadata');
      return stored;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('PRIVATE_COMMAND_CORRUPT', '저장된 요청을 확인할 수 없습니다.', 503, true);
    }
  }

  private committedCommand(actor: Actor, command: any) {
    const committed = this.ledger.read(domain.keyFor.idempotency(actor.org_id, command.command_id));
    if (!committed) return undefined;
    if (committed.record_type !== 'IdempotencyRecord' || committed.command_id !== command.command_id
      || committed.actor?.org_id !== actor.org_id || committed.actor?.actor_id !== actor.actor_id || committed.actor?.kind !== actor.kind
      || committed.command_digest !== domain.idempotencyDigest(command) || committed.command_type !== command.type || typeof committed.tx_id !== 'string') {
      throw new ApiError('IDEMPOTENCY_CONFLICT', '원장 기록이 이 요청의 사용자 또는 내용과 일치하지 않습니다.', 409);
    }
    return {status:'committed' as const,result:committed.result,checkpoint:this.ledger.checkpointForTransaction(committed.tx_id)};
  }

  private async executeStoredCommand(actor: Actor, stored: any) {
    const id = stored.command.command_id;
    try {
      const receipt = await this.ledger.execute(actor, stored.command);
      if (receipt.status === 'pending') {
        stored.tracking = {created_at:stored.tracking?.created_at ?? new Date().toISOString(),status:'pending'};
        this.vault.updateCommand(id,actor,stored);
        return receipt;
      }
      const committed = this.committedCommand(actor,stored.command);
      if (!committed) throw new ApiError('PROJECTION_BEHIND', '원장 projection에서 커밋된 거래를 확인하지 못했습니다.', 503, true);
      return {command_id:id,...committed};
    } catch (error:any) {
      // Only definitive preflight/authorization/conflict errors become rejection hints.
      // A verified ledger receipt or outstanding transport attempt always takes precedence.
      if (!error?.retryable && Number.isInteger(error?.status) && error.status>=400 && error.status<500 && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)) {
        stored.tracking={created_at:stored.tracking?.created_at ?? new Date().toISOString(),status:'rejected',code:error.code};
        this.vault.updateCommand(id,actor,stored);
      } else if (stored.tracking?.status === 'rejected') {
        stored.tracking={created_at:stored.tracking.created_at,status:'pending'};
        this.vault.updateCommand(id,actor,stored);
      }
      throw error;
    }
  }

  private async describeCommand(actor: Actor, stored: any, queryPeer: boolean) {
    const command=stored.command;
    const observed=this.committedCommand(actor,command) ?? await this.ledger.observeCommand?.(actor,command,queryPeer);
    const status=observed?.status ?? stored.tracking?.status ?? 'pending';
    const input=command.input;
    const target=command.type==='publish_revision' ? input?.revision?.revision_digest
      : command.type==='propose' ? input?.revision_digest : command.type==='decide' ? input?.decision?.proposal_id : input?.proposal_id ?? input?.agreement_id;
    const result:any={command_id:command.command_id,command_type:command.type,target_id:typeof target==='string'?target:null,
      status,created_at:stored.tracking?.created_at ?? null};
    if(observed?.status==='committed') result.checkpoint=observed.checkpoint;
    if(status==='rejected'||status==='cancelled') result.code=(observed && 'code' in observed ? observed.code : undefined) ?? stored.tracking?.code ?? 'LEDGER_CONFLICT';
    return result;
  }

  async listCommands(actor: Actor, limit=20, cursor?:string) {
    await this.refresh();this.actor(actor);
    let page;
    try { page=this.vault.commandPage(actor,limit,cursor); }
    catch { throw new ApiError('PRIVATE_COMMAND_CORRUPT','저장된 요청 목록을 확인할 수 없습니다.',503,true); }
    if(!page) throw new ApiError('NOT_FOUND','요청을 찾을 수 없거나 접근할 수 없습니다.',404);
    const commands=[];
    for(const row of page.rows) commands.push(await this.describeCommand(actor,this.storedCommand(actor,row.id,row.value),false));
    this.actor(actor);
    return {commands,next_cursor:page.nextCursor};
  }

  async getCommand(actor: Actor,id:string) {
    identifier(id);await this.refresh();this.actor(actor);
    const description=await this.describeCommand(actor,this.storedCommand(actor,id),true);
    this.actor(actor);return description;
  }

  retryCommand(actor: Actor,id:string,input:any) {
    identifier(id);onlyFields(input,[]);
    return this.serializeCommand(async()=>{
      await this.refresh();this.actor(actor);
      return this.executeStoredCommand(actor,this.storedCommand(actor,id));
    });
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
    onlyFields(input, ['query', 'context_id', 'scope_id', 'usage_scope', 'limit', 'cursor']);
    if (typeof input.query !== 'string' || input.query.length > 1000) throw new ApiError('INVALID_INPUT', '검색어는 1,000자 이하여야 합니다.');
    for (const field of ['context_id', 'scope_id', 'usage_scope']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 100)) throw new ApiError('INVALID_INPUT', '올바른 검색 범위가 필요합니다.');
    await this.refresh(); this.actor(actor);
    const filter = { query: input.query, context_id: input.context_id ?? null, scope_id: input.scope_id ?? null, usage_scope: input.usage_scope ?? null };
    const page = this.page(actor, 'search', input, filter);
    const cacheKey = domain.canonicalize([page.binding, page.checkpoint]);
    let matches = this.searchMatches.get(cacheKey);
    if (!matches) {
      const ids: string[] = []; const query = input.query.toLocaleLowerCase();
      let offset = 0;
      while (true) {
        const candidates = this.queryBrowse({ kind: 'revisions', mode: 'all', at: page.checkpoint, offset, limit: 1000,
          context_id: input.context_id || undefined, scope_id: input.scope_id || undefined, usage_scope: input.usage_scope || undefined });
        // 빈 질의는 본문을 전혀 읽지 않는다 — 스캔 결과를 결과 캐시에 싣지 않는 것과 같은 이유로 배치 읽기도 건너뛴다.
        const prefetched = query === '' ? undefined : this.ledger.readMany?.(candidates.items.map(reference => reference.key), page.checkpoint);
        for (const reference of candidates.items) {
          // Preserve the existing literal JS substring rule, including empty,
          // short, CJK and UTF-16 queries; no SQL/FTS locale approximation.
          if (query === '') ids.push(reference.revision_digest);
          else {
            const revision = prefetched ? prefetched.get(reference.key) : this.ledger.read(reference.key, page.checkpoint);
            this.checkIndexedRevision(reference, revision);
            if (`${revision.payload.title}\n${revision.payload.body_markdown}`.toLocaleLowerCase().includes(query)) ids.push(reference.revision_digest);
          }
        }
        offset += candidates.items.length;
        if (offset >= candidates.total) break;
        if (!candidates.items.length) throw new ApiError('PROJECTION_INVALID', '검증된 원장 조회를 계속할 수 없습니다.', 503);
      }
      matches = ids; this.searchMatches.put(cacheKey, ids);
    }
    const context = this.browseContext(page.checkpoint);
    const selected = matches.slice(page.offset, page.offset + page.limit);
    this.annotate(context, [...selected]);
    const refs = selected.map(digest => this.revisionRef(digest, context));
    this.prefetchRevisionSet(context, refs);
    const results = await Promise.all(refs.map(reference => this.describeRevision(this.pageRevision(reference, context), context)));
    this.actor(actor);
    return { view: 'summary', results, total: matches.length, next_cursor: this.nextCursor(page, matches.length), checkpoint: page.checkpoint };
  }

  /**
   * 벡터 후보 검색. 벡터 색인은 후보를 제안할 뿐 자격을 결정하지 않는다 —
   * 모든 후보는 요청 체크포인트의 검증된 원장 상태로 재검증되고,
   * document_ids로 지정된 필수 참조는 색인과 무관하게 항상 원장에서 해상한다.
   * 색인이 비어 있어도 "지식이 없다"는 뜻이 아니다 — complete는 후보 수집 범위만 알린다.
   */
  async vectorSearch(actor: Actor, input: any) {
    onlyFields(input, ['query', 'document_ids', 'context_id', 'scope_id', 'usage_scope', 'limit', 'cursor']);
    if (typeof input.query !== 'string' || input.query.length > 1000) throw new ApiError('INVALID_INPUT', '검색어는 1,000자 이하여야 합니다.');
    for (const field of ['context_id', 'scope_id', 'usage_scope']) if (input[field] !== undefined && (typeof input[field] !== 'string' || input[field].length > 100)) throw new ApiError('INVALID_INPUT', '올바른 검색 범위가 필요합니다.');
    if (input.document_ids !== undefined && (!Array.isArray(input.document_ids) || input.document_ids.length > 50 || input.document_ids.some((id: unknown) => typeof id !== 'string' || !ID.test(id)))) throw new ApiError('INVALID_INPUT', '올바른 문서 참조 목록이 필요합니다.');
    await this.refresh(); this.actor(actor);
    const filter = { query: input.query, document_ids: input.document_ids ?? null, context_id: input.context_id ?? null, scope_id: input.scope_id ?? null, usage_scope: input.usage_scope ?? null };
    const page = this.page(actor, 'vector-search', input, filter);
    const context = this.browseContext(page.checkpoint);
    const embedding = this.embedQuery(input.query);
    const scores = new Map<string, number | null>();

    // 필수 문서 참조는 벡터 색인을 거치지 않고 검증된 브라우즈 색인에서 직접 해상한다.
    for (const documentId of input.document_ids ?? []) {
      const found = this.queryBrowse({ kind: 'revisions', mode: 'document', document_id: documentId, at: page.checkpoint, offset: 0, limit: 50 });
      for (const reference of found.items) scores.set(reference.revision_digest, null);
    }

    if (this.vectorIndex) {
      // 외부 색인은 후보 제안기다 — 색인이 놓친 문서를 없다고 단정할 수 없다.
      for (const candidate of await this.vectorIndex.candidates({ embedding, context_id: input.context_id, scope_id: input.scope_id, usage_scope: input.usage_scope, limit: 200 })) {
        if (!scores.has(candidate.revision_digest)) scores.set(candidate.revision_digest, candidate.score);
      }
    } else {
      // 외부 색인이 없으면 검증된 개정본을 체크포인트에서 전수 열거해 점수를 매긴다 —
      // 색인이 아니라 원장 스캔이 후보 집합이므로 결과는 완전하다.
      let offset = 0;
      while (true) {
        const batch = this.queryBrowse({ kind: 'revisions', mode: 'all', at: page.checkpoint, offset, limit: 1000,
          context_id: input.context_id || undefined, scope_id: input.scope_id || undefined, usage_scope: input.usage_scope || undefined });
        const prefetched = this.ledger.readMany?.(batch.items.map(reference => reference.key), page.checkpoint);
        for (const reference of batch.items) {
          const revision = prefetched ? prefetched.get(reference.key) : this.ledger.read(reference.key, page.checkpoint);
          this.checkIndexedRevision(reference, revision);
          scores.set(reference.revision_digest, cosineSimilarity(embedding, this.embedRevision(revision.payload.title, revision.payload.body_markdown)));
        }
        offset += batch.items.length;
        if (offset >= batch.total) break;
        if (!batch.items.length) throw new ApiError('PROJECTION_INVALID', '검증된 원장 조회를 계속할 수 없습니다.', 503);
      }
    }

    // 색인이 제안한 다이제스트 중 체크포인트에서 검증되지 않는 것은 낡은 후보로 버린다.
    const ranked: { digest: string; score: number | null }[] = [];
    for (const [digest, score] of scores) {
      this.annotate(context, [digest]);
      if (context.annotations.get(digest)?.revision) ranked.push({ digest, score });
    }
    ranked.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.digest.localeCompare(b.digest));

    const selected = ranked.slice(page.offset, page.offset + page.limit);
    const refs = selected.map(item => this.revisionRef(item.digest, context));
    this.prefetchRevisionSet(context, refs);
    const results = await Promise.all(refs.map(async (reference, index) => ({ ...(await this.describeRevision(this.pageRevision(reference, context), context)), score: selected[index]!.score })));
    this.actor(actor);
    return { view: 'summary', results, total: ranked.length, next_cursor: this.nextCursor(page, ranked.length), checkpoint: page.checkpoint,
      candidate_source: this.vectorIndex ? 'external-index' : 'derived-scan', complete: this.vectorIndex === undefined };
  }

  async resolve(actor: Actor, input: any) {
    const started = performance.now();
    await this.refresh();
    this.actor(actor); onlyFields(input, ['document_ids', 'context_id', 'scope_id', 'usage_scope', 'query']);
    if (!Array.isArray(input.document_ids) || input.document_ids.length !== 1) throw new ApiError('INVALID_INPUT', 'v0.1에서는 정확한 문서 한 개의 사용 범위를 지정해 주세요.');
    const slot = { channel_id: this.ledger.channelId, document_id: identifier(input.document_ids[0]), context_id: identifier(input.context_id), scope_id: identifier(input.scope_id), usage_scope: input.usage_scope };
    if (typeof input.usage_scope !== 'string' || !/^[a-z][a-z0-9-]{1,40}\/v[1-9][0-9]*$/.test(input.usage_scope)) throw new ApiError('INVALID_INPUT', '버전이 있는 사용 범위가 필요합니다.');
    if (input.query !== undefined && (typeof input.query !== 'string' || input.query.length > 1000)) throw new ApiError('INVALID_INPUT', '검색어가 너무 깁니다.');
    const nonce = newId('fence');
    const fence = await this.ledger.execute(actor, { command_id: newId('command'), type: 'fence', input: { nonce } });
    if (fence.status === 'pending') throw new ApiError('FRESHNESS_UNAVAILABLE', '신선한 원장 체크포인트를 확보하지 못했습니다.', 503, true);
    const at = fence.checkpoint;
    const fenceState = this.ledger.read(domain.keyFor.fence(nonce), at);
    const fencedConfig = this.config(at);
    if (!fenceState || fenceState.nonce !== nonce || fenceState.tx_id !== at.transaction_id || fenceState.eligibility_epoch !== fence.result.eligibility_epoch || !fencedConfig) throw new ApiError('FRESHNESS_UNAVAILABLE', '신선한 원장 체크포인트를 확보하지 못했습니다.', 503, true);
    const resolved = await domain.resolveAt(async key => this.ledger.read(key, at), slot);
    await this.refresh();
    const latestEpoch = this.ledger.read(domain.keyFor.eligibilityEpoch());
    if (latestEpoch !== fence.result.eligibility_epoch) return { status: 'withheld', reason: 'FENCE_SUPERSEDED', documents: [], checkpoint: at };
    this.actor(actor);
    if (performance.now() - started > 30_000) throw new ApiError('FRESHNESS_UNAVAILABLE', '신선한 원장 체크포인트를 확보하지 못했습니다.', 503, true);
    if (!resolved.eligible || !resolved.revision || !resolved.agreement) return { status: 'withheld', reason: resolved.reason ?? 'NO_ACTIVE_AGREEMENT', documents: [], checkpoint: at };
    const { revision, agreement } = resolved;
    domain.validateRevision(revision);
    const runId = newId('run');
    const approvalDecisions = await domain.validateAgreementApprovals(async key => this.ledger.read(key, at), agreement);
    const finalConfig = this.config();
    const finalEpoch = this.ledger.read(domain.keyFor.eligibilityEpoch());
    this.actor(actor);
    if (!finalConfig || finalConfig.membership_epoch !== fencedConfig.membership_epoch || finalEpoch !== latestEpoch) return { status: 'withheld', reason: 'FENCE_SUPERSEDED', documents: [], checkpoint: at };
    if (performance.now() - started > 30_000) throw new ApiError('FRESHNESS_UNAVAILABLE', '신선한 원장 체크포인트를 확보하지 못했습니다.', 503, true);
    const manifest = {
      contract_type: 'RunContextManifest', contract_version: 1, manifest_id: newId('manifest'), run_id: runId,
      context_id: slot.context_id, scope_id: slot.scope_id, usage_scope: slot.usage_scope,
      policy_id: agreement.policy_id, policy_version: agreement.policy_version, membership_epoch: fencedConfig.membership_epoch,
      checkpoint: { mode: 'strict', checkpoint_id: newId('checkpoint'), ...at, eligibility_epoch: fenceState.eligibility_epoch },
      provided_revisions: [{ revision_digest: revision.revision_digest, purpose: 'scoped_knowledge', reference_kind: 'normative', target_context_id: slot.context_id, target_scope_id: slot.scope_id, usage_scope: slot.usage_scope, agreement_id: agreement.agreement_id }],
      approval_decisions: approvalDecisions.map(item => ({ decision_id: item.decision_id, revision_digest: item.revision_digest, proposal_id: item.proposal_id })),
      private_sources: [], retrieval_profile_id: 'retrieval-scoped-markdown-v1', authorization_snapshot_id: newId('authz'), model_egress_policy_version: 1,
    };
    this.vault.put('run', runId, actor, { manifest, slot, boot_id: this.bootId, issued_monotonic: performance.now() });
    return { status: 'provided', mode: this.ledger.mode, documents: [{ revision_digest: revision.revision_digest, title: revision.payload.title, body_markdown: revision.payload.body_markdown, agreement_id: agreement.agreement_id }], manifest, checkpoint: at };
  }

  async revalidate(actor: Actor, runId: string, input: any) {
    await this.refresh();
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
