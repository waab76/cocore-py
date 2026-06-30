// Settlement pipeline for receipts observed on the firehose.
//
// This module owns the per-receipt processing flow that used to live
// inline in `main.ts::main()`. The reason for the carve-out is
// testability: the pending-receipt queue + reactive retry on
// dependency arrival + periodic reconcile loop are easy to get
// subtly wrong (race conditions, infinite retries, lost receipts on
// restart) and deserve unit tests that don't need a full services
// container.
//
// The pipeline owns three concerns:
//
//   1. **First-pass settlement.** When a receipt arrives at the
//      firehose, run `exchange.onReceipt(rec)`. Outcomes:
//        * `settled` / `duplicate` — done.
//        * `rejected` — terminal, log and drop.
//        * `resolve-failed` — park the receipt on the missing URI
//          and wait. This is the case we used to silently swallow.
//
//   2. **Reactive retry.** When ANY cocore record arrives at the
//      firehose, check if any parked receipt was waiting on it.
//      If so, replay `exchange.onReceipt`. The exchange dedups on
//      receipt URI via its `settledByReceiptUri` set, so this is
//      safe to call multiple times.
//
//   3. **Periodic reconcile.** Every N seconds, scan the AppView
//      store for receipts that don't yet have a settlement record
//      and re-invoke `exchange.onReceipt` for each. This covers
//      gaps the reactive path can't: services-container restart
//      (parked map is in-memory), reactive-handler missed the
//      dep event because it landed before the receipt was parked,
//      exhausted retry budget, etc.
//
// The token-ledger application is intentionally part of this same
// pipeline. The ledger's `applyReceipt` is idempotent on receipt URI
// (per the docs there), so replay-on-retry is safe; we want it next
// to the exchange call so a logging block sees both outcomes
// together.

import { Metric } from "effect";

import type { Firehose, IndexedRecord } from "@cocore/sdk";
import type { ReceiptRecord } from "@cocore/sdk/types";
import type { Exchange, SettlementOutcome } from "@cocore/exchange";
import type { TokenLedger, TokenLedgerPolicy } from "@cocore/exchange/token-balance";
import { metrics, record, runTracedPromise, type O11yRuntime } from "@cocore/o11y";

// Minimal read-side view of the AppView store that the pipeline
// needs. Carved as an interface so tests can drive an in-memory
// stub without pulling better-sqlite3 in. Module-local (not
// exported) so consumers go through ReceiptPipelineOptions —
// changing the shape later doesn't break downstream imports.
interface PipelineStore {
  get(uri: string): IndexedRecord | null;
  listByCollection(collection: string, limit?: number): IndexedRecord[];
}

export interface ReceiptPipelineOptions {
  exchange: Exchange;
  ledger: TokenLedger;
  ledgerPolicy: TokenLedgerPolicy;
  firehose: Firehose;
  store: PipelineStore;
  treasuryDid: string;
  feeBps: number;
  /** Per-receipt retry budget on `resolve-failed`. Once exceeded,
   *  the reactive path stops re-parking the receipt; the reconcile
   *  loop will still pick it up on later passes if needed. */
  maxRetries?: number;
  /** Reconcile-loop batch size. Defaults to 200 receipts per tick. */
  reconcileBatchSize?: number;
  /** Logger seam. Tests inject a recording logger; production
   *  passes `console.error`. */
  log?: (line: string) => void;
  /** Optional o11y runtime. When present, each `processReceipt` runs
   *  inside a `services.processReceipt` span (content-safe attrs only)
   *  and emits the cross-cutting receipt/settlement/token metrics.
   *  Absent (e.g. unit tests) → a no-op; the control flow is identical. */
  runtime?: O11yRuntime;
}

export interface ReceiptPipeline {
  /** Wire the pipeline to the firehose. Subscribes the receipt
   *  handler + the dep-arrival reactive retry. Returns an
   *  unsubscribe function (only really used by tests). */
  attach(): () => void;

