// All-in-one cocore services bridge.
//
// Runs in a single process for the docker-compose stack:
//
//   * Firehose          in-process pub/sub
//   * AppView indexer   subscribes to firehose, writes to SQLite
//   * AppView API       HTTP read API over the indexed store
//   * Exchange          verifies receipts on the firehose and
//                       publishes settlement records
//   * TokenLedger       per-DID balance ledger; receipts move tokens,
//                       firehose touches trigger lazy refresh, a
//                       monthly scheduler distributes patronage
//   * Bridge endpoint   POST /xrpc/dev.cocore.bridge.publish — accept
//                       a record from outside the process and
//                       dispatch into the firehose
//   * Health            GET /healthz
//
// One container, one log stream, one set of ports. Federation still
// works because nothing here is privileged — multiple instances can
// run against different firehoses and observe the same receipts.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";

import { Firehose, type IndexedRecord } from "@cocore/sdk";
import { Indexer, RelayFirehose } from "@cocore/appview/indexer";
import { Store } from "@cocore/appview/store";
import { buildServer as buildAppviewApi } from "@cocore/appview/api";
import { AccountStore } from "@cocore/appview/account-store";
import { Exchange } from "@cocore/exchange";
import { bootstrapExchangeRecords } from "@cocore/exchange/bootstrap";
import { ConsoleProxySettlementTransport, SettlementPublisher } from "@cocore/exchange/publisher";
import { parsePrivateJwk, signRecord } from "@cocore/exchange/signing";
import { TokenLedger, type TokenLedgerPolicy } from "@cocore/exchange/token-balance";
import { startAutoresponder } from "./autorespond.ts";
import { createReceiptPipeline } from "./receipt-pipeline.ts";

const PORT = Number(process.env["COCORE_BRIDGE_PORT"] ?? 8080);
const APPVIEW_PORT = Number(process.env["COCORE_APPVIEW_PORT"] ?? 8081);
const DB_PATH = process.env["COCORE_DB"] ?? ":memory:";
// Operational account state (API keys, OAuth sessions) lives in its own
// DB so it survives a receipt-cache rebuild. The dev.cocore.account.*
// methods only register when COCORE_APPVIEW_DID (the service-auth
// audience) is also set.
const APPVIEW_DID = process.env["COCORE_APPVIEW_DID"];
const ACCOUNT_DB = process.env["COCORE_ACCOUNT_DB"] ?? ":memory:";
const EXCHANGE_DID = process.env["COCORE_EXCHANGE_DID"] ?? "did:web:exchange.local";
const AUTORESPOND = (process.env["COCORE_AUTORESPOND"] ?? "1") !== "0";
const AUTORESPOND_PROVIDER_DID =
  process.env["COCORE_AUTORESPOND_PROVIDER_DID"] ?? "did:plc:bridge-autoresponder";

// Real-PDS publishing for settlements + the new tokenPatronage
// records. When COCORE_EXCHANGE_API_KEY is set, the exchange routes
// records through the cocore console's proxy (Bearer-key auth → DPoP
// OAuth → real bsky PDS write under the exchange's DID). When unset
// we use in-process transports — fine for tests, useless in prod.
const EXCHANGE_API_KEY = process.env["COCORE_EXCHANGE_API_KEY"];
const EXCHANGE_API_BASE = process.env["COCORE_EXCHANGE_API_BASE"] ?? "https://console.cocore.dev";

const EXCHANGE_PRIVATE_JWK = process.env["COCORE_EXCHANGE_PRIVATE_KEY_JWK"];

// Treasury fee in basis points routed to the treasury DID on every
// receipt. Conservation 95/5: 500 bps = 5% to treasury, the rest
// to the provider.
const FEE_BPS = Number(process.env["COCORE_FEE_BPS"] ?? 500);
const FEE_MIN_MINOR = Number(process.env["COCORE_FEE_MIN_MINOR"] ?? 0);
// Currency the exchange's policy + tokenRate records advertise. The
// strict receipt verifier compares `receipt.price.currency` (set by
// the agent in `provider/src/pricing.rs`) against
// `job.priceCeiling.currency` (set in `api.v1.chat.completions.ts`).
// Both are "CC" under the closed-loop pivot. Defaulting this to "CC"
// keeps a fresh Railway env's exchange policy internally consistent
// with what every actual receipt + job carries (we previously
// defaulted to "USD", which silently drifted from the receipts and
// rejected every settlement — the deceptive failure we hit today).
const FEE_CURRENCY = process.env["COCORE_FEE_CURRENCY"] ?? "CC";

// Per-token rate published in the policy. Rendered as informational
// only — tokens are the unit of account and there's
// no exchange rate to fiat.
const TOKEN_RATE_INPUT_PER_MTOK = Number(process.env["COCORE_TOKEN_RATE_INPUT_PER_MTOK"] ?? 10);
const TOKEN_RATE_OUTPUT_PER_MTOK = Number(process.env["COCORE_TOKEN_RATE_OUTPUT_PER_MTOK"] ?? 10);
const TOKEN_RATE_CURRENCY = process.env["COCORE_TOKEN_RATE_CURRENCY"] ?? FEE_CURRENCY;

// Onboarding grant + admission floor.
const TOKEN_GRANT = Number(process.env["COCORE_TOKEN_GRANT"] ?? 1_000_000);
const TOKEN_FLOOR = Number(process.env["COCORE_TOKEN_FLOOR"] ?? 100_000);

