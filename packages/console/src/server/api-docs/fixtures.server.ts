import type { ApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import type { ApiDocsTagOption } from "@/lib/api-docs/types.ts";

import { appviewBaseUrl, consoleBaseUrlClient } from "@/lib/api-docs/discovery.ts";
import { getDefaultApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import { loadApiDocsFixtures } from "@/lib/api-docs/fixtures.ts";

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

type IndexedRecord = {
  uri?: string;
  body?: { job?: { uri?: string }; receipt?: { uri?: string } };
};

/** Fill the URI fixtures from the anchor DID's own indexed
 *  receipts/jobs/settlements, so the auto-run examples return real data
 *  instead of guessed rkeys. Best-effort: any field we can't resolve keeps
 *  its env/default value. The DID fields themselves come from the defaults
 *  (or `API_DOCS_FIXTURE_*` env), so this only discovers the `*Uri` fields. */
async function discoverFixtureUris(base: ApiDocsFixtures): Promise<ApiDocsFixtures> {
  const appview = appviewBaseUrl().replace(/\/$/, "");
  const provider = encodeURIComponent(base.providerDid);
  const requester = encodeURIComponent(base.requesterDid);

  const [asProvider, asRequester, jobs, settlements] = await Promise.all([
    fetchJson<{ receipts?: IndexedRecord[] }>(
      `${appview}/xrpc/dev.cocore.compute.listReceipts?provider=${provider}`,
    ),
    fetchJson<{ receipts?: IndexedRecord[] }>(
      `${appview}/xrpc/dev.cocore.compute.listReceipts?requester=${requester}`,
    ),
    fetchJson<{ jobs?: IndexedRecord[] }>(
      `${appview}/xrpc/dev.cocore.compute.listJobs?requester=${requester}`,
    ),
    fetchJson<{ settlements?: IndexedRecord[] }>(
      `${appview}/xrpc/dev.cocore.compute.listSettlements?requester=${requester}`,
    ),
  ]);

  const settlement = settlements?.settlements?.[0];
  const receipt = asProvider?.receipts?.[0] ?? asRequester?.receipts?.[0];

  // Prefer a receipt that actually has a settlement, so the settlement
  // examples (which filter by receipt) return data instead of an empty list.
  const receiptUri = settlement?.body?.receipt?.uri ?? receipt?.uri ?? base.receiptUri;

  return {
    ...base,
    receiptUri,
    jobUri: receipt?.body?.job?.uri ?? jobs?.jobs?.[0]?.uri ?? base.jobUri,
    settlementUri: settlement?.uri ?? base.settlementUri,
  };
}

type CachedFixtures = { at: number; value: ApiDocsFixtures };
const FIXTURE_TTL_MS = 5 * 60_000;
let cachedFixtures: CachedFixtures | null = null;

/** Fixtures for the docs route loader and example runner: the anchor DID
 *  (default or `API_DOCS_FIXTURE_*` env) with its real record URIs filled in
 *  from the AppView. TTL-cached so a cold AppView is retried rather than
 *  pinned for the process. */
export async function loadApiDocsFixturesAsync(): Promise<ApiDocsFixtures> {
  if (cachedFixtures && Date.now() - cachedFixtures.at < FIXTURE_TTL_MS) {
    return cachedFixtures.value;
  }
  const base: ApiDocsFixtures = { ...getDefaultApiDocsFixtures(), ...loadApiDocsFixtures() };
  const value = await discoverFixtureUris(base);
  cachedFixtures = { at: Date.now(), value };
  return value;
}

export type ApiDocsPageData = {
  fixtures: ApiDocsFixtures;
  tagOptions: Array<ApiDocsTagOption>;
  /** Public AppView origin (e.g. https://appview.cocore.dev), resolved on the
   *  server from the AppView's service DID — NOT the internal
   *  `COCORE_APPVIEW_URL` the console uses for private server-to-server calls.
   *  Curl examples and the run-it-yourself base must point at the public host. */
  appviewBaseUrl: string;
  consoleBaseUrl: string;
  /** AppView service DID, resolved on the server (COCORE_APPVIEW_DID in prod). */
  appviewDid: string;
};

/** did:web for the AppView host. Prefers the configured DID; otherwise
 *  derives it from the AppView origin (port encoded as %3A). */
function resolveAppviewDid(base: string): string {
  const configured = process.env["COCORE_APPVIEW_DID"]?.trim();
  if (configured) return configured;
  try {
    return `did:web:${new URL(base).host.replace(":", "%3A")}`;
  } catch {
    return "did:web:localhost%3A8081";
  }
}

/** Public, externally-reachable AppView origin for the docs. Derived from the
 *  service DID (`did:web:appview.cocore.dev` → https://appview.cocore.dev) so
 *  we never surface the private Railway URL in `COCORE_APPVIEW_URL`. Falls back
 *  to that configured URL in dev, where there's no public domain anyway. */
function appviewPublicUrl(): string {
  const did = process.env["COCORE_APPVIEW_DID"]?.trim();
  if (did?.startsWith("did:web:")) {
    // Bare host[:port]; a `%3A`-encoded port decodes back to ':'.
    const host = decodeURIComponent(did.slice("did:web:".length));
    const scheme = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
    return `${scheme}://${host}`;
  }
  return appviewBaseUrl();
}

/** Fixtures for the /docs/api page loader. */
export async function loadApiDocsPageData(): Promise<ApiDocsPageData> {
  const fixtures = await loadApiDocsFixturesAsync();
  const appview = appviewPublicUrl();
  return {
    fixtures,
    tagOptions: [],
    appviewBaseUrl: appview,
    consoleBaseUrl: consoleBaseUrlClient(),
    appviewDid: resolveAppviewDid(appview),
  };
}
