import { DeliveryError, validateReviewReceipt } from './delivery-contract.ts';
import type { ReviewReceipt } from './delivery-contract.ts';
import type { DeliveryJob, ReviewDeliveryStore } from '../storage/review-delivery-store.ts';

export interface DeliveryWorkerOptions { timeoutMs?: number; pollMs?: number; maxAttempts?: number; retryBaseMs?: number }
const integer = (value: number, min: number, max: number) => { if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError('Invalid review delivery worker options'); return value; };

/** At-least-once delivery: receipt loss can resend the same ID. Receiver deduplication is required. */
export class ReviewDeliveryWorker {
  private store: ReviewDeliveryStore;
  private deliver: (job: DeliveryJob, signal: AbortSignal) => Promise<ReviewReceipt>;
  private timeoutMs: number; private pollMs: number; private maxAttempts: number; private retryBaseMs: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private flight: Promise<number> | undefined;
  private stopped = false;
  private started = false;
  lastError: 'DELIVERY_WORKER_UNAVAILABLE' | null = null;
  constructor(store: ReviewDeliveryStore, deliver: (job: DeliveryJob, signal: AbortSignal) => Promise<ReviewReceipt>, options: DeliveryWorkerOptions = {}) {
    this.store = store; this.deliver = deliver;
    this.timeoutMs = integer(options.timeoutMs ?? 10000, 10, 30000);
    this.pollMs = integer(options.pollMs ?? 1000, 0, 60000);
    this.maxAttempts = integer(options.maxAttempts ?? 5, 1, 10);
    this.retryBaseMs = integer(options.retryBaseMs ?? 1000, 1, 60000);
  }
  start() {
    if (this.started || this.stopped || this.pollMs === 0) return;
    this.started = true;
    const tick = async () => {
      try { await this.runOnce(); this.lastError = null; } catch { this.lastError = 'DELIVERY_WORKER_UNAVAILABLE'; }
      if (!this.stopped) { this.timer = setTimeout(tick, this.pollMs); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  runOnce(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.flight) return this.flight;
    const task = this.drain(); this.flight = task;
    void task.finally(() => { if (this.flight === task) this.flight = undefined; }).catch(() => undefined);
    return task;
  }
  private async drain() {
    let processed = 0; const attempted: string[] = [];
    while (!this.stopped && processed < 20) {
      const job = this.store.claim(Date.now(), this.timeoutMs + 5000, this.maxAttempts, attempted);
      if (!job) break;
      processed++;
      attempted.push(job.packet.message.delivery_id);
      const controller = new AbortController(); this.controller = controller;
      let onAbort!: () => void;
      const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new DeliveryError(this.stopped ? 'DELIVERY_SHUTDOWN' : 'DELIVERY_TIMEOUT', 503, true)); controller.signal.addEventListener('abort', onAbort, { once: true }); });
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const receipt = validateReviewReceipt(await Promise.race([this.deliver(structuredClone(job), controller.signal), interrupted]), job.packet);
        this.store.settle(job, 'delivered', Date.now(), null, receipt);
      } catch (error) {
        // Transport/provider diagnostics may contain credentials or bodies; persist only our bounded codes.
        const known = error instanceof DeliveryError;
        const retryable = known ? error.retryable : true;
        const code = known && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'DELIVERY_UNAVAILABLE';
        const status = !retryable ? 'blocked' : job.attempts >= this.maxAttempts ? 'failed' : 'pending';
        const next = Date.now() + Math.min(3600000, this.retryBaseMs * 2 ** (job.attempts - 1));
        this.store.settle(job, status, next, code);
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
        if (this.controller === controller) this.controller = undefined;
      }
    }
    return processed;
  }
  async close() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort();
    await this.flight;
  }
}
