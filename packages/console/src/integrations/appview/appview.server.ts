import { Duration, Effect, Schedule } from "effect";

/** JSON subset TanStack server functions can serialize across the RPC boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** AppView indexer row; `body` is the lexicon record JSON. */
export type AppviewIndexedRecord = {
  uri: string;
  cid: string;
  collection: string;
  repo: string;
  rkey: string;
  body: JsonValue;
  indexedAt?: string;
};
let warnedMissingAppviewUrl = false;

function getAppviewBaseUrl(): string {
  const fromEnv = process.env["COCORE_APPVIEW_URL"]?.trim() || process.env["APPVIEW"]?.trim() || "";
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  if (!warnedMissingAppviewUrl) {
    warnedMissingAppviewUrl = true;
    console.warn(
      "[appview] COCORE_APPVIEW_URL is not set; falling back to http://localhost:8081. " +
        "On Railway this means the env var was wiped — every AppView call will fail.",
    );
  }
  return "http://localhost:8081";
}

export class AppviewFetchError extends Error {
  readonly _tag = "AppviewFetchError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppviewFetchError";
  }
}

export type AppviewListProvidersResponse = { providers: AppviewIndexedRecord[] };
export type AppviewListProfilesResponse = { profiles: AppviewIndexedRecord[] };

/** One entry in the AppView's `listAccounts` directory response.
 *  Mirrors `AccountSummary` on the AppView side; kept in sync by
 *  the cross-package test that exercises this endpoint end-to-end. */
export interface AppviewAccountSummary {
  did: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  joinedAt: string;
  lastActivityAt: string;
  providerCount: number;
  isProvider: boolean;
}

export type AppviewListAccountsResponse = {
  accounts: AppviewAccountSummary[];
  total: number;
  limit: number;
  offset: number;
  sortBy: "recent" | "newest";
  providersOnly: boolean;
  excludeViewerFriends: boolean;
  /** Echoed when the request included `q`. */
  q?: string;
};

/** Per-machine row inside `AppviewProfilePagePayload.machines`. */
interface AppviewProfileMachineSummary {
  rkey: string;
  machineLabel: string | null;
  chip: string | null;
  ramGB: number | null;
  supportedModels: string[];
  active: boolean | null;
  createdAt: string | null;
  trustLevel: string | null;
}

/** Weekly buckets for profile sparklines (52 entries, oldest first). */
export interface AppviewProfileWeekSeries {
  oldestWeekStart: string;
  jobsDispatched: number[];
  receiptsServed: number[];
  machinesIndexedCumulative: number[];
  tokensIndexed: number[];
  trustedByNew: number[];
}

/** Full payload returned by `dev.cocore.account.getProfile`. Mirrors
 *  `ProfilePagePayload` on the AppView side; kept in sync by the
 *  cross-package convention that the UI consumes this verbatim. */
export interface AppviewProfilePagePayload {
  did: string;
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  joinedAt: string | null;
  lastActivityAt: string | null;
  machines: AppviewProfileMachineSummary[];
  jobCount: number;
  receiptCount: number;
  incomingFriendsCount: number;
  weekSeries: AppviewProfileWeekSeries;
  /** Inference latency over this DID's last (≤100) receipts. Older
   *  AppView builds may omit this; treat as absent → no samples. */
  latency?: AppviewLatencyStats;
}

/** Latency summary over a group's most-recent (≤100) receipts.
 *  Mirrors `LatencyStats` on the AppView side. Not exported — it's
 *  only referenced by the response + profile types in this file;
 *  consumers reach it through those. */
interface AppviewLatencyStats {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  avgMs: number | null;
  lastMs: number | null;
}

type AppviewGetProfileResponse = { profile: AppviewProfilePagePayload };

export interface AppviewIncomingFriend {
  friender: string;
  frienderHandle: string | null;
  createdAt: string;
}

export type AppviewListIncomingFriendsResponse = {
  friends: AppviewIncomingFriend[];
  total: number;
};

/** One directed trust edge for the network explorer's friend graph. */
export interface AppviewFriendEdge {
  friender: string;
  subject: string;
  createdAt: string;
}
export type AppviewListFriendEdgesResponse = {
  edges: AppviewFriendEdge[];
  total: number;
};
export type AppviewGetReceiptsResponse = { receipts: AppviewIndexedRecord[] };
export type AppviewGetJobsResponse = { jobs: AppviewIndexedRecord[] };
export type AppviewGetSettlementsResponse = { settlements: AppviewIndexedRecord[] };

export interface AppviewActivityStats {
  hour: { requests: number; tokens: number };
  day: { requests: number; tokens: number };
  week: { requests: number; tokens: number };
  month: { requests: number; tokens: number };
}

interface AppviewModelActivityEntry {
  modelId: string;
  totals: AppviewActivityStats;
  byProvider: Array<{ did: string; stats: AppviewActivityStats }>;
}

