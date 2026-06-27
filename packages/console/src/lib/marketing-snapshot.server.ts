import { Effect } from "effect";

import { cocoreConfig } from "@/lib/cocore-config.ts";
import { runTraced } from "@/lib/o11y.server.ts";
import {
  type AppviewAccountSummary,
  type AppviewIndexedRecord,
  type JsonValue,
  appviewGetReceiptsEffect,
  appviewListAccountsEffect,
  appviewListProfilesEffect,
  appviewListProvidersEffect,
  appviewModelActivityEffect,
} from "@/integrations/appview/appview.server.ts";

/** Public marketing snapshot: hero receipt chain + a few directory stats. */
export type MarketingSnapshot = {
  generatedAt: string;
  hero: {
    receiptUriDisplay: string;
    model: string;
    tokens: string;
    price: string;
    enclaveSigLabel: string;
    charged: string;
    payout: string;
    signedByLine: string;
  };
  stats: {
    machinesOnline: number;
    modelsAvailable: number;
    modelsActiveWeek: number;
    /** Sum of `ramGB` across every online provider record — the
     *  network's combined memory. `ramGB` is a required provider field
     *  so this is a faithful total (modulo records mid-rotation). */
    totalRamGB: number;
    /** Sum of `cpuCores` across providers that report it. `cpuCores`
     *  is optional in the lexicon, so machines on older agents that
     *  didn't publish it simply don't contribute (the total is a
     *  floor, never an overcount). */
    totalCpuCores: number;
    /** From the active policy. Display unit on the stats strip. */
    tokenGrant: number;
    /** Bare integer from `tokenRate.inputPricePerMTok` (assumed equal to
     *  the output rate today; we render one number). */
    tokenRatePerMtok: number;
    /** Network median (p50) TIME-TO-ACK over the last ≤100 jobs, in ms —
     *  measured at the advisor as (request received → `inference_request`
     *  frame handed to the chosen worker's socket). This is the BROKERAGE
     *  latency: how fast cocore routes a job to a live worker (incl. the
     *  preflight liveness round-trip), deliberately excluding worker-side
     *  model-load/prefill/first-token time (that's our /ttft signal, not
     *  the public headline). null when the advisor has no recent samples. */
    ackP50Ms: number | null;
  };
  /** A live, sampled glimpse of the network for the landing page:
   *  some real members, some real machines, and a few real receipts.
   *  Each array is a small random sample (may be empty before the
   *  network has any footprint). */
  live: {
    people: Array<{
      did: string;
      handle: string | null;
      displayName: string | null;
      avatarUrl: string | null;
      isProvider: boolean;
    }>;
    machines: Array<{
      did: string;
      machineLabel: string | null;
      chip: string | null;
      hostHandle: string | null;
      hostDisplayName: string | null;
    }>;
    receipts: Array<{
      model: string;
      tokens: string;
      providerShort: string;
      latencyMs: number | null;
    }>;
  };
  steps: {
    receiptTokens: string;
    receiptPrice: string;
    settlementCharged: string;
    settlementPayout: string;
    settlementFee: string;
  };
};

// Illustrative numbers for the hero chain when the AppView returns
// no real receipts yet. Sized for the current uniform 1:1 rate: a
// 2,000-token completion charges 2,000 tokens, the 95/5 conservation
// split lands the provider at 1,900 and the treasury at 100. The
// default policy values (1M grant, 1M-per-MTok rate) match the env
// defaults the services container ships with — see
// `infra/services/src/main.ts`.
const FALLBACK = {
  hero: {
    receiptUriDisplay: "at://did:plc:k8rj…9pql/dev.cocore.compute.receipt/3lq8m",
    model: "mlx-community/Qwen2.5-0.5B-Instruct-4bit",
    tokens: "in 800 · out 1,200",
    price: "2,000 tokens",
    enclaveSigLabel: "✓ P-256 / SE-bound",
    charged: "2,000 tokens",
    payout: "@provider · 1,900 tokens",
    signedByLine: "signed · @kira.bsky",
  },
  stats: {
    machinesOnline: 0,
    modelsAvailable: 0,
    modelsActiveWeek: 0,
    totalRamGB: 0,
    totalCpuCores: 0,
    tokenGrant: 1_000_000,
    tokenRatePerMtok: 1_000_000,
    ackP50Ms: null,
  },
  live: {
    people: [] as MarketingSnapshot["live"]["people"],
    machines: [] as MarketingSnapshot["live"]["machines"],
    receipts: [] as MarketingSnapshot["live"]["receipts"],
  },
  steps: {
    receiptTokens: "800 in · 1,200 out",
    receiptPrice: "2,000 tokens",
    settlementCharged: "2,000 tokens",
    settlementPayout: "1,900 tokens",
    settlementFee: "100 tokens → treasury",
  },
};

