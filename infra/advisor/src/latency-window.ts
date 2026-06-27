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
// percentiles over them. Lost on restart (the advisor's whole registry is),
// which is fine — these are "typical RECENT latency" headlines, not an SLA
// ledger, and they repopulate within a handful of jobs.

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
}

export class LatencyWindow {
  private readonly samples: number[] = [];
  private readonly capacity: number;

  constructor(capacity = 100) {
    this.capacity = Math.max(1, capacity);
  }

  /** Record one latency sample (ms). Non-finite or negative values are
   *  dropped — a clock skew or a malformed timing shouldn't poison the
   *  median. Oldest sample falls off once the window is full. */
  record(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.samples.push(ms);
    if (this.samples.length > this.capacity) this.samples.shift();
  }

  stats(): LatencyStats {
    const n = this.samples.length;
    if (n === 0) return { sampleCount: 0, p50Ms: null, p95Ms: null, avgMs: null, lastMs: null };
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
    };
  }
}
