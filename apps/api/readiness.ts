import { performance } from 'node:perf_hooks';

/** Observational readiness, never authority for knowledge freshness/eligibility. */
export class ReadinessMonitor {
  private pending: Promise<void> | undefined;
  private nextProbe = 0;
  private sample: { healthy: boolean; started: number } | undefined;
  private closed = false;
  private readonly refresh: () => Promise<void>;
  private readonly now: () => number;

  constructor(refresh: () => Promise<void>, now: () => number = () => performance.now()) { this.refresh = refresh; this.now = now; }

  read() {
    const now = this.now();
    if (!this.closed && !this.pending && now >= this.nextProbe) {
      this.nextProbe = now + 1000;
      // At most one probe regardless of caller count, including a stuck peer.
      // HTTP requests never wait for this promise or enqueue another probe.
      this.pending = Promise.resolve().then(() => { if (!this.closed) return this.refresh(); }).then(
        () => { this.sample = { healthy: true, started: now }; },
        () => { this.sample = { healthy: false, started: now }; },
      ).finally(() => { this.pending = undefined; });
    }
    const age = this.sample ? Math.max(0, now - this.sample.started) : null;
    const healthy = !this.closed && this.sample?.healthy === true && age !== null && age <= 5000;
    return { status: healthy ? 'ok' : 'unavailable', healthy, state: healthy ? 'ready' : 'not-ready', sample_age_ms: age };
  }

  close(): void { this.closed = true; }
}
