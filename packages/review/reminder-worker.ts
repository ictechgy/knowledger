export interface ReviewReminderOptions { pollMs?: number; timeoutMs?: number; overdueAfterMs?: number; batchSize?: number }
export interface ReminderRun { scanned: number; created: number }
const bounded = (value: number, low: number, high: number) => { if (!Number.isSafeInteger(value) || value < low || value > high) throw new TypeError('Invalid review reminder options'); return value; };

/** Generates local recipient notices only; it has no external transport or approval authority. */
export class ReviewReminderWorker {
  readonly pollMs: number; readonly timeoutMs: number; readonly overdueAfterMs: number; readonly batchSize: number;
  lastError: 'REMINDER_UNAVAILABLE' | null = null;
  private generate: (now: number, signal: AbortSignal) => Promise<ReminderRun>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private flight: Promise<ReminderRun> | undefined;
  private stopped = false; private started = false;
  constructor(generate: (now: number, signal: AbortSignal) => Promise<ReminderRun>, options: ReviewReminderOptions = {}) {
    this.generate = generate; this.pollMs = bounded(options.pollMs ?? 60000, 0, 3600000);
    this.timeoutMs = bounded(options.timeoutMs ?? 10000, 10, 30000);
    this.overdueAfterMs = bounded(options.overdueAfterMs ?? 86400000, 1, 365 * 86400000);
    this.batchSize = bounded(options.batchSize ?? 50, 1, 100);
  }
  start() {
    if (this.started || this.stopped || !this.pollMs) return; this.started = true;
    const tick = async () => {
      try { await this.runOnce(); } catch { /* lastError contains only a safe code. */ }
      if (!this.stopped) { this.timer = setTimeout(tick, this.pollMs); this.timer.unref(); }
    };
    this.timer = setTimeout(tick, 0); this.timer.unref();
  }
  runOnce(now = Date.now()): Promise<ReminderRun> {
    if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999) return Promise.reject(new TypeError('Invalid reminder time'));
    if (this.stopped) return Promise.resolve({ scanned: 0, created: 0 });
    if (this.flight) return this.flight;
    const controller = new AbortController(); this.controller = controller;
    let reject!: (reason: Error) => void;
    const cancelled = new Promise<never>((_, fail) => { reject = fail; });
    const abort = () => reject(new Error('REMINDER_UNAVAILABLE'));
    controller.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const work = Promise.race([Promise.resolve().then(() => { controller.signal.throwIfAborted(); return this.generate(now, controller.signal); }), cancelled])
      .then(result => { this.lastError = null; return result; }, () => { this.lastError = 'REMINDER_UNAVAILABLE'; throw new Error('REMINDER_UNAVAILABLE'); })
      .finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); if (this.flight === work) this.flight = undefined; if (this.controller === controller) this.controller = undefined; });
    this.flight = work; return work;
  }
  async close() {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort();
    try { await this.flight; } catch { /* Cancellation and transient refresh failures do not prevent DB teardown. */ }
  }
}
