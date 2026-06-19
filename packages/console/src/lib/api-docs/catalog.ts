import type { loadApiDocsFixtures } from "./fixtures";

export type ApiDocsAuthClass = "none" | "required" | "optional-did";

export type ApiDocsCatalogEntry = {
  nsid: string;
  method: "query" | "procedure";
  section: string;
  description: string;
  auth: ApiDocsAuthClass;
  status: "shipped" | "planned";
  params: Array<{ name: string; type: string; required?: boolean }>;
  example: {
    autoRun: boolean;
    params?:
      | Record<string, string>
      | ((fixtures: ReturnType<typeof loadApiDocsFixtures>) => Record<string, string>);
    body?:
      | Record<string, unknown>
      | ((fixtures: ReturnType<typeof loadApiDocsFixtures>) => Record<string, unknown>);
  };
};

function q(
  nsid: string,
  section: string,
  description: string,
  auth: ApiDocsAuthClass,
  params: ApiDocsCatalogEntry["params"],
  example: ApiDocsCatalogEntry["example"],
): ApiDocsCatalogEntry {
  return {
    nsid,
    method: "query",
    section,
    description,
    auth,
    status: "shipped",
    params,
    example,
  };
}

export const API_DOCS_CATALOG: Array<ApiDocsCatalogEntry> = [
  q(
    "dev.cocore.appview.listProviders",
    "Directory",
    "List indexed provider records (`dev.cocore.compute.provider`).",
    "none",
    [],
    { autoRun: true, params: {} },
  ),
  q(
    "dev.cocore.appview.listProfiles",
    "Directory",
    "List indexed account profile records (`dev.cocore.account.profile`).",
    "none",
    [],
    { autoRun: true, params: {} },
  ),
  q(
    "dev.cocore.appview.getProfile",
    "Directory",
    "Full profile payload for one DID — machines, activity counts, and social context.",
    "none",
    [{ name: "did", type: "did", required: true }],
    {
      autoRun: true,
      params: (f) => ({ did: f.providerDid }),
    },
  ),
  q(
    "dev.cocore.appview.listAccounts",
    "Directory",
    "Discovery directory of signed-up DIDs with profile and provider counts.",
    "none",
    [
      { name: "limit", type: "integer" },
      { name: "offset", type: "integer" },
      { name: "sortBy", type: "string" },
      { name: "providersOnly", type: "boolean" },
      { name: "viewerDid", type: "did" },
      { name: "excludeViewerFriends", type: "boolean" },
      { name: "q", type: "string" },
    ],
    {
      autoRun: true,
      params: (f) => ({ limit: "12", q: f.listQuery }),
    },
  ),
  q(
    "dev.cocore.appview.listIncomingFriends",
    "Social graph",
    "Friend records whose subject is the queried DID.",
    "none",
    [
      { name: "did", type: "did", required: true },
      { name: "limit", type: "integer" },
    ],
    {
      autoRun: true,
      params: (f) => ({ did: f.requesterDid, limit: "10" }),
    },
  ),
  q(
    "dev.cocore.appview.listFriendEdges",
    "Social graph",
    "Every directed trust edge in the indexed network (friender → subject).",
    "none",
    [{ name: "limit", type: "integer" }],
    { autoRun: true, params: { limit: "100" } },
  ),
  q(
    "dev.cocore.appview.getReceipts",
    "Compute index",
    "Indexed receipt records with optional provider, requester, or job filters.",
    "none",
    [
      { name: "provider", type: "did" },
      { name: "requester", type: "did" },
      { name: "job", type: "at-uri" },
    ],
    {
      autoRun: true,
      params: (f) => ({ provider: f.providerDid }),
    },
  ),
  q(
    "dev.cocore.appview.getJobs",
    "Compute index",
    "Indexed job records for a requester DID.",
    "none",
    [{ name: "requester", type: "did", required: true }],
    {
      autoRun: true,
      params: (f) => ({ requester: f.requesterDid }),
    },
  ),
  q(
    "dev.cocore.appview.getSettlements",
    "Compute index",
    "Indexed settlement records with optional receipt or requester filters.",
    "none",
    [
      { name: "receipt", type: "at-uri" },
      { name: "requester", type: "did" },
    ],
    {
      autoRun: true,
      params: (f) => ({ receipt: f.receiptUri }),
    },
  ),
  q(
    "dev.cocore.appview.verifyReceipt",
    "Verification",
    "Structural + cryptographic verification of an indexed receipt against its job and attestation.",
    "none",
    [{ name: "uri", type: "at-uri", required: true }],
    {
      autoRun: false,
      params: (f) => ({ uri: f.receiptUri }),
    },
  ),
  q(
    "dev.cocore.appview.verifySettlement",
    "Verification",
    "Verify a settlement chain against indexed receipt and authorization records.",
    "none",
    [{ name: "uri", type: "at-uri", required: true }],
    { autoRun: false, params: {} },
  ),
  q(
    "dev.cocore.appview.modelActivity",
    "Analytics",
    "Aggregate receipt activity per model across rolling time windows.",
    "none",
    [],
    { autoRun: true, params: {} },
  ),
  q(
    "dev.cocore.appview.latency",
    "Analytics",
    "Network latency rollup derived from indexed receipt timestamps.",
    "none",
    [],
    { autoRun: true, params: {} },
  ),
];

export function catalogEntryByNsid(nsid: string): ApiDocsCatalogEntry | undefined {
  return API_DOCS_CATALOG.find((entry) => entry.nsid === nsid);
}

export function autoRunnableCatalogEntries(): Array<ApiDocsCatalogEntry> {
  return API_DOCS_CATALOG.filter((entry) => entry.status === "shipped" && entry.example.autoRun);
}

export const API_DOCS_SECTIONS = [
  "Directory",
  "Social graph",
  "Compute index",
  "Verification",
  "Analytics",
] as const;
