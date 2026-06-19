import type { ApiDocsFixtures } from "./fixture-defaults.ts";

import { getDefaultApiDocsFixtures } from "./fixture-defaults.ts";

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Stable DID / AT-URI fixtures for live API docs examples (env only). */
export function loadApiDocsFixtures(): ApiDocsFixtures {
  const defaults = getDefaultApiDocsFixtures();

  return {
    providerDid: env("API_DOCS_FIXTURE_PROVIDER_DID") ?? defaults.providerDid,
    requesterDid: env("API_DOCS_FIXTURE_REQUESTER_DID") ?? defaults.requesterDid,
    jobUri: env("API_DOCS_FIXTURE_JOB_URI") ?? defaults.jobUri,
    receiptUri: env("API_DOCS_FIXTURE_RECEIPT_URI") ?? defaults.receiptUri,
    listQuery: env("API_DOCS_FIXTURE_LIST_QUERY") ?? defaults.listQuery,
  };
}
