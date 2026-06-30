#!/usr/bin/env node
// Cross-PDS settlement-backlog audit.
//
// The in-process backfill (`dev.cocore.admin.backfillSettlements`) only sees
// what the AppView has INDEXED, newest-first, capped at 20k. That is a cache.
// The provider PDSes are the source of truth (core invariant #1), so the only
// way to know the FULL backlog — and to catch receipts the firehose never
// indexed — is to walk each provider's repo directly.
//
// What this does:
//   1. Discover every provider account the AppView knows (paginated).
//   2. For each, page through their PDS for `dev.cocore.compute.receipt`
//      records — the authoritative receipt set, not the AppView's view of it.
//   3. Build the settled set from the exchange's own PDS
//      (`dev.cocore.compute.settlement` → receipt.uri).
//   4. For every unsettled receipt, resolve its job + payment authorization +
//      attestation and run the REAL settler (`verifyForChargeStrict`), then
//      bucket by outcome.
//
// The important output is the RECOVERABLE bucket: receipts that verify clean
// right now (auth not yet expired). Those are real money still on the table —
// back them up immediately, before their ~1h authorization windows close too.
// Everything in `auth-expired` is unrecoverable: the authorization lapsed
// during the outage and can never be charged. This is an audit, not a writer —
// it never mutates anything.
//
// Run it from inside the AppView container (so provider discovery can reach the
// internal API and there's egress to every PDS):
//
//   COCORE_APPVIEW_URL=http://localhost:8081 \
//   node --experimental-strip-types scripts/audit-settlement-backlog.ts
//
// Options (env or flag):
//   COCORE_APPVIEW_URL   base for provider discovery (default http://localhost:8081)
//   COCORE_EXCHANGE_DID  exchange repo holding settlements (default the prod exchange)
//   --providers a,b,c    skip discovery, audit exactly these provider DIDs
//   --out PATH           write the recoverable receipts as JSON (default ./settlement-backlog-recoverable.json)
//   --concurrency N      parallel receipt verifications (default 8)

import { resolveRecordOverPds, resolvePdsEndpoint } from "../packages/sdk/src/resolve.ts";
import { verifyForChargeStrict } from "../packages/sdk/src/validate.ts";
import { writeFileSync } from "node:fs";

const APPVIEW_URL = (process.env.COCORE_APPVIEW_URL ?? "http://localhost:8081").replace(/\/$/, "");
const EXCHANGE_DID = process.env.COCORE_EXCHANGE_DID ?? "did:plc:5quuhkmwe2q4k3azfsgg7kdz";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const OUT = flag("out") ?? "./settlement-backlog-recoverable.json";
const CONCURRENCY = Math.max(1, Number(flag("concurrency") ?? 8) || 8);

interface PdsRecord {
  uri: string;
  cid: string;
  value: Record<string, unknown>;
}

/** Page through every record of one collection in a repo, straight from its
 *  PDS (source of truth), following the listRecords cursor to exhaustion. */
async function listAllRecords(did: string, collection: string): Promise<PdsRecord[]> {
  const pds = await resolvePdsEndpoint(did);
  const out: PdsRecord[] = [];
  let cursor: string | undefined;
  do {
    const u = new URL(`${pds}/xrpc/com.atproto.repo.listRecords`);
    u.searchParams.set("repo", did);
    u.searchParams.set("collection", collection);
    u.searchParams.set("limit", "100");
    if (cursor) u.searchParams.set("cursor", cursor);
    const res = await fetch(u);
    if (!res.ok) throw new Error(`listRecords ${res.status} for ${did}/${collection}`);
    const j = (await res.json()) as { records?: PdsRecord[]; cursor?: string };
    if (j.records?.length) out.push(...j.records);
    cursor = j.cursor && j.records?.length ? j.cursor : undefined;
  } while (cursor);
  return out;
}

/** Provider DIDs to audit: an explicit --providers list, else every
 *  provider-flagged account the AppView knows (paginated to exhaustion). */
async function discoverProviders(): Promise<string[]> {
  const explicit = flag("providers");
  if (explicit) return explicit.split(",").map((s) => s.trim()).filter((s) => s.startsWith("did:"));
  const dids = new Set<string>();
  let offset = 0;
  const limit = 100;
  for (;;) {
    const u = new URL(`${APPVIEW_URL}/xrpc/dev.cocore.account.listAccounts`);
    u.searchParams.set("providersOnly", "true");
    u.searchParams.set("limit", String(limit));
    u.searchParams.set("offset", String(offset));
    const res = await fetch(u);
    if (!res.ok) throw new Error(`listAccounts ${res.status} from ${APPVIEW_URL}`);
    const j = (await res.json()) as { accounts?: Array<{ did: string }>; total?: number };
    for (const a of j.accounts ?? []) if (a.did?.startsWith("did:")) dids.add(a.did);
    offset += limit;
    if (!j.accounts?.length || offset >= (j.total ?? 0)) break;
  }
  return [...dids];
}

/** Run the real settler on one unsettled receipt. Resolves the job, payment
 *  authorization and attestation from their owning PDSes, exactly as the
 *  exchange would, then returns the finding codes (or a resolve-failure). */
