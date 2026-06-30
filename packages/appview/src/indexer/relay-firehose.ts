// RelayFirehose: real wire transport for the Indexer.
//
// Wraps @atproto/sync's Firehose so cocore code can subscribe to a
// relay's `com.atproto.sync.subscribeRepos` stream and dispatch
// every cocore record into our in-process Firehose (the seam in
// @cocore/sdk/firehose). Once started, two AppView operators
// running this against the same relay get byte-identical state for
// every cocore record — that's the federation invariant the
// project leans on.
//
// Each #commit event carries an array of ops; we filter to cocore
// collections and convert into IndexedRecord shapes.

import {
  Firehose as AtFirehose,
  FirehoseSubscriptionError,
  MemoryRunner,
  type Event as AtEvent,
} from "@atproto/sync";
import { IdResolver } from "@atproto/identity";
import { logWarn, makeRuntime, metrics, record, type O11yRuntime } from "@cocore/o11y";
import {
  COLLECTIONS,
  type CollectionId,
  type Firehose as CocoreFirehose,
  type IndexedRecord,
} from "@cocore/sdk";
import { Effect, Fiber, Metric, Schedule } from "effect";

/** All cocore collections the firehose listens for. `COLLECTIONS`
 *  itself only enumerates `dev.cocore.compute.*` (the receipt-side
 *  records); we additionally subscribe to the account lexicons
 *  (profile, tokenGrant, friend, tokenPatronage) so the AppView's
 *  discovery directory + profile pages + incoming-friends UI have
 *  the data they need. New account NSIDs land here when they ship. */
const ACCOUNT_COLLECTIONS = [
  "dev.cocore.account.profile",
  "dev.cocore.account.tokenGrant",
  "dev.cocore.account.tokenPatronage",
  "dev.cocore.account.friend",
] as const;

const ALL_COLLECTIONS = [...COLLECTIONS, ...ACCOUNT_COLLECTIONS];

const COLLECTION_SET = new Set<string>(ALL_COLLECTIONS);

// One o11y runtime for the module — provides the tracing layer that
// `Effect.withSpan` reports through and the logger `logWarn` flows to.
// A no-op until OTEL_EXPORTER_OTLP_* is set (see @cocore/o11y).
const runtime: O11yRuntime = makeRuntime({ serviceName: "cocore-appview" });

// Supervised reconnect backoff for the relay subscription. Jittered
// exponential starting at 1s, capped at 30s via `either(spaced(30s))`
// (`either` takes the shorter of the two delays, so once the
// exponential growth passes 30s the 30s schedule wins). Recurs
// forever, so a dropped subscription always tries to reconnect.
const RECONNECT_SCHEDULE = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.either(Schedule.spaced("30 seconds")),
);

/** Signals a relay subscription that ENDED cleanly rather than errored — the
 *  @atproto/sync stream's `start()` promise resolved (server close, idle
 *  cutoff, graceful EOF). We convert it into a retryable failure so the
 *  supervised backoff reconnects; see `start()`. Before this, a clean end
 *  silently terminated the supervisor fiber and the relay never came back —
 *  the indexer-starvation half of the 2026-06 settlement stall. */
export class RelayStreamEnded extends Error {
  constructor(message = "relay subscription ended; reconnecting") {
    super(message);
    this.name = "RelayStreamEnded";
  }
}

/** Compose one relay connection attempt into a forever-reconnecting
 *  supervised effect. The fix at the heart of the 2026-06 indexer stall: a
 *  CLEAN stream end (connect resolves) is turned into a `RelayStreamEnded`
 *  failure so `Effect.retry` reconnects it — previously only an ERROR triggered
 *  a reconnect, so a graceful upstream close silently ended the supervisor and
 *  the relay never came back. A drop (connect fails) retries as before.
 *  `onAttemptEnd` fires once per terminated attempt (clean or errored) for
 *  logging. Exported so the reconnect-on-clean-end contract is unit-testable
 *  without a live socket. */