// Treasury identity. Defaults to the exchange's own DID — the
// cooperative's treasury IS the exchange's balance sheet.
const TREASURY_DID = process.env["COCORE_TREASURY_DID"] ?? EXCHANGE_DID;

// Weekly refresh: amount + cadence. Lazy — only fires on balance
// touch (receipt, getBalance, governance act).
const WEEKLY_REFRESH_AMOUNT = Number(process.env["COCORE_WEEKLY_REFRESH_AMOUNT"] ?? 70_000);
const REFRESH_CADENCE_MINUTES = Number(
  process.env["COCORE_REFRESH_CADENCE_MINUTES"] ?? 7 * 24 * 60,
);

// Patronage rebate: monthly distribution of 80% of treasury to
// active members in proportion to their patronage during the period.
const PATRONAGE_FRACTION_BPS = Number(process.env["COCORE_PATRONAGE_FRACTION_BPS"] ?? 8000);
const PATRONAGE_CADENCE_DAYS = Number(process.env["COCORE_PATRONAGE_CADENCE_DAYS"] ?? 30);
const PATRONAGE_AUTO = (process.env["COCORE_PATRONAGE_AUTO"] ?? "1") !== "0";

// Sqlite path for the TokenLedger. Defaults to Railway volume so
// balances survive redeploys; :memory: for dev/CI. Blast the file
// to reset.
const TOKEN_LEDGER_DB =
  process.env["COCORE_TOKEN_LEDGER_DB"] ??
  (process.env["RAILWAY_VOLUME_MOUNT_PATH"]
    ? `${process.env["RAILWAY_VOLUME_MOUNT_PATH"].replace(/\/$/, "")}/token-ledger.sqlite`
    : ":memory:");

// Shared secret for operator-only endpoints (wipe, manual
// distributePatronage, etc.). Unset → those endpoints reject.
const INTERNAL_API_KEY = process.env["COCORE_INTERNAL_API_KEY"];

// AT Protocol relay to subscribe to for the AppView indexer. Default
// is the Bluesky public relay, which mirrors every PDS that subscribes
// to its repo-subscribe protocol (including porcini.us-east.host.bsky
// .network where most cocore agents live today). The subscription is
// idempotent with the bridge endpoint — both feed into the same
// in-process Firehose, and the indexer's store.upsert is keyed by
// uri, so duplicate dispatches are no-ops. Set to "" or "off" to
// disable (useful for dev / tests that don't want to hit the wire).
const RELAY_URL = process.env["COCORE_RELAY_URL"] ?? "wss://bsky.network";
const RELAY_ENABLED = !!RELAY_URL && RELAY_URL !== "off";
// unauthenticatedCommits: false in production — the IdResolver checks
// every commit's signing key against the publishing DID's document
// via plc.directory. Tests that drive a local PDS without a real PLC
// flip this to true.
const RELAY_UNAUTHENTICATED = (process.env["COCORE_RELAY_UNAUTHENTICATED_COMMITS"] ?? "0") === "1";

// Reconcile loop cadence. Every N seconds the services container
// scans the indexed-receipt table for receipts that don't yet have a
// settlement record, and re-invokes `exchange.onReceipt` for each.
// This is the catch-all for receipts that failed `resolve-failed` on
// first observation (the dependency record — job, payment auth,
// attestation — arrived seconds later but the exchange doesn't
// retry on its own). Also catches anything that landed during a
// services-container restart.
const RECONCILE_INTERVAL_SECONDS = Number(process.env["COCORE_RECONCILE_INTERVAL_SECONDS"] ?? 60);
// Maximum number of receipts to attempt per reconcile tick. Caps work
// done per pass on a large backfill; the loop will pick up where it
// left off on the next tick.
const RECONCILE_BATCH_SIZE = Number(process.env["COCORE_RECONCILE_BATCH_SIZE"] ?? 200);

// Self-loop: waive the treasury fee when requester DID == provider
// DID. Settlement record is still published as audit trail.
const SELF_LOOP_FEE_WAIVED = (process.env["COCORE_SELF_LOOP_FEE_WAIVED"] ?? "1") !== "0";

const SOFTWARE_VERSION = process.env["COCORE_SOFTWARE_VERSION"] ?? "cocore-services@dev";

// Terms-of-service version. Bumping forces re-acceptance — the next
// bootstrap publishes a fresh exchangePolicy with the new version
// and console clients prompt the user.
const TERMS_VERSION = process.env["COCORE_TERMS_VERSION"] ?? "v2-2026-06-13";
const TERMS_URI =
  process.env["COCORE_TERMS_URI"] ??
  (process.env["CONSOLE_PUBLIC_URL"]
    ? `${process.env["CONSOLE_PUBLIC_URL"].replace(/\/$/, "")}/terms`
    : "https://console.cocore.dev/terms");

