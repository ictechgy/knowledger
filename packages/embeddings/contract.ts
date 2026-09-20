import { canonicalize } from '../domain/index.ts';
import { createHash } from 'node:crypto';
import type { Actor, Slot } from '../domain/index.ts';
import type { Checkpoint } from '../storage/local-ledger.ts';

export interface EmbeddingProfile {
  id: string; provider: string; model: string; dimensions: number;
  endpoint: string; preprocessing: 'title-newline-body/v1';
}
export interface EmbeddingProvider {
  readonly profile: Readonly<EmbeddingProfile>;
  embed(text: string, options: { signal: AbortSignal; beforeSend: () => Promise<void> }): Promise<readonly number[]>;
}
export interface EmbeddingTarget {
  kind: 'query' | 'revision'; checkpoint: Checkpoint;
  scope: { context_id: string | null; scope_id: string | null; usage_scope: string | null };
  revision?: { revision_digest: string; slot: Slot };
}
export interface EmbeddingPolicyRequest extends EmbeddingTarget {
  actor: Actor; profile: Readonly<EmbeddingProfile>; profile_digest: string;
  policy_version: number; input_bytes: number; phase: 'before-provider' | 'before-send' | 'after-result' | 'cache'; signal: AbortSignal;
}
export interface EmbeddingOptions {
  provider: EmbeddingProvider;
  /** Only strict true authorizes this input. Omission denies embedding calls and cached-vector reuse. */
  allows?: (request: EmbeddingPolicyRequest) => boolean | Promise<boolean>;
  policyVersion?: number; timeoutMs?: number; maxCalls?: number; maxConcurrent?: number;
}
const failures = {
  EMBEDDING_EGRESS_DENIED: [403, false], EMBEDDING_AUTHORIZATION_DENIED: [403, false],
  EMBEDDING_POLICY_UNAVAILABLE: [503, true], EMBEDDING_UNAVAILABLE: [503, true],
  EMBEDDING_TIMEOUT: [503, true], EMBEDDING_ABORTED: [503, true],
  EMBEDDING_INPUT_TOO_LARGE: [413, false], EMBEDDING_INVALID_INPUT: [400, false],
  EMBEDDING_INVALID_RESPONSE: [502, false], EMBEDDING_PROVIDER_REJECTED: [502, false],
  EMBEDDING_RATE_LIMITED: [429, true], EMBEDDING_CREDENTIAL_UNAVAILABLE: [503, true],
  EMBEDDING_BUDGET_EXCEEDED: [422, false], EMBEDDING_BUSY: [503, true],
} as const;
export class EmbeddingError extends Error {
  readonly code: keyof typeof failures; readonly status: number; readonly retryable: boolean;
  constructor(code: keyof typeof failures) {
    super('임베딩 요청의 전송 허용, 입력 한도 또는 공급자 응답을 확인할 수 없습니다.');
    this.code = Object.hasOwn(failures, code) ? code : 'EMBEDDING_UNAVAILABLE';
    [this.status, this.retryable] = failures[this.code];
  }
}
export function embeddingProfile(input: EmbeddingProfile): Readonly<EmbeddingProfile> {
  if (!input || typeof input.id !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(input.id)
    || typeof input.provider !== 'string' || !/^[a-z][a-z0-9_-]{1,40}$/.test(input.provider)
    || typeof input.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(input.model)
    || !Number.isSafeInteger(input.dimensions) || input.dimensions < 1 || input.dimensions > 4096
    || input.preprocessing !== 'title-newline-body/v1') throw new TypeError('Invalid embedding profile');
  let url: URL;
  try { if (typeof input.endpoint !== 'string') throw new Error(); url = new URL(input.endpoint); }
  catch { throw new TypeError('Invalid embedding endpoint'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || (url.protocol === 'http:' && !['127.0.0.1', '[::1]'].includes(url.hostname))) throw new TypeError('Invalid embedding endpoint');
  return Object.freeze({ id: input.id, provider: input.provider, model: input.model, dimensions: input.dimensions, endpoint: url.href, preprocessing: input.preprocessing });
}
export const embeddingProfileDigest = (profile: EmbeddingProfile) => `sha256:${createHash('sha256').update(canonicalize(embeddingProfile(profile))).digest('hex')}`;
export function validateEmbedding(value: unknown, dimensions: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== dimensions || !value.some(v => v !== 0)) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE');
  for (let i = 0; i < value.length; i++) if (typeof value[i] !== 'number' || !Number.isFinite(value[i])) throw new EmbeddingError('EMBEDDING_INVALID_RESPONSE');
  return Object.freeze([...value]);
}
export function embeddingBound(value: number, low: number, high: number): number {
  if (!Number.isSafeInteger(value) || value < low || value > high) throw new TypeError('Invalid embedding limits'); return value;
}
