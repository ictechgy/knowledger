import { KEY_PREFIXES } from '../domain/index.ts';
import type { LedgerEvent } from '../storage/local-ledger.ts';

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
  window: { event_count: number; first_event_at?: string; last_event_at?: string };
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

function isoTime(value: unknown): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new AdoptionInputError();
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
 */
export function measureAdoption(input: { events: LedgerEvent[]; log: PilotObservationLog }): AdoptionMeasurement {
  const log = validateObservationLog(input?.log);
  const events = input?.events;
  if (!Array.isArray(events)) throw new AdoptionInputError();
  const proposals = new Map<string, any>();
  const timings: AgreementTiming[] = [];
  const agreementsSeen = new Set<string>();
  const reusedDigests = new Set<string>();
  let revisions = 0;
  let revisionsWithDependencies = 0;
  let dependencyReferences = 0;
  let decisions = 0, approvals = 0, objections = 0, retractions = 0, withdrawals = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object' || !Array.isArray(event.writes)) throw new AdoptionInputError();
    for (const write of event.writes) {
      const { key, value } = recordOf(write as [string, unknown]);
      if (key.startsWith(`${KEY_PREFIXES.proposal}:`) && value.record_type === 'AgreementProposal' && typeof value.proposal_id === 'string' && !proposals.has(value.proposal_id)) {
        proposals.set(value.proposal_id, value);
      } else if (key.startsWith(`${KEY_PREFIXES.agreement}:`) && value.status === 'active' && typeof value.agreement_id === 'string' && !agreementsSeen.has(value.agreement_id)) {
        agreementsSeen.add(value.agreement_id);
        const proposal = proposals.get(value.proposal_id);
        const proposedAt = proposal?.created_at ?? event.timestamp;
        const activatedAt = typeof value.activated_at === 'string' ? value.activated_at : event.timestamp;
        const seconds = (Date.parse(activatedAt) - Date.parse(proposedAt)) / 1000;
        if (Number.isFinite(seconds) && seconds >= 0) {
          timings.push({ agreement_id: value.agreement_id, proposal_id: value.proposal_id, revision_digest: value.revision_digest, proposed_at: proposedAt, activated_at: activatedAt, seconds });
        }
      } else if (key.startsWith(`${KEY_PREFIXES.decision}:`) && value.contract_type === 'ApprovalDecision') {
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
      } else if (key.startsWith(`${KEY_PREFIXES.agreement}:`) && (value.status === 'withdrawn' || value.status === 'suspended')) {
        withdrawals += 1;
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
  return {
    schema_version: ADOPTION_MEASUREMENT_SCHEMA,
    pilot: { pilot_id: log.pilot_id, concept: log.concept, workflow: log.workflow },
    window: {
      event_count: events.length,
      ...(events.length ? { first_event_at: events[0].timestamp, last_event_at: events[events.length - 1].timestamp } : {}),
    },
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