  /** Drive one receipt through the pipeline. Public for the
   *  reconcile loop + tests; the firehose handler calls this
   *  internally. */
  processReceipt(rec: IndexedRecord, retried?: boolean): Promise<SettlementOutcome>;

  /** Scan the indexed-receipt table for receipts that don't yet
   *  have a settlement record and re-invoke `exchange.onReceipt`
   *  for each. Returns a summary the caller can log. */
  reconcileUnsettledReceipts(): Promise<ReconcileSummary>;

  /** Diagnostics: the current pending-by-missing-uri map.
   *  Read-only snapshot; tests assert against this. */
  pendingSnapshot(): Array<{ missing: string; waiters: string[] }>;

  /** Diagnostics: most-recent outcomes the pipeline has seen.
   *  Ring buffer, capped at ~200 entries. The shape includes
   *  enough detail to debug "why didn't this receipt settle?"
   *  without Railway log access — the missing dep URI (for
   *  resolve-failed), the verification findings (for rejected),
   *  the settlement URI (for settled), etc. */
  recentOutcomes(): Array<RecentOutcomeEntry>;
}

/** One row in the ring buffer of recent processReceipt outcomes. */
export interface RecentOutcomeEntry {
  at: string;
  receiptUri: string;
  /** `fresh` = first observation via firehose. `retry` = either
   *  dep-arrival reactive retry or reconcile-loop sweep. */
  tag: "fresh" | "retry";
  kind: SettlementOutcome["kind"];
  /** Present on `resolve-failed`. The URI the exchange couldn't
   *  locate in the indexed store. */
  missing?: string;
  /** Present on `rejected`. List of verification finding codes
   *  (e.g. ["currency-mismatch", "auth-expired"]). */
  findings?: string[];
  /** Present on `settled`. The published settlement record's URI. */
  settlementUri?: string;
  /** Per-receipt retry counter at the time of this outcome. */
  attempts: number;
}

export interface ReconcileSummary {
  scanned: number;
  attempted: number;
  settled: number;
  stillResolveFailed: number;
  rejected: number;
  /** Receipts skipped because a prior pass already rejected them.
   *  Rejection is a verdict on record *content* (currency mismatch,
   *  bad signature, expired authorization) and PDS records are
   *  immutable, so re-verifying can never flip the outcome — but
   *  before this counter existed the reconcile loop re-attempted
   *  (and re-logged) every terminal reject on every tick, forever. */
  skippedRejected: number;
}

/** The collection segment of an at-uri (`at://<did>/<collection>/<rkey>`),
 *  for low-cardinality metric tagging. Returns "unknown" for non-at-uris. */
function collectionFromUri(uri: string): string {
  const m = /^at:\/\/[^/]+\/([^/]+)\//.exec(uri);
  return m?.[1] ?? "unknown";
}

const DEFAULT_MAX_RETRIES = 8;
const DEFAULT_RECONCILE_BATCH_SIZE = 200;
const SETTLEMENT_SCAN_LIMIT = 5000;
const RECENT_OUTCOMES_CAP = 200;
const REJECTED_MEMORY_CAP = 10_000;