async function main() {
  const firehose = new Firehose();
  const store = new Store(DB_PATH);

  // 1. AppView indexer.
  const indexer = new Indexer(store);
  indexer.subscribe(firehose);

  // 1a. Relay subscription. The AT Protocol firehose at
  //     `wss://bsky.network` mirrors every PDS commit from
  //     subscribed PDSes (including porcini, which hosts most
  //     cocore agents today). Subscribing here means the AppView
  //     stops depending on the bridge endpoint as a correctness
  //     checkpoint — the bridge is now an optimization for
  //     console-published records, not the only path.
  //
  //     Cursor persistence: we store the relay's last-seen seq in
  //     the same SQLite the indexed records live in. On boot we
  //     hand the cursor back to @atproto/sync so the relay resumes
  //     from where we left off (no backfill on every restart).
  //
  //     Disabled when COCORE_RELAY_URL="off" or empty — useful for
  //     unit tests that don't want to hit the wire.
  let relay: RelayFirehose | undefined;
  if (RELAY_ENABLED) {
    const initialCursor = (() => {
      const raw = store.getCursor("relay");
      const n = raw ? Number(raw) : Number.NaN;
      return Number.isFinite(n) ? n : undefined;
    })();
    relay = new RelayFirehose({
      service: RELAY_URL,
      out: firehose,
      unauthenticatedCommits: RELAY_UNAUTHENTICATED,
      ...(initialCursor !== undefined ? { initialCursor } : {}),
      setCursor: async (cursor: number) => {
        // Best-effort: cursor persistence on every event would dwarf
        // the actual indexing work. The runner debounces internally.
        try {
          store.setCursor("relay", String(cursor));
        } catch (e) {
          console.error(`relay: setCursor failed: ${(e as Error).message}`);
        }
      },
    });
    relay.start();
    console.error(
      `relay: subscribed to ${RELAY_URL} cursor=${initialCursor ?? "head"} unauthenticatedCommits=${RELAY_UNAUTHENTICATED}`,
    );
  } else {
    console.error("relay: disabled (COCORE_RELAY_URL unset or 'off')");
  }

  // 2. Exchange. Verifies receipts + publishes settlement records.
  //    Tokens move via the TokenLedger in the firehose hook below.
  const transport = EXCHANGE_API_KEY
    ? new ConsoleProxySettlementTransport({
        apiBase: EXCHANGE_API_BASE,
        apiKey: EXCHANGE_API_KEY,
      })
    : undefined;
  const publisher = new SettlementPublisher(EXCHANGE_DID, transport);
  const signingKey = EXCHANGE_PRIVATE_JWK ? parsePrivateJwk(EXCHANGE_PRIVATE_JWK) : undefined;
  const feePolicy = { bps: FEE_BPS, minMinor: FEE_MIN_MINOR };
  const selfLoop = { feeWaived: SELF_LOOP_FEE_WAIVED };

  // 2a. Bootstrap policy + attestation records. Skipped without an
  //     exchange API key (no real PDS to publish to).
  let policyRef: { uri: string; cid: string } | undefined;
  let attestationRef: { uri: string; cid: string } | undefined;
  if (EXCHANGE_API_KEY) {
    try {
      const refs = await bootstrapExchangeRecords({
        exchangeDid: EXCHANGE_DID,
        apiBase: EXCHANGE_API_BASE,
        apiKey: EXCHANGE_API_KEY,
        feePolicy,
        feeCurrency: FEE_CURRENCY,
        supportedCurrencies: [FEE_CURRENCY],
        selfLoop,
        softwareVersion: SOFTWARE_VERSION,
        signingKey,
        auditPosture: "single-tenant Railway deployment",
        termsUri: TERMS_URI,
        termsVersion: TERMS_VERSION,
        tokenRate: {
          inputPricePerMTok: TOKEN_RATE_INPUT_PER_MTOK,
          outputPricePerMTok: TOKEN_RATE_OUTPUT_PER_MTOK,
          currency: TOKEN_RATE_CURRENCY,
        },
        tokenGrant: TOKEN_GRANT,
        tokenFloor: TOKEN_FLOOR,
        treasuryDid: TREASURY_DID,
        weeklyRefresh: {
          amountPerDid: WEEKLY_REFRESH_AMOUNT,
          cadenceMinutes: REFRESH_CADENCE_MINUTES,
        },
        patronageDistribution: {
          fractionBps: PATRONAGE_FRACTION_BPS,
          cadenceDays: PATRONAGE_CADENCE_DAYS,
        },
      });
      policyRef = refs.policyRef;
      attestationRef = refs.attestationRef;
      console.error(
        `exchange: bootstrapped policy=${refs.policyRef.uri} attestation=${refs.attestationRef.uri}`,
      );
    } catch (e) {
      console.error(
        `exchange: bootstrap failed (continuing without policy/attestation refs): ${(e as Error).message}`,
      );
    }
  }

  const exchange = new Exchange({
    exchangeDid: EXCHANGE_DID,
    feePolicy,
    selfLoop,
    ...(policyRef ? { policyRef } : {}),
    ...(attestationRef ? { attestationRef } : {}),
    ...(signingKey ? { signingKey } : {}),
    publisher,
    resolveRecord: async (uri) => store.get(uri) ?? null,
  });
  // Wrap publisher.publish so settlements re-enter the firehose for
  // any subscriber that watches it directly (tests, etc.).
  const originalPublish = publisher.publish.bind(publisher);
  publisher.publish = async (rec) => {
    const published = await originalPublish(rec);
    await firehose.dispatch({
      uri: published.uri,
      cid: published.cid,
      collection: "dev.cocore.compute.settlement",
      repo: EXCHANGE_DID,
      rkey: published.uri.split("/").pop() ?? "",
      body: rec,
    });
    return published;
  };

  // 2b. TokenLedger. Single source of truth for per-DID balances.
  //     Lazy refresh runs as a side effect of every receipt;
  //     monthly patronage is on a scheduler below.
  const ledgerDb = new Database(TOKEN_LEDGER_DB);
  const ledger = new TokenLedger(ledgerDb);
  const ledgerPolicy: TokenLedgerPolicy = {
    tokenGrant: TOKEN_GRANT,
    tokenFloor: TOKEN_FLOOR,
    treasuryDid: TREASURY_DID,
    treasuryFeeBps: FEE_BPS,
    selfLoopFeeWaived: SELF_LOOP_FEE_WAIVED,
    weeklyRefreshAmount: WEEKLY_REFRESH_AMOUNT,
    refreshCadenceMinutes: REFRESH_CADENCE_MINUTES,
    patronageFractionBps: PATRONAGE_FRACTION_BPS,
    patronageCadenceDays: PATRONAGE_CADENCE_DAYS,
  };
  console.error(
    `token-ledger: db=${TOKEN_LEDGER_DB} grant=${TOKEN_GRANT} floor=${TOKEN_FLOOR} treasuryFee=${FEE_BPS}bps treasury=${TREASURY_DID}`,
  );

  // Settlement pipeline: wires exchange.onReceipt + the pending-
  // receipt queue + token-ledger application together. See
  // `receipt-pipeline.ts` for the full design rationale.
  const pipeline = createReceiptPipeline({
    exchange,
    ledger,
    ledgerPolicy,
    firehose,
    store,
    treasuryDid: TREASURY_DID,
    feeBps: FEE_BPS,
    reconcileBatchSize: RECONCILE_BATCH_SIZE,
  });
  pipeline.attach();

  // 2c. Settlement reconcile loop. Periodically scans the indexer
  //     for indexed receipts that don't yet have a settlement
  //     record, and re-invokes `exchange.onReceipt` for each. This
  //     is the durability backstop for three failure modes:
  //
  //       1. Receipt arrives at the firehose before its dependency
  //          records (the resolve-failed race we just fixed
  //          reactively above) and the dep arrives during a window
  //          where the reactive `firehose.on(null, …)` handler
  //          missed it (e.g. the dep was already in the store
  //          before the receipt was parked).
  //       2. Services container restart. The pending-receipt map
  //          lives in memory; after a restart we re-scan from the
  //          indexed store.
  //       3. The reactive retry's `MAX_RETRIES` budget was exhausted
  //          but the dependency landed later — the reconcile
  //          ignores retry budgets and just tries to settle once
  //          per tick.
  //
  //     `exchange.onReceipt` is idempotent on receipt URI via the
  //     publisher's `settledByReceiptUri` set; the reconcile passes
  //     just no-op once a settlement exists.
  // Kick off the reconcile loop. The actual work lives in
  // `pipeline.reconcileUnsettledReceipts()` — see receipt-pipeline.ts
  // for the design. Use setInterval rather than a recursive
  // setTimeout so a slow reconcile pass doesn't shift the schedule.
  async function reconcileTick(): Promise<void> {
    try {
      const summary = await pipeline.reconcileUnsettledReceipts();
      if (summary.attempted > 0) {
        console.error(
          `reconcile: scanned ${summary.scanned} receipts, attempted ${summary.attempted}, settled ${summary.settled}, still resolve-failed ${summary.stillResolveFailed}, rejected ${summary.rejected}, skipped-terminal ${summary.skippedRejected}`,
        );
      }
    } catch (e) {
      console.error(`reconcile: pass failed: ${(e as Error).message}`);
    }
  }
  if (RECONCILE_INTERVAL_SECONDS > 0) {
    // One eager pass at boot — catches receipts indexed during a
    // services-container outage. Run after a short delay so the
    // appview API + bridge are listening; we want operators to be
    // able to peek at /xrpc state while the reconcile is grinding.
    setTimeout(() => {
      void reconcileTick();
    }, 5_000).unref();
    setInterval(() => {
      void reconcileTick();
    }, RECONCILE_INTERVAL_SECONDS * 1_000).unref();
    console.error(
      `reconcile: enabled (every ${RECONCILE_INTERVAL_SECONDS}s, batch=${RECONCILE_BATCH_SIZE})`,
    );
  }

  // 2d. Monthly patronage scheduler. Fires once on boot for the
  //     window covering the prior calendar month; thereafter sleeps
  //     until the next UTC-month boundary and fires again. Disabled
  //     with COCORE_PATRONAGE_AUTO=0 (manual trigger still works
  //     via the internal endpoint below).
  if (PATRONAGE_AUTO && PATRONAGE_FRACTION_BPS > 0) {
    schedulePatronage(ledger, ledgerPolicy, EXCHANGE_API_KEY, EXCHANGE_API_BASE, policyRef);
  }

  if (AUTORESPOND) {
    await startAutoresponder({
      firehose,
      providerDid: AUTORESPOND_PROVIDER_DID,
      tokenRate: {
        inputPerMTok: TOKEN_RATE_INPUT_PER_MTOK,
        outputPerMTok: TOKEN_RATE_OUTPUT_PER_MTOK,
        currency: TOKEN_RATE_CURRENCY,
      },
    });
  }

  const accountStore = APPVIEW_DID ? new AccountStore(ACCOUNT_DB) : undefined;
  const appviewServer = buildAppviewApi(store, {
    accountStore,
    appviewDid: APPVIEW_DID,
    // The bridge runs in this same process; mirror PDS writes to it.
    bridgeUrl: process.env["COCORE_BRIDGE_URL"] ?? `http://127.0.0.1:${PORT}`,
    internalSecret: process.env["COCORE_INTERNAL_SECRET"],
  });
  await new Promise<void>((r) => appviewServer.listen(APPVIEW_PORT, r));
  console.error(
    `appview-api: listening on :${APPVIEW_PORT} db=${DB_PATH}` +
      (APPVIEW_DID ? ` account=on(aud=${APPVIEW_DID} db=${ACCOUNT_DB})` : ""),
  );

  // 4. Bridge HTTP.
  const bridge = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/healthz") {
        return json(res, 200, { ok: true, exchangeDid: EXCHANGE_DID });
      }
      if (url.pathname === "/xrpc/dev.cocore.bridge.publish" && req.method === "POST") {
        const body = await readJson<IndexedRecord>(req);
        if (!body.uri || !body.cid || !body.collection || !body.repo) {
          return json(res, 400, { error: "missing uri/cid/collection/repo" });
        }
        await firehose.dispatch(body);
        return json(res, 202, { ok: true });
      }
      // Countersign a terms-of-service acceptance with the exchange's
      // signing key, so the published record is a cocore ATTESTATION the
      // exchange witnessed the acceptance — not merely a record the user
      // wrote unilaterally. Internal-only (the signing key never leaves
      // this container); the console calls it with COCORE_INTERNAL_API_KEY,
      // gets back the COMPLETE signed record, and persists it verbatim to
      // the user's PDS under their OAuth session. We build the exact record
      // here (incl `$type` + the `attestation` strong-ref) and sign over its
      // canonical bytes minus `sig`, so a verifier strips `sig`,
      // re-canonicalises, and checks against the key in the referenced
      // exchangeAttestation — the same chain receipts/settlements use.
      if (
        url.pathname === "/xrpc/dev.cocore.exchange.signTermsAcceptance" &&
        req.method === "POST"
      ) {
        if (!authOk(req.headers.authorization)) return json(res, 401, { error: "unauthorized" });
        if (!signingKey) {
          return json(res, 503, { error: "exchange signing key not configured" });
        }
        const body = await readJson<{
          policyUri?: string;
          policyCid?: string;
          termsVersion?: string;
          termsUri?: string;
          userAgent?: string;
        }>(req);
        if (!body.policyUri || !body.policyCid || !body.termsVersion || !body.termsUri) {
          return json(res, 400, {
            error: "missing policyUri/policyCid/termsVersion/termsUri",
          });
        }
        const record: Record<string, unknown> = {
          $type: "dev.cocore.compute.termsAcceptance",
          exchange: EXCHANGE_DID,
          policy: { uri: body.policyUri, cid: body.policyCid },
          termsVersion: body.termsVersion,
          termsUri: body.termsUri,
          ...(body.userAgent ? { userAgent: body.userAgent } : {}),
          acceptedAt: new Date().toISOString(),
          ...(attestationRef
            ? { attestation: { uri: attestationRef.uri, cid: attestationRef.cid } }
            : {}),
        };
        const sig = await signRecord(record, signingKey);
        return json(res, 200, { record: { ...record, sig } });
      }
      if (url.pathname === "/xrpc/dev.cocore.bridge.unpublish" && req.method === "POST") {
        const body = await readJson<{ uri?: string }>(req);
        if (!body.uri) return json(res, 400, { error: "missing uri" });
        store.delete(body.uri);
        return json(res, 200, { ok: true });
      }
      if (url.pathname === "/xrpc/dev.cocore.bridge.purge" && req.method === "POST") {
        const body = await readJson<{ did?: string }>(req);
        if (!body.did) return json(res, 400, { error: "missing did" });
        const removed = store.purgeForDid(body.did);
        return json(res, 200, { ok: true, removed });
      }
      if (url.pathname === "/xrpc/dev.cocore.bridge.stats" && req.method === "GET") {
        return json(res, 200, {
          settled: publisher.alreadySettled().size,
          treasuryBalance: ledger.peekBalance(TREASURY_DID),
        });
      }

      // Read-only diagnostic surface for the receipt pipeline. No
      // auth: the data is pipeline state (URIs, outcome kinds, retry
      // counts) — nothing secret, all of it derivable from public
      // PDS records anyway. Without this endpoint a settlement bug
      // is invisible from outside Railway (the silent-bail failure
      // mode that hit us today). With it, operators can curl this
      // and see exactly why each receipt did or didn't settle:
      //
      //   curl /xrpc/dev.cocore.admin.pipelineState | jq .recentOutcomes
      //
      // Optional ?since=<ISO-8601> filters the recentOutcomes ring
      // to entries newer than the cursor. ?limit=<N> caps the count
      // (default 50, max 200 — the ring buffer size).
      if (url.pathname === "/xrpc/dev.cocore.admin.pipelineState" && req.method === "GET") {
        const since = url.searchParams.get("since");
        const limitRaw = url.searchParams.get("limit");
        const limit = (() => {
          const n = limitRaw ? Number(limitRaw) : 50;
          if (!Number.isFinite(n) || n <= 0) return 50;
          return Math.min(n, 200);
        })();
        const sinceMs = since ? Date.parse(since) : null;
        let recent = pipeline.recentOutcomes();
        if (sinceMs !== null && Number.isFinite(sinceMs)) {
          recent = recent.filter((e) => Date.parse(e.at) > sinceMs);
        }
        recent = recent.slice(0, limit);
        return json(res, 200, {
          generatedAt: new Date().toISOString(),
          pending: pipeline.pendingSnapshot(),
          recentOutcomes: recent,
          publisherSettled: publisher.alreadySettled().size,
          // Quick at-a-glance counters across the ring buffer:
          // helps operators see "are we mostly resolve-failing, or
          // mostly settling, or mostly rejecting?" without
          // scrolling the per-receipt list.
          summary: pipeline.recentOutcomes().reduce(
            (acc, e) => {
              acc[e.kind] = (acc[e.kind] ?? 0) + 1;
              return acc;
            },
            {} as Record<string, number>,
          ),
        });
      }

      // --- Token-ledger HTTP surface -------------------------------
      if (url.pathname === "/xrpc/dev.cocore.exchange.getBalance" && req.method === "GET") {
        const did = url.searchParams.get("did") || "";
        if (!did.startsWith("did:")) return json(res, 400, { error: "invalid did" });
        // Use touchAndGetBalance so a balance read also (a) mints the
        // one-time onboarding grant on first touch and (b) applies any
        // pending weekly refresh. The old peekBalance read was a
        // catch-22: balance read returns 0, admission needs >=floor,
        // grant only fires inside admission or applyReceipt — neither
        // of which a fresh user can reach with a 0 balance.
        const touched = ledger.touchAndGetBalance(did, ledgerPolicy);
        // If the grant just fired, publish the tokenGrant record onto
        // the exchange's PDS so the audit trail is durable beyond
        // the local ledger DB.
        if (touched.pendingGrant && EXCHANGE_API_KEY) {
          emitTokenGrantRecord(did, ledgerPolicy.tokenGrant, policyRef).catch((e) => {
            console.error(`grant: emit record failed for ${did}: ${(e as Error).message}`);
          });
        }
        return json(res, 200, {
          did,
          balance: touched.balance,
          policy: {
            tokenGrant: ledgerPolicy.tokenGrant,
            tokenFloor: ledgerPolicy.tokenFloor,
            treasuryFeeBps: ledgerPolicy.treasuryFeeBps,
            weeklyRefreshAmount: ledgerPolicy.weeklyRefreshAmount,
            refreshCadenceMinutes: ledgerPolicy.refreshCadenceMinutes,
            patronageFractionBps: ledgerPolicy.patronageFractionBps,
            patronageCadenceDays: ledgerPolicy.patronageCadenceDays,
            // Back-compat for the earnings/jobs/machines dashboards
            // that still render USD-equivalents. Display only; not
            // a real exchange rate.
            averagePricePerMTok: Math.floor(
              (TOKEN_RATE_INPUT_PER_MTOK + TOKEN_RATE_OUTPUT_PER_MTOK) / 2,
            ),
          },
        });
      }
      if (url.pathname === "/xrpc/dev.cocore.exchange.leaderboard" && req.method === "GET") {
        // Public leaderboard: largest wallets + biggest earners +
        // biggest spenders. Reads straight off the token ledger (the
        // source of truth for balances and receipt flows). System DIDs
        // (treasury, exchange, autoresponder) are excluded so the board
        // reflects real members, not the cooperative's own books.
        //
        // Memoized for LEADERBOARD_TTL_MS so a hot page doesn't re-scan
        // the ledger per request — the new caching this view needs. The
        // cache key folds in the requested limit.
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 100);
        const cached = readLeaderboardCache(limit);
        if (cached) return json(res, 200, cached);
        const board = ledger.leaderboard({
          limit,
          excludeDids: [TREASURY_DID, EXCHANGE_DID, AUTORESPOND_PROVIDER_DID],
        });
        writeLeaderboardCache(limit, board);
        return json(res, 200, board);
      }
      if (url.pathname === "/xrpc/dev.cocore.exchange.listEvents" && req.method === "GET") {
        const did = url.searchParams.get("did") || "";
        if (!did.startsWith("did:")) return json(res, 400, { error: "invalid did" });
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
        return json(res, 200, { events: ledger.listEvents(did, limit) });
      }
      // Account-page activity bundle: lifetime per-kind aggregates
      // (credited / debited / patronage roll-ups) PLUS a newest-first
      // recent feed, in one round-trip. The summary is over the whole
      // history (so the headline numbers don't drift as the feed
      // window scrolls); `recent` is "desc" so a just-landed patronage
      // rebate shows at the top instead of falling off the end of an
      // oldest-first window — the reason rebates were invisible before.
      if (url.pathname === "/xrpc/dev.cocore.exchange.eventSummary" && req.method === "GET") {
        const did = url.searchParams.get("did") || "";
        if (!did.startsWith("did:")) return json(res, 400, { error: "invalid did" });
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100), 500);
        return json(res, 200, {
          summary: ledger.summarizeEvents(did),
          recent: ledger.listEvents(did, limit, "desc"),
        });
      }
      if (url.pathname === "/xrpc/dev.cocore.exchange.checkAdmission" && req.method === "POST") {
        const body = await readJson<{ did?: string; priceCeilingTokens?: number }>(req);
        if (!body.did || typeof body.priceCeilingTokens !== "number") {
          return json(res, 400, { error: "missing did or priceCeilingTokens" });
        }
        return json(
          res,
          200,
          ledger.checkAdmission(body.did, body.priceCeilingTokens, ledgerPolicy),
        );
      }

      // --- Operator-only ---
      if (
        url.pathname === "/xrpc/dev.cocore.exchange.distributePatronage" &&
        req.method === "POST"
      ) {
        if (!authOk(req.headers.authorization)) {
          return json(res, 401, { error: "unauthorized" });
        }
        const body = await readJson<{ start?: string; end?: string }>(req);
        // Default window: prior calendar month in UTC. The scheduler
        // uses the same default; this manual endpoint exists so an
        // operator can backfill a missed cycle or run a one-off
        // out-of-cadence rebate.
        const now = new Date();
        const start = body.start ? new Date(body.start) : firstOfPriorMonthUtc(now);
        const end = body.end ? new Date(body.end) : firstOfMonthUtc(now);
        const result = ledger.distributePatronage(start, end, ledgerPolicy);
        // Best-effort emit one tokenPatronage record per recipient.
        if (EXCHANGE_API_KEY && policyRef && result.recipients.length > 0) {
          await emitPatronageRecords(
            EXCHANGE_API_BASE,
            EXCHANGE_API_KEY,
            EXCHANGE_DID,
            policyRef,
            { start, end },
            result,
          ).catch((e) => {
            console.error(`patronage: emit records failed: ${(e as Error).message}`);
          });
        }
        return json(res, 200, result);
      }
      // GET: read-only audit, returns the report. POST: same, but
      // also rebuilds the balance cache if drift is detected. Both
      // gated behind the internal API key — even a read leaks the
      // balance snapshot for every DID, and we'd rather not expose
      // that publicly.
      if (url.pathname === "/xrpc/dev.cocore.admin.reconcile") {
        if (!authOk(req.headers.authorization)) {
          return json(res, 401, { error: "unauthorized" });
        }
        const wantsRebuild = req.method === "POST";
        try {
          let report = ledger.reconcile();
          let rebuilt: { changed: number } | null = null;
          if (wantsRebuild && report.balanceCacheDrifts.length > 0) {
            rebuilt = ledger.rebuildBalanceCache();
            report = ledger.reconcile();
          }
          if (!report.ok) {
            console.error(
              `admin.reconcile: drift detected — ${JSON.stringify({
                drifts: report.balanceCacheDrifts.length,
                negatives: report.negativeBalances.length,
                totalDeltaMatchesMints: report.totalDeltaMatchesMints,
                totalBalanceMatchesMints: report.totalBalanceMatchesMints,
              })}`,
            );
          }
          return json(res, 200, { report, ...(rebuilt ? { rebuilt } : {}) });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      }
      if (url.pathname === "/xrpc/dev.cocore.admin.wipe" && req.method === "POST") {
        if (!authOk(req.headers.authorization)) {
          return json(res, 401, { error: "unauthorized" });
        }
        if (process.env["COCORE_ALLOW_WIPE"] !== "1") {
          return json(res, 403, {
            error: "wipe disabled; set COCORE_ALLOW_WIPE=1 on the services container",
          });
        }
        try {
          const counts: Record<string, number> = {};
          counts.records = store.db.prepare("DELETE FROM records").run().changes;
          if (store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='cursor'").get()) {
            counts.cursor = store.db.prepare("DELETE FROM cursor").run().changes;
          }
          for (const table of [
            "token_balance",
            "token_event",
            "processed_receipt",
            "processed_period",
          ]) {
            if (ledgerDb.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table)) {
              counts[table] = ledgerDb.prepare(`DELETE FROM ${table}`).run().changes;
            }
          }
          console.error(`admin.wipe: cleared ${JSON.stringify(counts)}`);
          return json(res, 200, { ok: true, counts });
        } catch (e) {
          return json(res, 500, { error: (e as Error).message });
        }
      }
      json(res, 404, { error: "no such route" });
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((r) => bridge.listen(PORT, r));
  console.error(`bridge: listening on :${PORT}`);

  await new Promise(() => {});
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