// Cache aggressively — the AppView is hit on every cold render and
// the marketing page is the most-trafficked public surface. 5min
// matches the rule-of-thumb cache life: stale for at most one human
// scroll-back, fresh enough that an operator who just published a
// new policy sees their changes in a coffee break.
const CACHE_TTL_MS = 5 * 60_000;
let cache: { expiresAt: number; snapshot: MarketingSnapshot } | null = null;

const tokenFmt = new Intl.NumberFormat("en-US");

interface PolicySnapshot {
  tokenGrant: number;
  tokenRatePerMtok: number;
}

/** Pull the freshest active `exchangePolicy` directly from the
 *  exchange's PDS — same pattern the terms gate uses, but we keep
 *  it inline to avoid coupling the marketing surface to the gate's
 *  narrower fetcher. Returns null on any failure; the fallback
 *  policy values cover the page until the next cache window. */
async function fetchPolicySnapshot(): Promise<PolicySnapshot | null> {
  const exchangeDid = cocoreConfig().exchangeDid;
  if (!exchangeDid.startsWith("did:plc:")) return null;
  try {
    const plc = await fetch(`https://plc.directory/${encodeURIComponent(exchangeDid)}`);
    if (!plc.ok) return null;
    const doc = (await plc.json()) as {
      service?: Array<{ type?: string; serviceEndpoint?: string }>;
    };
    const svc = (doc.service ?? []).find(
      (s) => s.type === "AtprotoPersonalDataServer" && typeof s.serviceEndpoint === "string",
    );
    const pdsEndpoint = svc?.serviceEndpoint;
    if (!pdsEndpoint) return null;

    const params = new URLSearchParams({
      repo: exchangeDid,
      collection: "dev.cocore.compute.exchangePolicy",
      limit: "20",
    });
    const r = await fetch(
      `${pdsEndpoint.replace(/\/$/, "")}/xrpc/com.atproto.repo.listRecords?${params}`,
    );
    if (!r.ok) return null;
    const body = (await r.json()) as {
      records?: Array<{ value: Record<string, JsonValue> }>;
    };
    const sorted = (body.records ?? []).slice().sort((a, b) => {
      const ac = typeof a.value["createdAt"] === "string" ? (a.value["createdAt"] as string) : "";
      const bc = typeof b.value["createdAt"] === "string" ? (b.value["createdAt"] as string) : "";
      return bc.localeCompare(ac);
    });
    for (const rec of sorted) {
      const v = rec.value;
      if (v["active"] === false) continue;
      const tokenGrant = typeof v["tokenGrant"] === "number" ? v["tokenGrant"] : null;
      const tokenRate = v["tokenRate"];
      let tokenRatePerMtok: number | null = null;
      if (tokenRate && typeof tokenRate === "object" && !Array.isArray(tokenRate)) {
        const tr = tokenRate as Record<string, JsonValue>;
        const inputRate = tr["inputPricePerMTok"];
        if (typeof inputRate === "number") tokenRatePerMtok = inputRate;
      }
      if (tokenGrant === null || tokenRatePerMtok === null) continue;
      return { tokenGrant, tokenRatePerMtok };
    }
    return null;
  } catch {
    return null;
  }
}

function shortDid(did: string): string {
  if (did.length <= 22) return did;
  return `${did.slice(0, 12)}…${did.slice(-6)}`;
}

function shortAtUri(uri: string): string {
  const m = /^at:\/\/([^/]+)\/(.+)$/.exec(uri.trim());
  const did = m?.[1];
  const rest = m?.[2];
  if (!did || !rest) return uri;
  return `at://${shortDid(did)}/${rest}`;
}

function formatTokensLine(inTok: number, outTok: number): string {
  return `in ${tokenFmt.format(inTok)} · out ${tokenFmt.format(outTok)}`;
}

