// Shared, cross-cutting metric instruments.
//
// Plain Effect `Metric`s. When a service runs effects through a runtime
// whose layer includes the OTLP `metricReader` (see tracing.ts), Effect
// exports them automatically; otherwise they accumulate in-process and are
// never read — a no-op cost.
//
// Record by piping an effect through `Metric.increment(...)` /
// `Metric.update(...)`. Tag dimensions (`outcome`, `direction`) must stay
// low-cardinality — never tag with a DID, URI, or anything per-request.

import { Metric } from "effect";

/** Receipts observed and indexed off the firehose. */
export const receiptsIndexed = Metric.counter("cocore.receipts.indexed", {
  description: "dev.cocore.compute.receipt records indexed",
});

/** Settlement attempts, tagged by outcome. Use `settlementOutcome(tag)`. */
const settlements = Metric.counter("cocore.settlements", {
  description: "settlement attempts by outcome",
});

/** Counter for settlement attempts tagged with a low-cardinality outcome
 *  (e.g. "settled", "rejected", "deferred"). */
export function settlementOutcome(outcome: string) {
  return settlements.pipe(Metric.tagged("outcome", outcome));
}

/** Tokens moved through the ledger, split by direction ("in" | "out"). */
const tokens = Metric.counter("cocore.tokens", {
  description: "tokens accounted, by direction",
  incremental: true,
});

/** Counter for tokens accounted, tagged by direction. */
export function tokenThroughput(direction: "in" | "out") {
  return tokens.pipe(Metric.tagged("direction", direction));
}

/** Receipt-dependency (job / paymentAuthorization / attestation) resolutions,
 *  tagged by where the record was found. "store" = local AppView cache hit;
 *  "pds" = fetched from the owner's PDS source-of-truth (the durable
 *  fallback); "miss" = not yet published anywhere; "error" = transient PDS /
 *  network failure. A healthy system is almost all "store"/"pds"; a spike in
 *  "miss"/"error" is the leading indicator of the 2026-06 settlement stall. */
const depResolutions = Metric.counter("cocore.dep_resolutions", {
  description: "receipt dependency resolutions by source",
});

/** Counter for dependency resolutions, tagged by source. */
export function depResolution(source: "store" | "pds" | "miss" | "error") {
  return depResolutions.pipe(Metric.tagged("source", source));
}

/** Receipts that parked in `resolve-failed`, tagged by the LOW-CARDINALITY
 *  collection of the missing dependency (job / paymentAuthorization /
 *  attestation / unknown) — never the URI. Lets an operator see WHICH kind of
 *  dependency is going missing without Railway log access. */
const resolveFailures = Metric.counter("cocore.resolve_failed", {
  description: "receipts parked on a missing dependency, by missing collection",
});

/** Counter for resolve-failed receipts, tagged by missing-dep collection. */
export function resolveFailed(collection: string) {
  return resolveFailures.pipe(Metric.tagged("collection", collection));
}

/** Relay-firehose liveness: incremented once per upstream event the relay
 *  consumes (any collection). On the full bsky.network firehose a healthy
 *  relay ticks this constantly, so `RATE_SUM == 0` over a few minutes is an
 *  unambiguous "indexer feed is dead" signal — the failure that silently
 *  starved the store for days in 2026-06. Sampled (1/N) to keep volume sane;
 *  the absolute rate doesn't matter, only that it's non-zero. */
const relayEventsSeen = Metric.counter("cocore.relay.events", {
  description: "upstream relay-firehose events consumed (sampled liveness tick)",
});

/** Counter for relay liveness ticks. */
export const relayEvents = relayEventsSeen;

/** OAuth session restore failures on the AppView (the sole session owner),
 *  tagged by a coarse reason so a dead service session is VISIBLE instead of
 *  surfacing only as a downstream 401 string. "needs_reauth" = the refresh
 *  token is spent/revoked/expired and a human must re-authenticate;
 *  "transient" = network/timeout (retryable); "unknown" = unclassified. */
const oauthRestoreFailures = Metric.counter("cocore.oauth.restore_failed", {
  description: "OAuth session restore failures by reason",
});

/** Counter for OAuth restore failures, tagged by reason. */
export function oauthRestoreFailed(reason: "needs_reauth" | "transient" | "unknown") {
  return oauthRestoreFailures.pipe(Metric.tagged("reason", reason));
}

/** Best-effort AppView→bridge mirror publish failures. The mirror is a cache
 *  hint backed by the relay, but when BOTH fail a record never gets indexed;
 *  counting the failures turns a previously-silent gap into a signal. */
const mirrorFailures = Metric.counter("cocore.mirror.failed", {
  description: "AppView→bridge mirror publish failures",
});

/** Counter for mirror publish failures. */
export const mirrorFailed = mirrorFailures;

/** Exchange app-password session lifecycle events. The exchange writes its own
 *  PDS records (settlements, policy, attestation) with a self-managed
 *  app-password session instead of a lapse-prone OAuth session. "created" /
 *  "refreshed" are healthy; a rising "refresh_failed" (recoverable — it
 *  re-creates from the app password) or any "create_failed" (the app password
 *  itself is bad/revoked → writes are down) is the signal to act. */
const exchangeSessionOps = Metric.counter("cocore.exchange.session", {
  description: "exchange app-password session lifecycle events by outcome",
});

/** Counter for exchange session lifecycle events, tagged by event. */
export function exchangeSession(
  event: "created" | "refreshed" | "refresh_failed" | "create_failed",
) {
  return exchangeSessionOps.pipe(Metric.tagged("event", event));
}