// ─── leaderboard cache ───────────────────────────────────────────
// Aggregating the ledger three ways per request would be wasteful for
// a page that turns over slowly; memoize per-limit for a short TTL.
const LEADERBOARD_TTL_MS = Number(process.env["COCORE_LEADERBOARD_TTL_MS"] ?? 60_000);
const leaderboardCache = new Map<number, { at: number; body: unknown }>();

function readLeaderboardCache(limit: number): unknown | null {
  const hit = leaderboardCache.get(limit);
  if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return hit.body;
  return null;
}

function writeLeaderboardCache(limit: number, body: unknown): void {
  leaderboardCache.set(limit, { at: Date.now(), body });
}

function authOk(header: string | string[] | undefined): boolean {
  if (!INTERNAL_API_KEY) return false;
  if (typeof header !== "string") return false;
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return false;
  const presented = m[1] ?? "";
  if (presented.length !== INTERNAL_API_KEY.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(INTERNAL_API_KEY));
}

/** Hard cap on bridge/admin request bodies. The publish path carries a
 *  single indexed record (record body + envelope); 4 MiB is generous and
 *  bounds an otherwise-unbounded read against memory exhaustion. */
const MAX_BRIDGE_BODY_BYTES = 4 * 1024 * 1024;

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > MAX_BRIDGE_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BRIDGE_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T;
}

function firstOfMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

function firstOfPriorMonthUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 0, 0, 0, 0));
}

/** Boot-time scheduler: on every UTC-month boundary, distribute
 *  patronage for the just-completed month. Fires once immediately
 *  for the prior month so a redeploy doesn't skip a cycle. The
 *  ledger's idempotency on (start, end) makes the "fire on boot"
 *  step safe — a second invocation for the same period is a no-op. */
function schedulePatronage(
  ledger: TokenLedger,
  policy: TokenLedgerPolicy,
  apiKey: string | undefined,
  apiBase: string,
  policyRef: { uri: string; cid: string } | undefined,
): void {
  const tick = async () => {
    const now = new Date();
    const start = firstOfPriorMonthUtc(now);
    const end = firstOfMonthUtc(now);
    try {
      const result = ledger.distributePatronage(start, end, policy);
      if (result.alreadyDistributed) {
        console.error(
          `patronage: period ${start.toISOString()}/${end.toISOString()} already distributed`,
        );
      } else if (result.totalDistributed > 0) {
        console.error(
          `patronage: distributed ${result.totalDistributed} tokens to ${result.recipients.length} recipients`,
        );
        if (apiKey && policyRef && result.recipients.length > 0) {
          await emitPatronageRecords(
            apiBase,
            apiKey,
            (policy as TokenLedgerPolicy).treasuryDid,
            policyRef,
            { start, end },
            result,
          ).catch((e) => {
            console.error(`patronage: emit records failed: ${(e as Error).message}`);
          });
        }
      } else {
        console.error(`patronage: no recipients in period ${start.toISOString()}`);
      }
    } catch (e) {
      console.error(`patronage: distribution failed: ${(e as Error).message}`);
    }
    // Next tick: first of next month.
    const next = firstOfMonthUtc(new Date(Date.now() + 32 * 24 * 60 * 60_000));
    const delay = Math.max(60_000, next.getTime() - Date.now());
    setTimeout(tick, delay);
  };
  // Fire on boot for prior month; subsequent firings are scheduled
  // by tick() itself.
  setTimeout(tick, 5_000);
}