function formatStepTokensLine(inTok: number, outTok: number): string {
  return `${tokenFmt.format(inTok)} in · ${tokenFmt.format(outTok)} out`;
}

function parseReceiptBody(body: JsonValue): {
  model: string;
  tokensIn: number;
  tokensOut: number;
  requester: string | null;
  provider: string | null;
  hasEnclaveSig: boolean;
} | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, JsonValue>;
  const model = o["model"];
  if (typeof model !== "string" || model.length === 0) return null;
  const tokens = o["tokens"];
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const t = tokens as Record<string, JsonValue>;
  const tin = t["in"];
  const tout = t["out"];
  if (typeof tin !== "number" || typeof tout !== "number") return null;
  if (!Number.isFinite(tin) || !Number.isFinite(tout)) return null;
  // The receipt's `price` field is what the agent's local pricing
  // table happened to compute — pre-v0.4.1 binaries emit USD with
  // tiny cent amounts that display as "$0.0000". The ledger ignores
  // it (uses tokens.in + tokens.out at the canonical 1:1 rate); we
  // do the same for marketing display.
  const requester = typeof o["requester"] === "string" ? (o["requester"] as string) : null;
  const provider = typeof o["provider"] === "string" ? (o["provider"] as string) : null;
  const es = o["enclaveSignature"];
  const hasEnclaveSig =
    (typeof es === "string" && es.length > 0) || (Array.isArray(es) && es.length > 0);
  return { model, tokensIn: tin, tokensOut: tout, requester, provider, hasEnclaveSig };
}

/** Fisher–Yates sample: return up to `n` random items from `arr`
 *  without mutating it. Used to keep the landing-page "live" glimpse
 *  fresh-looking across renders without leaning on any single record. */
function sampleRandom<T>(arr: readonly T[], n: number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, n);
}

/** Latency in ms from a receipt body's signed startedAt/completedAt
 *  pair. null when either is missing/malformed or the delta is
 *  negative. Mirrors the AppView's `parseReceiptLatency`. */
function receiptLatencyMs(body: JsonValue): number | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const o = body as Record<string, JsonValue>;
  const startedAt = o["startedAt"];
  const completedAt = o["completedAt"];
  if (typeof startedAt !== "string" || typeof completedAt !== "string") return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const ms = end - start;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** Lift a profile-record body into displayable host fields. */
function profileChip(body: JsonValue): { handle: string | null; displayName: string | null } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { handle: null, displayName: null };
  }
  const o = body as Record<string, JsonValue>;
  const handle = typeof o["handle"] === "string" && o["handle"].length > 0 ? o["handle"] : null;
  const displayName =
    typeof o["displayName"] === "string" && o["displayName"].length > 0 ? o["displayName"] : null;
  return { handle, displayName };
}

function uniqueModelsFromProviders(rows: AppviewIndexedRecord[]): number {
  const ids = new Set<string>();
  for (const row of rows) {
    const body = row.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const sm = (body as Record<string, JsonValue>)["supportedModels"];
    if (!Array.isArray(sm)) continue;
    for (const id of sm) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return ids.size;
}

/** Sum the network's hardware across provider records: combined RAM
 *  (GB) and combined CPU cores. Reads the raw provider bodies that
 *  `listProviders` returns, so no AppView change is needed — `ramGB`
 *  is required and `cpuCores` is optional, so a machine missing
 *  `cpuCores` contributes its RAM but not cores (the core total is a
 *  floor). */
function sumProviderHardware(rows: AppviewIndexedRecord[]): {
  totalRamGB: number;
  totalCpuCores: number;
} {
  let totalRamGB = 0;
  let totalCpuCores = 0;
  for (const row of rows) {
    const body = row.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) continue;
    const o = body as Record<string, JsonValue>;
    if (typeof o["ramGB"] === "number" && Number.isFinite(o["ramGB"]) && o["ramGB"] > 0) {
      totalRamGB += o["ramGB"];
    }
    if (typeof o["cpuCores"] === "number" && Number.isFinite(o["cpuCores"]) && o["cpuCores"] > 0) {
      totalCpuCores += o["cpuCores"];
    }
  }
  return { totalRamGB, totalCpuCores };
}