export function superviseRelay<E>(
  connect: () => Effect.Effect<void, E>,
  schedule: Schedule.Schedule<unknown, unknown>,
  onAttemptEnd?: (err: E | RelayStreamEnded) => void,
): Effect.Effect<void, E | RelayStreamEnded> {
  return connect().pipe(
    Effect.zipRight(Effect.fail(new RelayStreamEnded())),
    Effect.tapError((err) => (onAttemptEnd ? Effect.sync(() => onAttemptEnd(err)) : Effect.void)),
    Effect.retry(schedule),
  );
}

// Record one relay liveness tick every Nth upstream event. The full
// bsky.network firehose fires constantly, so a sampled counter stays cheap
// while still dropping to zero the instant the feed dies — exactly what a
// "RATE_SUM == 0 over N minutes" alert needs to catch a dead indexer.
const LIVENESS_SAMPLE_EVERY = 500;

export interface RelayFirehoseOpts {
  /** WebSocket URL of the relay. e.g. `wss://bsky.network` or
   *  `ws://localhost:NNNN` for the dev PDS. */
  service: string;
  /** Cocore Firehose to fan events into. */
  out: CocoreFirehose;
  /** When true, accept commit events without verifying the signing
   *  key against the publishing DID's document. Use this for
   *  test PDSes (where the IdResolver can't reach a real PLC) and
   *  trusted local relays. Defaults to false in production. */
  unauthenticatedCommits?: boolean;
  /** Optional cursor seed. If absent, starts from the relay's
   *  current head (no backfill). */
  initialCursor?: number;
  /** Hook for the operator to persist the cursor. Called after
   *  every successful event handle. The default no-op is fine for
   *  in-memory tests; production implementations should durably
   *  store this so a restart resumes where it left off. */
  setCursor?: (cursor: number) => Promise<void>;
}

export class RelayFirehose {
  private inner: AtFirehose;
  private opts: RelayFirehoseOpts;
  private idResolver: IdResolver;
  private runner: MemoryRunner;
  /** Fiber running the supervised reconnect loop; set by `start()`. */
  private fiber?: Fiber.RuntimeFiber<void, unknown>;
  /** Wall-clock ms of the last upstream event consumed; 0 until the first.
   *  Drives `getLiveness()` — a large idle while the process is up means the
   *  feed has gone silent. */
  private lastEventAt = 0;
  /** Rolling event counter for liveness-tick sampling. */
  private eventCount = 0;

  constructor(opts: RelayFirehoseOpts) {
    this.opts = opts;
    this.idResolver = new IdResolver();
    const setCursor = opts.setCursor ?? (async () => {});
    let lastCursor: number | undefined = opts.initialCursor;
    this.runner = new MemoryRunner({ setCursor });

    this.inner = new AtFirehose({
      service: opts.service,
      idResolver: this.idResolver,
      runner: this.runner,
      unauthenticatedCommits: opts.unauthenticatedCommits ?? false,
      filterCollections: ALL_COLLECTIONS,
      handleEvent: async (evt: AtEvent) => {
        if (evt.event === "create" || evt.event === "update") {
          const commit = evt as AtCommitEvt;
          if (!COLLECTION_SET.has(commit.collection)) return;
          await opts.out.dispatch(toCocoreIndexedRecord(commit));
        }
        // Ignore #identity, #account, #sync, and tombstones for
        // now. M11.5: emit a deletion event into the cocore
        // Firehose so the AppView's store can prune.
        const seq = (evt as { seq?: number }).seq;
        if (typeof seq === "number") lastCursor = seq;
        // Liveness: any consumed event (any collection) proves the feed is
        // alive. Stamp the time and tick a sampled counter so a silent feed
        // is observable (idleMs climbs; the counter's rate falls to zero).
        this.lastEventAt = Date.now();
        if (++this.eventCount % LIVENESS_SAMPLE_EVERY === 0) {
          record(runtime, Metric.increment(metrics.relayEvents));
        }
      },
      onError: (err: Error) => {
        // A subscription-level error means the upstream connection
        // dropped/failed. @atproto/sync would otherwise swallow it and
        // recurse internally on a fixed delay; instead we re-throw so
        // it escapes `start()` and the supervised loop below reconnects
        // it with jittered exponential backoff + tracing. Per-event
        // errors (validation/parse/handler) are recoverable — log and
        // keep consuming the stream.
        if (err instanceof FirehoseSubscriptionError) throw err;
        // eslint-disable-next-line no-console
        console.error("relay-firehose error:", err.message);
      },
    });
    void lastCursor;
  }