export type AppviewModelActivityResponse = {
  generatedAt: string;
  models: AppviewModelActivityEntry[];
};

export type AppviewVerifyReceiptResponse = {
  ok: boolean;
  trustLevel?: "self-attested" | "hardware-attested";
  findings: Array<{ severity: string; code: string; message: string }>;
};

export type AppviewVerifySettlementResponse = {
  ok: boolean;
  findings: Array<{ severity: string; code: string; message: string }>;
};

function buildUrl(path: string, search: URLSearchParams): string {
  const base = getAppviewBaseUrl();
  const q = search.toString();
  return q ? `${base}${path}?${q}` : `${base}${path}`;
}

/** Fail a single AppView call fast instead of hanging on a black-holing
 *  private network (Railway's `*.railway.internal` mesh can drop packets
 *  without RST during their networking migrations). Shorter than before
 *  because we now retry, so the worst-case total stays bounded. */
const APPVIEW_FETCH_TIMEOUT_MS = 6_000;

/** A transient AppView failure (network drop or 5xx) is worth a couple of
 *  quick retries — most blips recover within a second. We never retry a 4xx:
 *  a 404 is a real "not found" (getProfile relies on it), not a transient. */
function isTransient(e: AppviewFetchError): boolean {
  return e.status === 0 || e.status >= 500;
}

const appviewRetrySchedule = Schedule.intersect(
  Schedule.exponential(Duration.millis(250), 2),
  Schedule.recurs(2),
);

/** Last-known-good response per URL. When the AppView is briefly down, the
 *  console serves slightly-stale data and stays usable instead of erroring
 *  the whole page — the AppView is a cache anyway, so stale reads are safe.
 *  Only used as a *fallback* after a transient failure, never to skip a live
 *  fetch, and only within the staleness window below. */
const appviewResponseCache = new Map<string, { at: number; value: unknown }>();
const APPVIEW_STALE_MAX_MS = 10 * 60_000;

function appviewFetchOnceEffect<T>(url: string): Effect.Effect<T, AppviewFetchError> {
  return Effect.async((resume) => {
    void fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(APPVIEW_FETCH_TIMEOUT_MS),
    }).then(
      async (res) => {
        const text = await res.text();
        if (!res.ok) {
          resume(
            Effect.fail(
              new AppviewFetchError(res.status, text.slice(0, 500) || `HTTP ${res.status}`),
            ),
          );
          return;
        }
        try {
          resume(Effect.succeed(JSON.parse(text) as T));
        } catch (e) {
          resume(
            Effect.fail(
              new AppviewFetchError(500, `invalid JSON from AppView: ${(e as Error).message}`),
            ),
          );
        }
      },
      (e: unknown) => {
        // Network-level failure (no HTTP response). Undici hides the
        // useful part ("fetch failed") behind `cause`; surface the
        // syscall code (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, …) and
        // the target URL so a Railway private-networking outage is
        // diagnosable from the log line alone.
        const message = e instanceof Error ? e.message : String(e);
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message;
        resume(
          Effect.fail(
            new AppviewFetchError(0, `${message}${detail ? ` (${detail})` : ""} — GET ${url}`),
          ),
        );
      },
    );
  });
}

/** GET JSON from the AppView HTTP API, with retry-on-transient and a
 *  stale-cache fallback so a brief AppView outage degrades the console
 *  instead of breaking it. */
function appviewGetJsonEffect<T>(
  path: string,
  search: URLSearchParams,
): Effect.Effect<T, AppviewFetchError> {
  const url = buildUrl(path, search);
  return Effect.gen(function* () {
    const fetched = yield* Effect.either(
      appviewFetchOnceEffect<T>(url).pipe(
        Effect.retry({ schedule: appviewRetrySchedule, while: isTransient }),
      ),
    );
    if (fetched._tag === "Right") {
      appviewResponseCache.set(url, { at: Date.now(), value: fetched.right });
      return fetched.right;
    }
    // Transient failure → serve last-known-good if it's fresh enough. A 4xx
    // (e.g. 404) is a real answer, not an outage, so let it fail through.
    if (isTransient(fetched.left)) {
      const cached = appviewResponseCache.get(url);
      if (cached && Date.now() - cached.at <= APPVIEW_STALE_MAX_MS) {
        console.warn(
          `[appview] serving stale (${Math.round((Date.now() - cached.at) / 1000)}s old) after ${fetched.left.message}`,
        );
        return cached.value as T;
      }
    }
    return yield* Effect.fail(fetched.left);
  });
}

export const appviewListProvidersEffect: Effect.Effect<
  AppviewListProvidersResponse,
  AppviewFetchError
> = appviewGetJsonEffect("/xrpc/dev.cocore.compute.listProviders", new URLSearchParams());

export const appviewListProfilesEffect: Effect.Effect<
  AppviewListProfilesResponse,
  AppviewFetchError
> = appviewGetJsonEffect("/xrpc/dev.cocore.account.listProfiles", new URLSearchParams());

