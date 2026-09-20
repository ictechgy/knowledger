import { KEY_PREFIXES } from '../domain/index.ts';
import type { Checkpoint, LedgerEvent } from '../storage/local-ledger.ts';

export const ADOPTION_MEASUREMENT_SCHEMA = 1;
const MAX_OBSERVATIONS = 1000;
const OBSERVATION_KINDS = new Set(['interpretation_mixing', 'review_question', 'disclosure_burden']);

/** 사람이 관찰해 기록하는 파일럿 항목 — 저널에서 파생할 수 없는 지표의 감사 입력이다. */
export interface AdoptionObservation {
  kind: 'interpretation_mixing' | 'review_question' | 'disclosure_burden';
  subject: string;
  at: string;
  detail?: string;
}

export interface PilotObservationLog {
  schema_version: 1;
  pilot_id: string;
  concept: string;
  workflow: string;
  observations: AdoptionObservation[];
}

export interface AgreementTiming {
  agreement_id: string;
  proposal_id: string;
  revision_digest: string;
  proposed_at: string;
  activated_at: string;
  seconds: number;
}

export interface AdoptionMeasurement {
  schema_version: 1;
  pilot: { pilot_id: string; concept: string; workflow: string };
  // window는 집계한 저널 범위를 식별한다 — 채널·시퀀스 경계·검증된 팁 해시로 어떤
  // 저널 상태를 측정했는지 아티팩트가 스스로 증명한다. 빈 저널도 channel_id는 남긴다.
  window: {
    event_count: number; first_event_at?: string; last_event_at?: string;
    channel_id?: string; first_sequence?: number; last_sequence?: number; tip_hash?: string;
    /** Exact VALID transaction bounds in Fabric mode; the full journal tip is source.checkpoint. */
    first_checkpoint?: Checkpoint; last_checkpoint?: Checkpoint;
  };
  /** Present only for offline Fabric projection measurements; this is not live peer authentication. */
  source?: {
    kind: 'fabric-projection'; verification: 'offline-full-block-replay';
    channel_id: string; chaincode_name: string; chaincode_version: string; genesis_digest: string;
    block_count: number; valid_transaction_count: number; invalid_transaction_count: number;
    journal_digest: string;
    checkpoint: { channel_id: string; block_number: number; block_hash: string; data_hash: string };
  };
  // evidence는 집계에 쓴 관찰 입력의 신원이다 — 같은 건수라도 다른 로그면 구별된다.
  evidence?: { observations_sha256?: string; observations_bytes?: number };
  derived: {
    time_to_agreement: { count: number; median_seconds?: number; samples: AgreementTiming[] };
    review_effort: {
      proposals: number; decisions: number; approvals: number; objections: number;
      retractions: number; withdrawals: number; revisions_published: number;
    };
    reuse_rate: {
      revisions_published: number; revisions_with_dependencies: number;
      dependency_references: number; distinct_reused_digests: number; ratio?: number;
    };
  };
  observed: { interpretation_mixing_incidents: number; review_questions: number; disclosure_burden_notes: number };
}

export class AdoptionInputError extends Error {
  readonly code = 'INVALID_ADOPTION_INPUT';
  constructor(message = '파일럿 측정 입력이 올바르지 않습니다.') { super(message); this.name = 'AdoptionInputError'; }
}

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new AdoptionInputError();
  return value;
}

// RFC 3339 timestamp만 허용한다 — Date.parse는 비ISO 형식과 존재하지 않는 날짜의
// 롤오버도 받아들이므로 형식과 필드 범위를 직접 검증한다. 윤초(:60)는 Date.parse가
// 지원하지 않으므로 이 형식의 부분집합이다 — 관찰 기록에는 윤초가 필요하지 않다.
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|z|([+-])(\d{2}):(\d{2}))$/u;

