// Rolling latency window.
//
// A tiny in-memory ring of the last `capacity` millisecond samples, with
// percentile/avg/last readouts. The advisor uses it for the two user-facing
// latency headlines it can measure first-hand:
//
//   * time-to-ack  — (job received → `inference_request` frame handed to the
//     chosen provider's socket). The brokerage number: how fast cocore picks a
//     live worker and gets the job to it, including the preflight liveness
//     round-trip. Excludes everything the worker then does.
//   * TTFT         — (job received → first `inference_chunk` relayed back).
//     The end-to-end "how fast does it START responding" number, which folds in
//     the worker's model-load + prefill + first-token generation.
//
// In-memory, rolling: we keep the last `capacity` samples and report
// percentiles over them. The window can be HYDRATED from a disk snapshot at
// startup (see latency-store.ts) so the headline isn't blank after a restart
// — the advisor's registry repopulates within seconds, but the latency
// numbers only refill once jobs flow, and a mounted volume lets us serve the
// last known figures in the meantime. Until a live sample arrives, hydrated
// readouts are flagged `cached` so callers can tell stale-from-disk apart
// from fresh traffic. These remain "typical RECENT latency" headlines, not an
// SLA ledger.

export interface LatencyStats {
  /** Samples currently in the window (≤ capacity). */
  sampleCount: number;
  /** Median latency in ms, or null when there are no samples. */
  p50Ms: number | null;
  /** 95th-percentile latency in ms, or null when there are no samples. */
  p95Ms: number | null;
  /** Mean latency in ms, or null when there are no samples. */
  avgMs: number | null;
  /** The most recent sample's latency in ms, or null. */
  lastMs: number | null;
  /** True when every sample in the window came from a persisted snapshot and
   *  no live sample has landed since this process started — i.e. the readout
   *  is being served from the disk cache after a restart. False when there
   *  are no samples, or once any fresh sample is recorded. */
  cached: boolean;
}

export class LatencyWindow {
  private readonly samples: number[] = [];
  private readonly capacity: number;
  /** Has a live `record()` landed since construction? Starts false and flips
   *  true on the first real sample, so a window hydrated from disk reports
   *  `cached: true` only until fresh traffic arrives. */
  private hasFreshSample = false;

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity);
  }

  /** Record one latency sample (ms). Non-finite or negative values are
   *  dropped — a clock skew or a malformed timing shouldn't poison the
   *  median. Oldest sample falls off once the window is full. */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.hasFreshSample = true;
    this.samples.push(ms);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  /** Seed the window from a persisted snapshot at startup. Same validation
   *  and capacity bound as `record()`, but these samples do NOT count as
   *  fresh — the readout stays `cached` until a live `record()` arrives.
   *  Intended to be called once, before any live traffic. */
  hydrate(samples: readonly number[]): void {
    for (const ms of samples) {
      if (!Number.isFinite(ms) || ms < 0) continue;
      this.samples.push(ms);
      if (this.samples.length > this.capacity) this.samples.shift();
    }
  }

  /** A copy of the current samples, oldest-first — for persisting to disk. */
  snapshot(): number[] {
    return [...this.samples];
  }

  stats(): LatencyStats {
    const n = this.samples.length;
    if (n === 0) {
      return { sampleCount: 0, p50Ms: null, p95Ms: null, avgMs: null, lastMs: null, cached: false };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number): number => {
      // Nearest-rank percentile over the sorted window.
      const idx = Math.min(n - 1, Math.max(0, Math.ceil((p / 100) * n) - 1));
      return sorted[idx]!;
    };
    const sum = this.samples.reduce((a, b) => a + b, 0);
    return {
      sampleCount: n,
      p50Ms: pct(50),
      p95Ms: pct(95),
      avgMs: Math.round(sum / n),
      lastMs: this.samples[n - 1]!,
      cached: !this.hasFreshSample,
    };
  }
}
