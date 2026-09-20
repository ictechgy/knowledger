import { performance } from 'node:perf_hooks';
import type { Actor } from '../domain/index.ts';
import { EmbeddingError, embeddingBound, embeddingProfile, embeddingProfileDigest, validateEmbedding } from './contract.ts';
import type { EmbeddingOptions, EmbeddingProfile, EmbeddingTarget, EmbeddingPolicyRequest, EmbeddingProvider } from './contract.ts';

export interface EmbeddingOperation {
  check(): void;
  authorize(): Promise<void>;
  embed(text: string, target: EmbeddingTarget): Promise<readonly number[]>;
  checkTarget(target: EmbeddingTarget, inputBytes: number): Promise<void>;
}
/** Guarded provider path. Legacy caller-owned functions remain a separate trusted extension. */
export class EmbeddingRuntime {
  readonly profile: Readonly<EmbeddingProfile>; readonly profileDigest: string;
  private provider: EmbeddingProvider; private allows: EmbeddingOptions['allows'];
  private authorize: (actor: Actor, signal: AbortSignal) => Promise<void>;
  private timeoutMs: number; private maxCalls: number; private maxConcurrent: number; private policyVersion: number;
  private cache = new Map<string, readonly number[]>();
  private active = new Map<AbortController, Promise<unknown>>();
  private stopped = false;
  constructor(options: EmbeddingOptions, authorize: (actor: Actor, signal: AbortSignal) => Promise<void>) {
    this.profile = embeddingProfile(options.provider?.profile); this.profileDigest = embeddingProfileDigest(this.profile);
    if (typeof options.provider.embed !== 'function' || (options.allows !== undefined && typeof options.allows !== 'function')) throw new TypeError('Invalid embedding provider or policy');
    this.provider = { profile: this.profile, embed: options.provider.embed.bind(options.provider) }; this.allows = options.allows; this.authorize = authorize;
    this.timeoutMs = embeddingBound(options.timeoutMs ?? 30000, 10, 120000);
    this.maxCalls = embeddingBound(options.maxCalls ?? 128, 1, 10000);
    this.maxConcurrent = embeddingBound(options.maxConcurrent ?? 4, 1, 32);
    this.policyVersion = embeddingBound(options.policyVersion ?? 1, 1, Number.MAX_SAFE_INTEGER);
  }
  async run<T>(actor: Actor, signal: AbortSignal | undefined, operation: (scope: EmbeddingOperation) => Promise<T>): Promise<T> {
    if (this.stopped || signal?.aborted) throw new EmbeddingError('EMBEDDING_ABORTED');
    if (this.active.size >= this.maxConcurrent) throw new EmbeddingError('EMBEDDING_BUSY');
    const controller = new AbortController(); const deadline = performance.now() + this.timeoutMs;
    let timedOut = false; let calls = 0; let rejectAbort!: (error: EmbeddingError) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const abort = () => controller.abort();
    const check = () => {
      if (performance.now() >= deadline || timedOut) throw new EmbeddingError('EMBEDDING_TIMEOUT');
      if (this.stopped || controller.signal.aborted) throw new EmbeddingError('EMBEDDING_ABORTED');
    };
    const onAbort = () => rejectAbort(new EmbeddingError(timedOut ? 'EMBEDDING_TIMEOUT' : 'EMBEDDING_ABORTED'));
    controller.signal.addEventListener('abort', onAbort, { once: true }); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const authorize = async () => {
      check();
      try { await this.authorize({ ...actor }, controller.signal); }
      catch (error: any) { check(); throw new EmbeddingError(error?.status >= 400 && error?.status < 500 ? 'EMBEDDING_AUTHORIZATION_DENIED' : 'EMBEDDING_UNAVAILABLE'); }
      check();
    };
    const gate = async (target: EmbeddingTarget, inputBytes: number, phase: EmbeddingPolicyRequest['phase']) => {
      check(); if (!this.allows) throw new EmbeddingError('EMBEDDING_EGRESS_DENIED');
      await authorize();
      let allowed;
      try { allowed = await this.allows({ ...structuredClone(target), actor: { ...actor }, profile: { ...this.profile }, profile_digest: this.profileDigest,
        policy_version: this.policyVersion, input_bytes: inputBytes, phase, signal: controller.signal }); }
      catch { check(); throw new EmbeddingError('EMBEDDING_POLICY_UNAVAILABLE'); }
      check(); if (allowed !== true) throw new EmbeddingError('EMBEDDING_EGRESS_DENIED');
      await authorize();
    };
    const scope: EmbeddingOperation = { check, authorize,
      checkTarget: (target, bytes) => gate(target, bytes, 'after-result'),
      embed: async (text, target) => {
        check();
        if (typeof text !== 'string' || !text.trim() || /[\uD800-\uDFFF]/u.test(text)) throw new EmbeddingError('EMBEDDING_INVALID_INPUT');
        const bytes = Buffer.byteLength(text); if (bytes > 512 * 1024) throw new EmbeddingError('EMBEDDING_INPUT_TOO_LARGE');
        const key = target.kind === 'revision' && target.revision ? `${this.profileDigest}:${target.revision.revision_digest}` : null;
        const cached = key ? this.cache.get(key) : undefined;
        await gate(target, bytes, cached ? 'cache' : 'before-provider');
        if (cached) { check(); this.cache.delete(key!); this.cache.set(key!, cached); return [...cached]; }
        if (calls >= this.maxCalls) throw new EmbeddingError('EMBEDDING_BUDGET_EXCEEDED'); calls++;
        let value;
        try { value = await this.provider.embed(text, { signal: controller.signal, beforeSend: () => gate(target, bytes, 'before-send') }); }
        catch (error) { check(); if (error instanceof EmbeddingError) throw error; throw new EmbeddingError('EMBEDDING_UNAVAILABLE'); }
        check(); const vector = validateEmbedding(value, this.profile.dimensions);
        await gate(target, bytes, 'after-result'); check();
        if (key) { if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!); this.cache.set(key, vector); }
        return [...vector];
      },
    };
    const work = Promise.resolve().then(() => { check(); return operation(scope); });
    const result = Promise.race([work, aborted]); this.active.set(controller, result);
    try { const value = await result; check(); return value; }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); controller.abort(); this.active.delete(controller); }
  }
  async close() {
    this.stopped = true; const running = [...this.active.values()]; for (const controller of this.active.keys()) controller.abort();
    await Promise.allSettled(running); this.cache.clear();
  }
}