interface PatronageResult {
  treasuryBefore: number;
  recipients: Array<{ did: string; patronageScore: number; tokensCredited: number }>;
}

/** Publish a `dev.cocore.account.tokenGrant` record onto the
 *  exchange's PDS when the lazy onboarding grant fires for a fresh
 *  DID. The record is the durable audit trail that survives a local
 *  ledger DB wipe — anyone re-deriving balances offline from
 *  firehose history starts each DID at this amount.
 *
 *  Closures over the bridge's `exchangeDid`, `apiBase`, and `apiKey`
 *  via the call site; failures are logged and swallowed so a grant
 *  is still credited locally even if PDS publish flakes. */
async function emitTokenGrantRecord(
  recipientDid: string,
  amount: number,
  policyRef: { uri: string; cid: string } | undefined,
): Promise<void> {
  if (!EXCHANGE_API_KEY) return;
  if (!policyRef) {
    console.error(
      `grant: skipping PDS publish for ${recipientDid}: no active policyRef yet (bootstrap incomplete?)`,
    );
    return;
  }
  const record = {
    exchange: EXCHANGE_DID,
    recipient: recipientDid,
    amount,
    policy: { uri: policyRef.uri, cid: policyRef.cid },
    createdAt: new Date().toISOString(),
  };
  const r = await fetch(`${EXCHANGE_API_BASE.replace(/\/$/, "")}/api/pds/createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${EXCHANGE_API_KEY}`,
    },
    body: JSON.stringify({ collection: "dev.cocore.account.tokenGrant", record }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`createRecord tokenGrant ${r.status}: ${body.slice(0, 300)}`);
  }
  console.error(`grant: published tokenGrant record for ${recipientDid} (${amount} tokens)`);
}