/** Fetch the advisor's rolling time-to-ack p50 (ms) for the public latency
 *  headline — (request received → `inference_request` frame handed to the
 *  chosen worker's socket), the brokerage number: how fast we route a job to
 *  a live worker, excluding the worker's own model-load/prefill/generation.
 *  Best-effort: a slow/unreachable advisor must not stall or fail the
 *  marketing page, so we time out fast and return null (the stat then renders
 *  its fallback). `advisorUrl` is the HTTP base (same one dispatch hits for
 *  `/providers` and `/jobs`). */
async function fetchAdvisorAckP50Ms(): Promise<number | null> {
  try {
    const base = cocoreConfig().advisorUrl.replace(/\/$/, "");
    const r = await fetch(`${base}/ack`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(2_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { p50Ms?: unknown };
    return typeof body.p50Ms === "number" && Number.isFinite(body.p50Ms) ? body.p50Ms : null;
  } catch {
    return null;
  }
}

async function buildMarketingSnapshot(): Promise<MarketingSnapshot> {
  const generatedAt = new Date().toISOString();

  const [[receiptsR, providersR, activityR, accountsR, profilesR], ackP50Ms, policy] =
    await Promise.all([
      // One root span, five concurrent child `appview.request` spans —
      // each appview effect carries its own span (see appview.server.ts).
      runTraced(
        "marketing.snapshot.appview",
        Effect.all(
          [
            Effect.either(appviewGetReceiptsEffect({})),
            Effect.either(appviewListProvidersEffect),
            Effect.either(appviewModelActivityEffect),
            Effect.either(appviewListAccountsEffect({ limit: 60, sortBy: "recent" })),
            Effect.either(appviewListProfilesEffect),
          ],
          { concurrency: "unbounded" },
        ),
      ),
      fetchAdvisorAckP50Ms(),
      fetchPolicySnapshot(),
    ]);

  const providers =
    providersR._tag === "Right" ? providersR.right.providers : ([] as AppviewIndexedRecord[]);
  const machinesOnline = providers.length;
  const modelsAvailable = uniqueModelsFromProviders(providers);
  const { totalRamGB, totalCpuCores } = sumProviderHardware(providers);
  const modelsActiveWeek =
    activityR._tag === "Right"
      ? activityR.right.models.filter((m) => m.totals.week.requests > 0).length
      : 0;
  const stats: MarketingSnapshot["stats"] = {
    machinesOnline,
    modelsAvailable,
    modelsActiveWeek,
    totalRamGB,
    totalCpuCores,
    tokenGrant: policy?.tokenGrant ?? FALLBACK.stats.tokenGrant,
    tokenRatePerMtok: policy?.tokenRatePerMtok ?? FALLBACK.stats.tokenRatePerMtok,
    ackP50Ms,
  };

  // ── Live glimpse: real members, machines, receipts. ──────────
  const accounts: AppviewAccountSummary[] =
    accountsR._tag === "Right" ? accountsR.right.accounts : [];
  // Prefer accounts that have a handle/display name to show (a bare
  // DID card is dull), but fall back to all of them so the section
  // never starves on a young network.
  const namedAccounts = accounts.filter((a) => a.handle || a.displayName);
  const livePeople = sampleRandom(namedAccounts.length >= 4 ? namedAccounts : accounts, 6).map(
    (a) => ({
      did: a.did,
      handle: a.handle,
      displayName: a.displayName,
      avatarUrl: a.avatarUrl,
      isProvider: a.isProvider,
    }),
  );

  const profilesByDid = new Map<string, { handle: string | null; displayName: string | null }>();
  if (profilesR._tag === "Right") {
    for (const row of profilesR.right.profiles) {
      profilesByDid.set(row.repo, profileChip(row.body));
    }
  }
  const liveMachines = sampleRandom(providers, 6).map((row) => {
    const body =
      row.body && typeof row.body === "object" && !Array.isArray(row.body)
        ? (row.body as Record<string, JsonValue>)
        : {};
    const machineLabel =
      typeof body["machineLabel"] === "string" && body["machineLabel"].length > 0
        ? (body["machineLabel"] as string)
        : null;
    const chip =
      typeof body["chip"] === "string" && body["chip"].length > 0 ? (body["chip"] as string) : null;
    const host = profilesByDid.get(row.repo);
    return {
      did: row.repo,
      machineLabel,
      chip,
      hostHandle: host?.handle ?? null,
      hostDisplayName: host?.displayName ?? null,
    };
  });

  const allReceipts = receiptsR._tag === "Right" ? receiptsR.right.receipts : [];
  const liveReceipts: MarketingSnapshot["live"]["receipts"] = [];
  for (const r of allReceipts) {
    const p = parseReceiptBody(r.body);
    if (!p) continue;
    liveReceipts.push({
      model: p.model,
      tokens: formatTokensLine(p.tokensIn, p.tokensOut),
      providerShort: shortDid(r.repo),
      latencyMs: receiptLatencyMs(r.body),
    });
    if (liveReceipts.length >= 5) break;
  }

  const live: MarketingSnapshot["live"] = {
    people: livePeople,
    machines: liveMachines,
    receipts: liveReceipts,
  };

  if (receiptsR._tag === "Left" || receiptsR.right.receipts.length === 0) {
    return { generatedAt, hero: FALLBACK.hero, steps: FALLBACK.steps, stats, live };
  }

  const receipt = receiptsR.right.receipts[0];
  if (!receipt) {
    return { generatedAt, hero: FALLBACK.hero, steps: FALLBACK.steps, stats, live };
  }
  const parsed = parseReceiptBody(receipt.body);
  if (!parsed) {
    return { generatedAt, hero: FALLBACK.hero, steps: FALLBACK.steps, stats, live };
  }

  const receiptUri = receipt.uri;
  const tokensStr = formatTokensLine(parsed.tokensIn, parsed.tokensOut);
  const enclaveSigLabel = parsed.hasEnclaveSig ? "✓ P-256 / SE-bound" : "—";
  const signedByLine = `signed · ${shortDid(receipt.repo)}`;

  // Canonical receipt cost at the exchange's uniform 1:1 rate. The
  // ledger's applyReceipt() uses exactly this number for the
  // conservation transfer — we display it the same way rather than
  // trust the agent's local `price.amount` (legacy v0.4.0 binaries
  // emit USD-cent amounts that display as "$0.0000").
  const receiptTokens = parsed.tokensIn + parsed.tokensOut;
  const isSelfLoop =
    parsed.requester !== null && parsed.provider !== null && parsed.requester === parsed.provider;
  // 95/5 conservation split; on self-loop the fee is waived and the
  // user nets to zero. Mirrors `applyReceipt` in
  // `packages/exchange/src/token-balance.ts`.
  const providerShare = isSelfLoop
    ? receiptTokens
    : Math.floor((receiptTokens * (10000 - 500)) / 10000);
  const treasuryShare = receiptTokens - providerShare;

  const priceStr = `${tokenFmt.format(receiptTokens)} tokens`;
  const heroCharged = priceStr;
  const heroPayout = `${shortDid(receipt.repo)} · ${tokenFmt.format(providerShare)} tokens`;
  const stepCharged = heroCharged;
  const stepPayout = `${tokenFmt.format(providerShare)} tokens`;
  const settlementFee =
    treasuryShare === 0 ? "0 (self-loop)" : `${tokenFmt.format(treasuryShare)} tokens → treasury`;

  const hero: MarketingSnapshot["hero"] = {
    receiptUriDisplay: shortAtUri(receiptUri),
    model: parsed.model,
    tokens: tokensStr,
    price: priceStr,
    enclaveSigLabel,
    charged: heroCharged,
    payout: heroPayout,
    signedByLine,
  };

  const steps: MarketingSnapshot["steps"] = {
    receiptTokens: formatStepTokensLine(parsed.tokensIn, parsed.tokensOut),
    receiptPrice: priceStr,
    settlementCharged: stepCharged,
    settlementPayout: stepPayout,
    settlementFee,
  };

  return { generatedAt, hero, steps, stats, live };
}

/**
 * Cached snapshot for the public marketing page. TTL keeps AppView load low
 * while navigation/SSR stays snappy.
 */
export async function getMarketingSnapshotCached(): Promise<MarketingSnapshot> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    return cache.snapshot;
  }
  const snapshot = await buildMarketingSnapshot();
  cache = { expiresAt: now + CACHE_TTL_MS, snapshot };
  return snapshot;
}
