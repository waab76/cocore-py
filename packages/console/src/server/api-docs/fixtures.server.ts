import type { ApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import type { ApiDocsTagOption } from "@/lib/api-docs/types.ts";

import { getDefaultApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import { loadApiDocsFixtures } from "@/lib/api-docs/fixtures.ts";

let cachedAsyncFixtures: ApiDocsFixtures | null = null;

/** Env-backed fixtures for the docs route loader and example runner. */
export async function loadApiDocsFixturesAsync(): Promise<ApiDocsFixtures> {
  if (cachedAsyncFixtures) {
    return cachedAsyncFixtures;
  }

  cachedAsyncFixtures = {
    ...getDefaultApiDocsFixtures(),
    ...loadApiDocsFixtures(),
  };

  return cachedAsyncFixtures;
}

export type ApiDocsPageData = {
  fixtures: ApiDocsFixtures;
  tagOptions: Array<ApiDocsTagOption>;
};

let cachedPageData: ApiDocsPageData | null = null;

/** Fixtures for the /docs/api page loader. */
export async function loadApiDocsPageData(): Promise<ApiDocsPageData> {
  if (cachedPageData) {
    return cachedPageData;
  }
  const fixtures = await loadApiDocsFixturesAsync();
  cachedPageData = { fixtures, tagOptions: [] };
  return cachedPageData;
}