function isoTime(value: unknown): string {
  if (typeof value !== 'string') throw new AdoptionInputError();
  const match = ISO_PATTERN.exec(value);
  if (!match) throw new AdoptionInputError();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  // 월 길이는 그레고리 규칙으로 직접 계산한다 — Date.UTC는 0~99년을 1900년대로
  // 리매핑해 0000년 같은 연도의 윤년 판정을 잘못한다.
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lastDay = month === 2 ? (leap ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  const fieldsValid = month >= 1 && month <= 12 && day >= 1 && day <= lastDay && hour <= 23 && minute <= 59 && second <= 59;
  const offsetValid = match[7].length === 1 || (Number(match[9]) <= 23 && Number(match[10]) <= 59);
  if (!fieldsValid || !offsetValid || Number.isNaN(Date.parse(value))) throw new AdoptionInputError();
  return value;
}

/** 파일럿 관찰 로그를 엄격히 검증한다 — 관찰 항목은 감사 입력이므로 형식을 고정한다. */
export function validateObservationLog(input: unknown): PilotObservationLog {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AdoptionInputError();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'concept,observations,pilot_id,schema_version,workflow' || value.schema_version !== 1
    || !Array.isArray(value.observations) || value.observations.length > MAX_OBSERVATIONS) throw new AdoptionInputError();
  const observations = value.observations.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AdoptionInputError();
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).sort().join(',');
    if (keys !== 'at,kind,subject' && keys !== 'at,detail,kind,subject') throw new AdoptionInputError();
    if (typeof record.kind !== 'string' || !OBSERVATION_KINDS.has(record.kind)) throw new AdoptionInputError();
    const observation: AdoptionObservation = { kind: record.kind as AdoptionObservation['kind'], subject: boundedText(record.subject, 200), at: isoTime(record.at) };
    if (record.detail !== undefined) observation.detail = boundedText(record.detail, 2000);
    return observation;
  });
  return { schema_version: 1, pilot_id: boundedText(value.pilot_id, 128), concept: boundedText(value.concept, 200), workflow: boundedText(value.workflow, 200), observations };
}

function recordOf(write: [string, unknown]): { key: string; value: any } {
  const [key, value] = write;
  return { key, value: value && typeof value === 'object' ? value : {} };
}