async function classify(
  receiptUri: string,
  receipt: Record<string, unknown>,
  settled: Set<string>,
): Promise<{ codes: string[]; price?: unknown; provider: string; completedAt?: string }> {
  const provider = receiptUri.split("/")[2] ?? "";
  try {
    const jobRef = receipt["job"] as { uri?: string } | undefined;
    const attRef = receipt["attestation"] as { uri?: string } | undefined;
    if (!jobRef?.uri || !attRef?.uri) return { codes: ["malformed-receipt"], provider };
    const job = await resolveRecordOverPds(jobRef.uri);
    const authRef = (job.body as { paymentAuthorization?: { uri?: string; cid?: string } })
      .paymentAuthorization;
    if (!authRef?.uri) return { codes: ["no-payment-authorization"], provider };
    const auth = await resolveRecordOverPds(authRef.uri);
    const att = await resolveRecordOverPds(attRef.uri);
    const report = await verifyForChargeStrict(
      { exchangeDid: EXCHANGE_DID, settledReceipts: settled },
      {
        receipt: receipt as never,
        receiptUri,
        job: job.body as never,
        jobOwnerDid: job.repo,
        authorization: auth.body as never,
        authorizationUri: { uri: authRef.uri, cid: authRef.cid ?? "" },
      },
      att.body as never,
    );
    return {
      codes: report.ok ? [] : report.findings.map((f: { code: string }) => f.code),
      price: (receipt as { price?: unknown }).price,
      provider,
      completedAt: (receipt as { completedAt?: string }).completedAt,
    };
  } catch (e) {
    return { codes: [`resolve-failed:${(e as Error).message.slice(0, 40)}`], provider };
  }
}

async function mapPool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const idx = i++;
        if (idx >= items.length) return;
        out[idx] = await fn(items[idx]!);
      }
    }),
  );
  return out;
}

async function main() {
  console.error(`# settlement-backlog audit`);
  console.error(`appview=${APPVIEW_URL} exchange=${EXCHANGE_DID} concurrency=${CONCURRENCY}\n`);

  // 1. Settled set — the exchange's own settlement records (source of truth for
  //    "this receipt was paid"). Built first so the walk can diff against it.
  console.error(`resolving settlements from exchange PDS…`);
  const settlements = await listAllRecords(EXCHANGE_DID, "dev.cocore.compute.settlement");
  const settled = new Set<string>();
  for (const s of settlements) {
    const u = (s.value["receipt"] as { uri?: string } | undefined)?.uri;
    if (u) settled.add(u);
  }
  console.error(`  ${settlements.length} settlements → ${settled.size} distinct settled receipts\n`);

  // 2. Providers, then every receipt in each provider's repo.
  const providers = await discoverProviders();
  console.error(`auditing ${providers.length} provider repos…`);
  const receipts: Array<{ uri: string; value: Record<string, unknown> }> = [];
  const perProvider = new Map<string, number>();
  for (const did of providers) {
    try {
      const recs = await listAllRecords(did, "dev.cocore.compute.receipt");
      perProvider.set(did, recs.length);
      for (const r of recs) receipts.push({ uri: r.uri, value: r.value });
    } catch (e) {
      console.error(`  ! ${did}: ${(e as Error).message}`);
    }
  }
  const unsettled = receipts.filter((r) => !settled.has(r.uri));
  console.error(
    `  ${receipts.length} receipts across ${providers.length} providers; ` +
      `${receipts.length - unsettled.length} already settled, ${unsettled.length} unsettled\n`,
  );

  // 3. Classify every unsettled receipt through the real settler.
  console.error(`verifying ${unsettled.length} unsettled receipts…`);
  const results = await mapPool(unsettled, CONCURRENCY, (r) => classify(r.uri, r.value, settled));

  const buckets = new Map<string, number>();
  const recoverable: Array<{ uri: string; provider: string; price: unknown; completedAt?: string }> =
    [];
  for (const r of results) {
    const key = r.codes.length === 0 ? "RECOVERABLE" : r.codes.slice().sort().join("+");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    if (r.codes.length === 0)
      recoverable.push({ uri: r.uri, provider: r.provider, price: r.price, completedAt: r.completedAt });
  }

  // 4. Report.
  console.log(`\n=== settlement backlog ===`);
  console.log(`providers audited     ${providers.length}`);
  console.log(`receipts (all PDSes)  ${receipts.length}`);
  console.log(`already settled       ${receipts.length - unsettled.length}`);
  console.log(`unsettled             ${unsettled.length}`);
  console.log(`\n--- unsettled by outcome (most common first) ---`);
  for (const [code, n] of [...buckets.entries()].sort((a, b) => b[1] - a[1])) {
    const tag = code === "RECOVERABLE" ? "✅ RECOVERABLE (back these up NOW)" : code;
    console.log(`${String(n).padStart(6)}  ${tag}`);
  }

  if (recoverable.length > 0) {
    writeFileSync(OUT, JSON.stringify(recoverable, null, 2));
    const provs = [...new Set(recoverable.map((r) => r.provider))];
    const since = recoverable
      .map((r) => r.completedAt)
      .filter((x): x is string => !!x)
      .sort()[0];
    console.log(`\n${recoverable.length} recoverable receipts written to ${OUT}`);
    console.log(`Drain them now with a scoped backfill (inside the AppView container):`);
    console.log(
      `  node -e 'fetch("http://localhost:8080/xrpc/dev.cocore.admin.backfillSettlements",` +
        `{method:"POST",headers:{authorization:"Bearer "+process.env.COCORE_INTERNAL_API_KEY,` +
        `"content-type":"application/json"},body:JSON.stringify(` +
        JSON.stringify({ limit: 20000, clearRejected: true, providers: provs, since }) +
        `)}).then(r=>r.text()).then(console.log)'`,
    );
  } else {
    console.log(`\nNo recoverable receipts — nothing to back up. The rest are genuinely unsettleable.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