  /** Run one subscription attempt. `inner.start()` resolves only on a
   *  clean abort (via `stop()`); a dropped subscription rejects it (the
   *  `onError` re-throw above). On interruption the finalizer aborts the
   *  live connection so `stop()` can wind the WS down cleanly.
   *
   *  Re-running `inner.start()` re-iterates the underlying subscription,
   *  which re-reads the cursor from the shared `MemoryRunner` — so a
   *  reconnect resumes from the persisted cursor, never from head. */
  private connectOnce(): Effect.Effect<void, unknown> {
    return Effect.async<void, unknown>((resume) => {
      let settled = false;
      this.inner.start().then(
        () => {
          if (!settled) {
            settled = true;
            resume(Effect.void);
          }
        },
        (err: unknown) => {
          if (!settled) {
            settled = true;
            resume(Effect.fail(err));
          }
        },
      );
      return Effect.promise(async () => {
        settled = true;
        await this.inner.destroy();
      });
    }).pipe(
      Effect.withSpan("relay.subscribe", { attributes: { "relay.service": this.opts.service } }),
      Effect.tapError((err) =>
        logWarn("relay-firehose subscription dropped; reconnecting", {
          service: this.opts.service,
          cursor: this.runner.getCursor(),
          error: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
  }

  start(): void {
    if (this.fiber) return;
    // Supervise the connection so it reconnects on ANY termination — a clean
    // stream end (connectOnce resolves) as well as a drop (connectOnce
    // fails). See `superviseRelay`: before it, a graceful upstream close
    // silently ended the supervisor fiber and the relay never came back. An
    // intentional `stop()` interrupts the fiber before the fail/retry runs,
    // so it still winds down cleanly. connectOnce already logs its own drops;
    // we log the clean-end case here.
    const supervised = superviseRelay(
      () => this.connectOnce(),
      RECONNECT_SCHEDULE,
      (err) => {
        if (err instanceof RelayStreamEnded) {
          runtime.runFork(
            logWarn("relay-firehose subscription ended; reconnecting", {
              service: this.opts.service,
              cursor: this.runner.getCursor(),
            }),
          );
        }
      },
    );
    this.fiber = runtime.runFork(supervised);
  }

  /** Relay liveness snapshot for health/admin endpoints. `lastEventAt` is
   *  null until the first event; `idleMs` is ms since the last consumed
   *  event. While the process is up, a large `idleMs` means the upstream
   *  feed has gone silent — the indexer is no longer being fed, even if the
   *  socket looks connected. */
  getLiveness(): { lastEventAt: string | null; idleMs: number | null } {
    if (this.lastEventAt === 0) return { lastEventAt: null, idleMs: null };
    return {
      lastEventAt: new Date(this.lastEventAt).toISOString(),
      idleMs: Date.now() - this.lastEventAt,
    };
  }

  async stop(): Promise<void> {
    const fiber = this.fiber;
    this.fiber = undefined;
    if (fiber) {
      // Interrupting runs `connectOnce`'s finalizer, which aborts the
      // live subscription (resolving `inner.destroy()`); if we're mid
      // backoff it just cancels the sleep.
      await runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {});
    } else {
      await this.inner.destroy();
    }
  }
}

interface AtCommitEvt {
  event: "create" | "update" | "delete";
  did: string;
  collection: string;
  rkey: string;
  cid?: { toString(): string } | null;
  record?: unknown;
  uri?: { toString(): string };
}

function toCocoreIndexedRecord(evt: AtCommitEvt): IndexedRecord {
  const uri = evt.uri ? evt.uri.toString() : `at://${evt.did}/${evt.collection}/${evt.rkey}`;
  const cid = evt.cid ? evt.cid.toString() : "";
  return {
    uri,
    cid,
    collection: evt.collection as CollectionId,
    repo: evt.did,
    rkey: evt.rkey,
    body: evt.record,
  };
}
