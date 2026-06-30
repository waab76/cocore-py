// Durable, self-healing dependency resolution for the exchange.
//
// Before settling a receipt the exchange must resolve the records it
// strong-refs: the `job`, the job's `paymentAuthorization`, and the
// `attestation`. Historically `resolveRecord` read ONLY the local AppView
// store — a cache fed by a best-effort firehose mirror plus the relay
// backstop. When BOTH of those feeds stalled (the 2026-06 incident: the
// relay subscription died and the fire-and-forget mirror silently dropped
// writes during a bridge outage), every referenced dependency went missing
// and every receipt parked in `resolve-failed` FOREVER — silently, because
// there was no fallback to the source of truth.
//
// The PDS is the canonical home of every cocore record (core invariant #1:
// "the provider's PDS is the source of truth"). So the robust fix is to fall
// back to it: on a local-store miss, fetch the record directly from the
// owner's PDS via `resolveRecordOverPds` (which the SDK built for exactly
// this), back-fill the store so subsequent lookups are local, and only then
// give up. This makes settlement correctness independent of relay/mirror
// liveness — a record that actually exists always resolves.
//
// A short negative cache keeps a genuinely-not-yet-published dependency (the
// usual receipt-beats-its-deps race) from hammering plc.directory + the PDS
// on every reconcile tick, without delaying settlement once the dep lands.

import { resolveRecordOverPds, ResolveError } from "@cocore/sdk/resolve";
import type { IndexedRecord } from "@cocore/sdk";
import { metrics, record, type O11yRuntime } from "@cocore/o11y";
import { Metric } from "effect";

/** Minimal store surface the resolver needs: a local read and a back-fill
 *  write. Matches both the real `Store` and the in-memory test stub. */
export interface ResolverStore {
  get(uri: string): IndexedRecord | null;
  upsert(rec: IndexedRecord): void;
}

export interface PdsBackedResolverOptions {
  store: ResolverStore;
  /** PDS fetch seam. Defaults to the SDK's HTTPS getRecord resolver; tests
   *  inject a stub. Returns the record, or null when the DID has no PDS
   *  service entry / the record doesn't exist yet. Throws `ResolveError` for
   *  transient failures (network, malformed doc). */
  resolveOverPds?: (uri: string) => Promise<IndexedRecord | null>;
  /** o11y runtime for the dep-resolution metric. Omit in tests (no-op). */
  runtime?: O11yRuntime;
  /** Log seam (defaults to console.error). */
  log?: (line: string) => void;
  /** How long (ms) to remember a "not published yet" miss before re-querying
   *  the PDS for the same URI. Long enough to dampen the reconcile loop's
   *  re-drives, short enough that a dep landing soon still settles promptly.
   *  Default 30s. Transient PDS errors are NOT cached — they retry next tick. */
  negativeTtlMs?: number;
  /** Clock seam for the negative cache (tests inject a fake). */
  now?: () => number;
}

const DEFAULT_NEGATIVE_TTL_MS = 30_000;

/** The collection segment of an at-uri, for low-cardinality tagging/logging.
 *  Returns "unknown" for anything that isn't a well-formed at-uri. */
function collectionOf(uri: string): string {
  const m = /^at:\/\/[^/]+\/([^/]+)\//.exec(uri);
  return m?.[1] ?? "unknown";
}

/** Build a store-first, PDS-backed `resolveRecord` for the exchange.
 *
 *  Resolution order for each URI:
 *    1. local store hit            → return it (source "store")
 *    2. negative cache still warm   → return null (no PDS call)
 *    3. PDS getRecord hit           → back-fill store, return it (source "pds")
 *    4. PDS reports not-found       → negative-cache + return null (source "miss")
 *    5. PDS throws (transient)      → log, return null, DON'T cache (source "error")
 *
 *  Returning null is the pipeline's "park and retry" signal, so a transient
 *  PDS blip just defers the receipt to the next reconcile pass — it never
 *  becomes a permanent stall. */
export function makePdsBackedResolver(
  opts: PdsBackedResolverOptions,
): (uri: string) => Promise<IndexedRecord | null> {
  const resolveOverPds = opts.resolveOverPds ?? ((uri: string) => resolveRecordOverPds(uri));
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => Date.now());
  const negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
  const runtime = opts.runtime;
  // uri -> epoch ms after which we'll re-query the PDS for this miss.
  const negativeUntil = new Map<string, number>();

  const tick = (source: "store" | "pds" | "miss" | "error") => {
    if (runtime) record(runtime, Metric.increment(metrics.depResolution(source)));
  };

  return async function resolveRecord(uri: string): Promise<IndexedRecord | null> {
    const local = opts.store.get(uri);
    if (local) {
      tick("store");
      return local;
    }

    const until = negativeUntil.get(uri);
    if (until !== undefined) {
      if (now() < until) {
        // Still within the negative window — treat as a fast miss.
        tick("miss");
        return null;
      }
      negativeUntil.delete(uri);
    }

    try {
      const fetched = await resolveOverPds(uri);
      if (fetched) {
        // Back-fill the cache: future lookups (and the AppView dashboards
        // reading the same store) are now local, and a dep we had to fetch
        // once never costs a PDS round-trip again.
        opts.store.upsert(fetched);
        tick("pds");
        log(`resolve: fetched ${collectionOf(uri)} ${uri} from PDS (store miss)`);
        return fetched;
      }
      // Not published yet (no PDS entry / 404). Dampen re-queries.
      negativeUntil.set(uri, now() + negativeTtlMs);
      tick("miss");
      return null;
    } catch (e) {
      // Transient — network, plc.directory hiccup, malformed doc. Do NOT
      // negative-cache; the next reconcile pass should retry immediately.
      tick("error");
      const detail = e instanceof ResolveError ? `${e.code}: ${e.message}` : String(e);
      log(`resolve: PDS fetch failed for ${uri} (${detail}); will retry`);
      return null;
    }
  };
}
