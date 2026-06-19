import type { ApiDocsCatalogEntry } from "@/lib/api-docs/catalog.ts";
import type { ApiDocsExampleResult } from "@/lib/api-docs/types.ts";

import { buildApiDocsCurl, resolveApiDocsExampleParams } from "@/lib/api-docs/build-curl.ts";
import { autoRunnableCatalogEntries, catalogEntryByNsid } from "@/lib/api-docs/catalog.ts";
import { mergeApiDocsExampleBody } from "@/lib/api-docs/merge-example-params.ts";
import { appviewBaseUrl } from "@/lib/api-docs/discovery.ts";
import { loadApiDocsFixturesAsync } from "@/server/api-docs/fixtures.server.ts";

export type RunXrpcExampleOptions = {
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  useSessionAuth?: boolean;
};

async function fetchXrpcExample(
  catalogEntry: ApiDocsCatalogEntry,
  baseUrl: string,
  params: Record<string, string>,
  body: unknown | undefined,
): Promise<{ status: number; bodyJson: string }> {
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/xrpc/${catalogEntry.nsid}`);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = { Accept: "application/json" };

  let response: Response;
  if (catalogEntry.method === "query") {
    response = await fetch(url.toString(), { headers });
  } else {
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    });
  }

  const text = await response.text();
  let bodyJson = text;
  try {
    bodyJson = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // keep raw text
  }
  return { status: response.status, bodyJson };
}

export async function runXrpcExample(
  nsid: string,
  options: RunXrpcExampleOptions = {},
): Promise<ApiDocsExampleResult> {
  const catalogEntry = catalogEntryByNsid(nsid);
  if (!catalogEntry) {
    return {
      nsid,
      curl: "",
      status: 404,
      bodyJson: JSON.stringify({ error: "NotFound", message: "Unknown NSID" }),
      durationMs: 0,
      fetchedAt: new Date().toISOString(),
    };
  }

  const fixtures = await loadApiDocsFixturesAsync();
  const params = {
    ...resolveApiDocsExampleParams(catalogEntry, fixtures),
    ...options.params,
  };
  const body = mergeApiDocsExampleBody(catalogEntry, fixtures, options.body);

  const baseUrl = appviewBaseUrl();
  const curl = buildApiDocsCurl(catalogEntry, baseUrl, fixtures, {
    params,
    body,
  });
  const started = performance.now();

  try {
    const result = await fetchXrpcExample(catalogEntry, baseUrl, params, body);

    return {
      nsid,
      curl,
      status: result.status,
      bodyJson: result.bodyJson,
      durationMs: Math.round(performance.now() - started),
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Example request failed";
    return {
      nsid,
      curl,
      status: 500,
      bodyJson: JSON.stringify({ error: "InternalServerError", message }, null, 2),
      durationMs: Math.round(performance.now() - started),
      fetchedAt: new Date().toISOString(),
    };
  }
}

export async function runApiDocsExamples(): Promise<Array<ApiDocsExampleResult>> {
  const entries = autoRunnableCatalogEntries();
  return Promise.all(entries.map((entry) => runXrpcExample(entry.nsid)));
}
