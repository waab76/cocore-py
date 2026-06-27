// Advisor-specific metric instruments. Plain Effect `Metric`s, exported to
// OTLP when the runtime's layer includes the metric reader and a no-op cost
// otherwise (see @cocore/o11y). Keep tag dimensions low-cardinality — never
// tag with a DID, machine id, session id, or anything per-request.

import { Metric, MetricBoundaries } from "effect";

/** How many providers are currently connected + online (registry size).
 *  Updated on a periodic sweep. */
export const onlineProviders = Metric.gauge("cocore.advisor.providers.online", {
  description: "providers currently registered + online",
});

/** Job-dispatch attempts tagged by outcome. */
const dispatch = Metric.counter("cocore.advisor.dispatch", {
  description: "job dispatch attempts by outcome",
});

/** Counter for one dispatch outcome:
 *   - "ok"          — a provider was selected and the inference frame sent
 *   - "no-capacity" — no attested/responsive provider available (503)
 *   - "rejected"    — the request was malformed / invalid (4xx) */
export function dispatchOutcome(outcome: "ok" | "no-capacity" | "rejected") {
  return dispatch.pipe(Metric.tagged("outcome", outcome));
}

/** Time-to-first-token in ms (job received → first chunk relayed). Boundaries
 *  cover sub-ms to ~1min, matching the rolling LatencyWindow the /ttft route
 *  serves. */
export const ttftMs = Metric.histogram(
  "cocore.advisor.ttft_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 }),
  "time-to-first-token in milliseconds",
);

/** Time-to-ack in ms (job received → `inference_request` frame handed to the
 *  chosen provider's socket). The brokerage latency — picking a live worker and
 *  getting the job to it, incl. the preflight liveness round-trip, excluding the
 *  worker's own model-load/prefill/generation. Same boundaries as ttftMs;
 *  matches the rolling LatencyWindow the /ack route serves. */
export const ackMs = Metric.histogram(
  "cocore.advisor.ack_ms",
  MetricBoundaries.exponential({ start: 1, factor: 2, count: 16 }),
  "time-to-ack in milliseconds",
);