function median(sorted: number[]): number | undefined {
  if (!sorted.length) return undefined;
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 검증된 저널 이벤트와 관찰 로그에서 파일럿 지표를 계산한다.
 * 저널 파생분(합의 시간·검토 수고·재사용)은 도메인 기록의 타임스탬프와 결정 종류를 그대로 쓰고,
 * 사람 관찰분(해석 혼합·공개 부담)은 관찰 로그의 건수만 집계한다.
 * 이 결과는 한 파일럿의 측정 기록이며 일반화된 운영 지표나 SLA가 아니다.
 * 주의: 저널 이벤트에는 파일럿 식별자가 없어 전달된 범위 전체를 이 파일럿의 기록으로
 * 집계한다 — 파일럿 전용으로 처음부터 기록한 저널을 준비하는 것이 계약이며,
 * 결과의 window 필드가 실제 집계 범위를 보고한다.
 */
export function measureAdoption(input: { events: Iterable<LedgerEvent>; log: PilotObservationLog; channel_id?: string; evidence?: AdoptionMeasurement['evidence'] }): AdoptionMeasurement {
  const log = validateObservationLog(input?.log);
  const events = input?.events;
  if (!events || typeof events[Symbol.iterator] !== 'function') throw new AdoptionInputError();
  let first: LedgerEvent | undefined;
  let last: LedgerEvent | undefined;
  let eventCount = 0;
  const proposals = new Map<string, any>();
  const timings: AgreementTiming[] = [];
  const agreementsSeen = new Set<string>();
  const agreementStatus = new Map<string, string>();
  const decisionsSeen = new Set<string>();
  const reusedDigests = new Set<string>();
  let revisions = 0;
  let revisionsWithDependencies = 0;
  let dependencyReferences = 0;
  let decisions = 0, approvals = 0, objections = 0, retractions = 0, withdrawals = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.writes)) throw new AdoptionInputError();
    first ??= event;
    last = event;
    eventCount += 1;
    for (const write of event.writes) {
      const { key, value } = recordOf(write as [string, unknown]);
      if (key.startsWith(`${KEY_PREFIXES.proposal}:`) && value.record_type === 'AgreementProposal' && typeof value.proposal_id === 'string' && !proposals.has(value.proposal_id)) {
        proposals.set(value.proposal_id, value);
      } else if (key.startsWith(`${KEY_PREFIXES.agreement}:`) && typeof value.agreement_id === 'string' && typeof value.status === 'string') {
        const previous = agreementStatus.get(value.agreement_id);
        agreementStatus.set(value.agreement_id, value.status);
        if (value.status === 'active' && !agreementsSeen.has(value.agreement_id)) {
          const proposal = proposals.get(value.proposal_id);
          // 명시된 제안 시각과 활성화 시각이 둘 다 있을 때만 표본으로 삼는다 — 빠진
          // 필드를 이벤트 시각으로 대체하면 지어낸 0초 표본이 중앙값을 오염시킨다.
          if (typeof proposal?.created_at === 'string' && typeof value.activated_at === 'string') {
            const seconds = (Date.parse(value.activated_at) - Date.parse(proposal.created_at)) / 1000;
            // 유효한 샘플을 수용할 때만 활성화 슬롯을 소모한다 — 시각이 없는 레코드가
            // 이후 유효한 활성화 기록을 억제하지 않는다.
            if (Number.isFinite(seconds) && seconds >= 0) {
              agreementsSeen.add(value.agreement_id);
              timings.push({ agreement_id: value.agreement_id, proposal_id: value.proposal_id, revision_digest: value.revision_digest, proposed_at: proposal.created_at, activated_at: value.activated_at, seconds });
            }
          }
        // 철회·중지는 상태 스냅샷이 아니라 전이로 센다 — 같은 상태의 재기록은 새 철회가 아니다.
        } else if ((value.status === 'withdrawn' || value.status === 'suspended') && previous !== value.status) {
          withdrawals += 1;
        }
      } else if (key.startsWith(`${KEY_PREFIXES.decision}:`) && value.contract_type === 'ApprovalDecision') {
        // 불변 결정의 재기록은 저널 키로 한 번만 센다.
        if (decisionsSeen.has(key)) continue;
        decisionsSeen.add(key);
        decisions += 1;
        if (value.decision === 'approve') approvals += 1;
        else if (value.decision === 'object') objections += 1;
        else if (value.decision === 'retract') retractions += 1;
      } else if (key.startsWith(`${KEY_PREFIXES.revision}:`) && value.payload?.contract_type === 'DocumentRevision') {
        // 같은 다이제스트의 불변 재기록은 한 번만 센다.
        if (reusedDigests.has(`self:${value.revision_digest}`)) continue;
        reusedDigests.add(`self:${value.revision_digest}`);
        revisions += 1;
        const dependencies = Array.isArray(value.payload.dependencies) ? value.payload.dependencies : [];
        if (dependencies.length) revisionsWithDependencies += 1;
        dependencyReferences += dependencies.length;
        for (const dependency of dependencies) if (typeof dependency?.revision_digest === 'string') reusedDigests.add(dependency.revision_digest);
      }
    }
  }
  const sortedSeconds = timings.map(timing => timing.seconds).sort((a, b) => a - b);
  const observed = { interpretation_mixing_incidents: 0, review_questions: 0, disclosure_burden_notes: 0 };
  for (const observation of log.observations) {
    if (observation.kind === 'interpretation_mixing') observed.interpretation_mixing_incidents += 1;
    else if (observation.kind === 'review_question') observed.review_questions += 1;
    else observed.disclosure_burden_notes += 1;
  }
  // 채널은 이벤트 유무와 무관하게 남긴다 — 빈 측정도 어떤 채널의 것인지 구별된다.
  const channelId = input.channel_id ?? first?.checkpoint?.channel_id;
  return {
    schema_version: ADOPTION_MEASUREMENT_SCHEMA,
    pilot: { pilot_id: log.pilot_id, concept: log.concept, workflow: log.workflow },
    window: {
      event_count: eventCount,
      ...(channelId !== undefined ? { channel_id: channelId } : {}),
      ...(first && last ? {
        first_event_at: first.timestamp, last_event_at: last.timestamp,
        // 검증된 저널 범위의 신원 — 시퀀스 경계와 말단 블록 해시를 그대로 보고한다.
        first_sequence: first.checkpoint?.block_number,
        last_sequence: last.checkpoint?.block_number,
        tip_hash: last.checkpoint?.block_hash,
      } : {}),
    },
    ...(input.evidence ? { evidence: input.evidence } : {}),
    derived: {
      time_to_agreement: { count: timings.length, median_seconds: median(sortedSeconds), samples: timings },
      review_effort: { proposals: proposals.size, decisions, approvals, objections, retractions, withdrawals, revisions_published: revisions },
      reuse_rate: {
        revisions_published: revisions,
        revisions_with_dependencies: revisionsWithDependencies,
        dependency_references: dependencyReferences,
        distinct_reused_digests: [...reusedDigests].filter(digest => !digest.startsWith('self:')).length,
        ...(revisions ? { ratio: revisionsWithDependencies / revisions } : {}),
      },
    },
    observed,
  };
}