async function emitPatronageRecords(
  apiBase: string,
  apiKey: string,
  exchangeDid: string,
  policyRef: { uri: string; cid: string },
  period: { start: Date; end: Date },
  result: PatronageResult,
): Promise<void> {
  const totalPatronage = result.recipients.reduce((s, r) => s + r.patronageScore, 0);
  const periodLex = {
    start: period.start.toISOString(),
    end: period.end.toISOString(),
  };
  for (const r of result.recipients) {
    const record = {
      exchange: exchangeDid,
      recipient: r.did,
      period: periodLex,
      patronageScore: r.patronageScore,
      totalPatronage,
      tokensCredited: r.tokensCredited,
      treasuryBefore: result.treasuryBefore,
      policy: { uri: policyRef.uri, cid: policyRef.cid },
      createdAt: new Date().toISOString(),
    };
    await fetch(`${apiBase.replace(/\/$/, "")}/api/pds/createRecord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ collection: "dev.cocore.account.tokenPatronage", record }),
    });
  }
}

// Process-level crash guards. This is a single process running the AppView
// read API, the exchange, the bridge, the indexer, and the relay — without
// these, one stray unhandled rejection or uncaught exception in *any* of them
// (a malformed firehose event, a settlement publish that rejects, a bad
// timer) crashes the whole thing and takes XRPC serving down for every reader.
// We log content-safe (message + stack only; never request/record bodies) and
// keep serving: a genuinely wedged process is caught by the Railway
// healthcheck on /healthz, and splitting the read path from the writers (see
// docs/adr/0001-services-resilience.md) is the structural fix. Availability
// over purity — staying up degraded beats a slow boot-install restart loop.
process.on("unhandledRejection", (reason) => {
  const e = reason instanceof Error ? reason : new Error(String(reason));
  console.error(`services: unhandledRejection — ${e.message}\n${e.stack ?? ""}`);
});
process.on("uncaughtException", (e) => {
  console.error(`services: uncaughtException — ${e.message}\n${e.stack ?? ""}`);
});

main().catch((e) => {
  console.error("cocore-services: fatal", e);
  process.exit(1);
});