export function createReceiptPipeline(opts: ReceiptPipelineOptions): ReceiptPipeline {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const reconcileBatchSize = opts.reconcileBatchSize ?? DEFAULT_RECONCILE_BATCH_SIZE;
  const log = opts.log ?? ((line: string) => console.error(line));

  // Pending-receipt queue: missing URI → set of receipt URIs that
  // need that URI to land before settlement can succeed.
  const pendingByMissingUri = new Map<string, Set<string>>();
  // Per-receipt retry counter. Resets on `settled`/`duplicate` (the
  // receipt has cleared the path). On `resolve-failed` we increment;
  // past maxRetries we stop re-parking. The reconcile loop ignores
  // the per-receipt counter and tries unsettled receipts regardless,
  // so a depended-on URI landing minutes-late still gets handled.
  const retryCount = new Map<string, number>();

  // Receipts the exchange has terminally rejected, with the finding
  // codes from the verdict. Records are immutable, so a rejection
  // can't heal — the reconcile loop skips these instead of re-verify
  // + re-log every tick. In-memory by design: a services restart
  // clears it, granting each rejected receipt exactly one re-attempt
  // per process lifetime (a safety valve in case the verifier itself
  // changed across the deploy). Insertion-ordered Map gives FIFO
  // eviction at the cap.
  const rejectedReceipts = new Map<string, string[]>();
  function rememberRejected(uri: string, findings: string[]): void {
    rejectedReceipts.delete(uri);
    rejectedReceipts.set(uri, findings);
    if (rejectedReceipts.size > REJECTED_MEMORY_CAP) {
      const oldest = rejectedReceipts.keys().next().value;
      if (oldest !== undefined) rejectedReceipts.delete(oldest);
    }
  }

  // Ring buffer of recent outcomes — surfaces via the admin
  // pipelineState endpoint so we can debug "why didn't this receipt
  // settle?" without Railway log access. Bounded; we keep the last
  // ~200 entries, FIFO eviction. Each entry carries enough detail
  // to identify the failure mode (resolve-failed → missing URI;
  // rejected → finding codes; settled → settlement URI).
  const outcomesRing: RecentOutcomeEntry[] = [];
  function pushOutcome(entry: RecentOutcomeEntry): void {
    outcomesRing.push(entry);
    if (outcomesRing.length > RECENT_OUTCOMES_CAP) {
      outcomesRing.shift();
    }
  }

  // Emit cross-cutting metrics for one processed receipt. No-op without a
  // runtime; recorded fire-and-forget. Dimensions stay low-cardinality
  // (outcome.kind / direction) — never a DID or URI. Token throughput uses
  // the receipt's self-reported token deltas, recorded only once the
  // exchange has actually settled (or de-duped) the receipt.
  function emitMetrics(outcome: SettlementOutcome, body: ReceiptRecord | null): void {
    const rt = opts.runtime;
    if (!rt) return;
    record(rt, Metric.increment(metrics.receiptsIndexed));
    record(rt, Metric.increment(metrics.settlementOutcome(outcome.kind)));
    // Tag resolve-failed by the LOW-CARDINALITY collection of the missing dep
    // (job / paymentAuthorization / attestation), never the URI — so an
    // operator can see WHICH kind of dependency is going missing (and alert
    // on it) without Railway log access. This is the signal that was
    // completely invisible during the 2026-06 stall.
    if (outcome.kind === "resolve-failed") {
      record(rt, Metric.increment(metrics.resolveFailed(collectionFromUri(outcome.missing))));
    }
    if ((outcome.kind === "settled" || outcome.kind === "duplicate") && body?.tokens) {
      const tin = body.tokens.in;
      const tout = body.tokens.out;
      if (Number.isFinite(tin) && tin > 0) {
        record(rt, Metric.incrementBy(metrics.tokenThroughput("in"), tin));
      }
      if (Number.isFinite(tout) && tout > 0) {
        record(rt, Metric.incrementBy(metrics.tokenThroughput("out"), tout));
      }
    }
  }

  // Traced boundary: every receipt (firehose first-pass, reactive retry,
  // and reconcile sweep all funnel through here) runs inside one
  // `services.processReceipt` span when a runtime is configured. Without a
  // runtime this is a direct call — identical control flow for the tests.
  async function processReceipt(rec: IndexedRecord, retried = false): Promise<SettlementOutcome> {
    if (!opts.runtime) return processReceiptInner(rec, retried);
    return runTracedPromise(
      opts.runtime,
      "services.processReceipt",
      () => processReceiptInner(rec, retried),
      { "receipt.uri": rec.uri },
    );
  }

  async function processReceiptInner(
    rec: IndexedRecord,
    retried = false,
  ): Promise<SettlementOutcome> {
    const receiptRec = rec as IndexedRecord<ReceiptRecord>;
    const outcome = await opts.exchange.onReceipt(receiptRec);
    const tag: "fresh" | "retry" = retried ? "retry" : "fresh";

    // Snapshot for the ring buffer. Built outside the switch so we
    // can populate fields per-outcome.
    const entry: RecentOutcomeEntry = {
      at: new Date().toISOString(),
      receiptUri: rec.uri,
      tag,
      kind: outcome.kind,
      attempts: retryCount.get(rec.uri) ?? 0,
    };

    switch (outcome.kind) {
      case "settled":
        log(`exchange: ${tag} settled ${rec.uri} → ${outcome.settlement.uri}`);
        entry.settlementUri = outcome.settlement.uri;
        retryCount.delete(rec.uri);
        break;
      case "duplicate":
        // Already settled (e.g. reconcile re-attempt). No-op, no log
        // noise — duplicates are the steady state on a healthy system.
        entry.settlementUri = outcome.settlement.uri;
        retryCount.delete(rec.uri);
        break;
      case "resolve-failed": {
        const attempts = (retryCount.get(rec.uri) ?? 0) + 1;
        retryCount.set(rec.uri, attempts);
        entry.attempts = attempts;
        entry.missing = outcome.missing;
        if (attempts > maxRetries) {
          log(
            `exchange: ${tag} resolve-failed ${rec.uri} missing=${outcome.missing} (giving up after ${maxRetries} retries — dep records likely on a non-relayed PDS)`,
          );
        } else {
          // Park on the missing URI so the dep-arrival handler can
          // wake us when it shows up.
          let waiters = pendingByMissingUri.get(outcome.missing);
          if (!waiters) {
            waiters = new Set();
            pendingByMissingUri.set(outcome.missing, waiters);
          }
          waiters.add(rec.uri);
          log(
            `exchange: ${tag} resolve-failed ${rec.uri} missing=${outcome.missing} (parked, attempt ${attempts}/${maxRetries})`,
          );
        }
        break;
      }
      case "rejected": {
        const findingCodes = outcome.report.findings?.map((f) => f.code) ?? [];
        log(
          `exchange: ${tag} rejected ${rec.uri} findings=${findingCodes.join(",") || "?"} (terminal — reconcile will skip)`,
        );
        entry.findings = findingCodes;
        rememberRejected(rec.uri, findingCodes);
        retryCount.delete(rec.uri);
        break;
      }
    }
    pushOutcome(entry);

    // Token movement — ONLY for receipts the exchange actually settled
    // (or already-settled duplicates). A `rejected` receipt failed
    // verification (bad signature, requester ≠ job owner, over-ceiling,
    // expired) and a `resolve-failed` one hasn't been verified at all;
    // moving balances for either let a malicious provider publish a
    // receipt to their OWN PDS naming any victim as `requester` and
    // drain that victim's balance into their own account. The ledger is
    // idempotent on receipt URI, so a settled→duplicate re-drive is a
    // no-op, not a double-debit.
    //
    // Debit the exchange-VERIFIED `price.amount` (settlement checked it
    // against the job's price ceiling), NOT the self-reported `tokens`:
    // at the 1:1 CC rate price.amount == tokens.in+out for an honest
    // receipt, but a malicious provider could pair a small,
    // ceiling-passing price with a huge token count to over-debit. CC is
    // the closed-loop credit unit; a non-CC receipt isn't ours to move.
    if (outcome.kind === "settled" || outcome.kind === "duplicate") {
      const body = rec.body as ReceiptRecord | null;
      const providerDid = rec.repo;
      const amount =
        body?.price?.currency === "CC" && Number.isInteger(body.price.amount)
          ? Math.max(0, body.price.amount)
          : 0;
      if (amount > 0 && body && body.requester && providerDid) {
        try {
          const applied = opts.ledger.applyReceipt(
            { uri: rec.uri, requesterDid: body.requester, providerDid, tokens: amount },
            opts.ledgerPolicy,
          );
          if (applied) {
            opts.ledger.applyRefreshIfDue(body.requester, opts.ledgerPolicy);
            opts.ledger.applyRefreshIfDue(providerDid, opts.ledgerPolicy);
            log(
              `token-ledger: receipt ${rec.uri} moved ${amount} CC ${body.requester} -> ${providerDid} (fee ${opts.feeBps}bps to ${opts.treasuryDid})`,
            );
          }
        } catch (e) {
          log(`token-ledger: receipt ${rec.uri} apply failed: ${(e as Error).message}`);
        }
      }
    }
    emitMetrics(outcome, rec.body as ReceiptRecord | null);
    return outcome;
  }

  /** When a record arrives at the firehose, drain any pending
   *  receipts that were waiting on its URI. Each parked receipt
   *  gets re-driven through `processReceipt`; the exchange dedups,
   *  so even if multiple deps arrive in quick succession the
   *  retry is safe. */
  async function onAnyRecord(rec: IndexedRecord): Promise<void> {
    const waiters = pendingByMissingUri.get(rec.uri);
    if (!waiters || waiters.size === 0) return;
    pendingByMissingUri.delete(rec.uri);
    for (const receiptUri of waiters) {
      const receiptRow = opts.store.get(receiptUri);
      if (!receiptRow) {
        log(`exchange: retry trigger for ${receiptUri} but receipt no longer in store`);
        continue;
      }
      log(`exchange: dep arrived (${rec.uri}); retrying ${receiptUri}`);
      await processReceipt(receiptRow, true).catch((e) => {
        log(`exchange: retry ${receiptUri} threw: ${(e as Error).message}`);
      });
    }
  }

  async function reconcileUnsettledReceipts(): Promise<ReconcileSummary> {
    const summary: ReconcileSummary = {
      scanned: 0,
      attempted: 0,
      settled: 0,
      stillResolveFailed: 0,
      rejected: 0,
      skippedRejected: 0,
    };
    // Pull settlements first; build the "already settled" set in
    // one pass keyed by receipt URI.
    const settlements = opts.store.listByCollection(
      "dev.cocore.compute.settlement",
      SETTLEMENT_SCAN_LIMIT,
    );
    const alreadySettled = new Set<string>();
    for (const s of settlements) {
      const body = s.body as { receipt?: { uri?: string } } | null;
      const uri = body?.receipt?.uri;
      if (typeof uri === "string") alreadySettled.add(uri);
    }
    const receipts = opts.store.listByCollection("dev.cocore.compute.receipt", reconcileBatchSize);
    summary.scanned = receipts.length;
    for (const r of receipts) {
      if (alreadySettled.has(r.uri)) continue;
      if (rejectedReceipts.has(r.uri)) {
        summary.skippedRejected += 1;
        continue;
      }
      summary.attempted += 1;
      const outcome = await processReceipt(r, true).catch((e) => {
        log(`reconcile: receipt ${r.uri} threw: ${(e as Error).message}`);
        return undefined;
      });
      if (!outcome) continue;
      if (outcome.kind === "settled" || outcome.kind === "duplicate") summary.settled += 1;
      else if (outcome.kind === "resolve-failed") summary.stillResolveFailed += 1;
      else if (outcome.kind === "rejected") summary.rejected += 1;
    }
    return summary;
  }

  function attach(): () => void {
    const unsubReceipt = opts.firehose.onReceipt(async (rec: IndexedRecord) => {
      await processReceipt(rec, false);
    });
    const unsubAll = opts.firehose.on(null, async (rec: IndexedRecord) => {
      await onAnyRecord(rec);
    });
    return () => {
      unsubReceipt();
      unsubAll();
    };
  }

  function pendingSnapshot(): Array<{ missing: string; waiters: string[] }> {
    return Array.from(pendingByMissingUri.entries()).map(([missing, waiters]) => ({
      missing,
      waiters: Array.from(waiters),
    }));
  }

  function recentOutcomes(): RecentOutcomeEntry[] {
    // Return a defensive copy newest-first so callers can serialize
    // without worrying about subsequent pipeline activity mutating
    // the array under them.
    return outcomesRing.slice().reverse();
  }

  return {
    attach,
    processReceipt,
    reconcileUnsettledReceipts,
    pendingSnapshot,
    recentOutcomes,
  };
}