/** Discovery directory used by /friends. The AppView returns every
 *  signed-up DID with profile fields denormalized + provider counts
 *  so we can render a card grid in one round-trip.
 *
 *  `viewerDid` excludes the caller from results so the directory
 *  doesn't offer "friend yourself." Pass the session's DID. */
/** GET `/xrpc/dev.cocore.account.getProfile?did=...`. Returns null
 *  when the DID has no signed-up footprint (404 from the AppView);
 *  any other error becomes an AppviewFetchError. */
export function appviewGetProfileEffect(
  did: string,
): Effect.Effect<AppviewProfilePagePayload | null, AppviewFetchError> {
  const search = new URLSearchParams();
  search.set("did", did);
  return Effect.gen(function* () {
    const result = yield* Effect.either(
      appviewGetJsonEffect<AppviewGetProfileResponse>(
        "/xrpc/dev.cocore.account.getProfile",
        search,
      ),
    );
    if (result._tag === "Right") return result.right.profile;
    if (result.left.status === 404) return null;
    return yield* Effect.fail(result.left);
  });
}

export function appviewListIncomingFriendsEffect(filters: {
  did: string;
  limit?: number;
}): Effect.Effect<AppviewListIncomingFriendsResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  search.set("did", filters.did);
  if (filters.limit !== undefined) search.set("limit", String(filters.limit));
  return appviewGetJsonEffect("/xrpc/dev.cocore.account.listIncomingFriends", search);
}

export function appviewListFriendEdgesEffect(filters?: {
  limit?: number;
}): Effect.Effect<AppviewListFriendEdgesResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  if (filters?.limit !== undefined) search.set("limit", String(filters.limit));
  return appviewGetJsonEffect("/xrpc/dev.cocore.account.listFriendEdges", search);
}

export function appviewListAccountsEffect(filters: {
  limit?: number;
  offset?: number;
  sortBy?: "recent" | "newest";
  providersOnly?: boolean;
  viewerDid?: string;
  excludeViewerFriends?: boolean;
  /** Substring match on profile handle and/or DID (AppView `q` param). */
  query?: string;
}): Effect.Effect<AppviewListAccountsResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  if (filters.limit !== undefined) search.set("limit", String(filters.limit));
  if (filters.offset !== undefined) search.set("offset", String(filters.offset));
  if (filters.sortBy) search.set("sortBy", filters.sortBy);
  if (filters.providersOnly) search.set("providersOnly", "true");
  if (filters.viewerDid?.trim()) search.set("viewerDid", filters.viewerDid.trim());
  if (filters.excludeViewerFriends) search.set("excludeViewerFriends", "true");
  const q = filters.query?.trim();
  if (q) search.set("q", q);
  return appviewGetJsonEffect("/xrpc/dev.cocore.account.listAccounts", search);
}

export const appviewModelActivityEffect: Effect.Effect<
  AppviewModelActivityResponse,
  AppviewFetchError
> = appviewGetJsonEffect("/xrpc/dev.cocore.compute.modelActivity", new URLSearchParams());

export function appviewGetReceiptsEffect(filters: {
  provider?: string;
  requester?: string;
  job?: string;
}): Effect.Effect<AppviewGetReceiptsResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  if (filters.provider?.trim()) search.set("provider", filters.provider.trim());
  if (filters.requester?.trim()) search.set("requester", filters.requester.trim());
  if (filters.job?.trim()) search.set("job", filters.job.trim());
  return appviewGetJsonEffect("/xrpc/dev.cocore.compute.listReceipts", search);
}

export function appviewGetJobsEffect(
  requester: string,
): Effect.Effect<AppviewGetJobsResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  search.set("requester", requester.trim());
  return appviewGetJsonEffect("/xrpc/dev.cocore.compute.listJobs", search);
}

export function appviewGetSettlementsEffect(filters: {
  receipt?: string;
  requester?: string;
}): Effect.Effect<AppviewGetSettlementsResponse, AppviewFetchError> {
  const search = new URLSearchParams();
  if (filters.receipt?.trim()) search.set("receipt", filters.receipt.trim());
  if (filters.requester?.trim()) search.set("requester", filters.requester.trim());
  return appviewGetJsonEffect("/xrpc/dev.cocore.compute.listSettlements", search);
}

export function appviewVerifyReceiptEffect(
  uri: string,
): Effect.Effect<AppviewVerifyReceiptResponse | { error: string }, AppviewFetchError> {
  const search = new URLSearchParams();
  search.set("uri", uri.trim());
  return appviewGetJsonEffect("/xrpc/dev.cocore.compute.verifyReceipt", search);
}

export function appviewVerifySettlementEffect(
  uri: string,
): Effect.Effect<AppviewVerifySettlementResponse | { error: string }, AppviewFetchError> {
  const search = new URLSearchParams();
  search.set("uri", uri.trim());
  return appviewGetJsonEffect("/xrpc/dev.cocore.compute.verifySettlement", search);
}
