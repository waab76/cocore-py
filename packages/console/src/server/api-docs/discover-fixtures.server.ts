import type { ApiDocsFixtures } from "@/lib/api-docs/fixture-defaults.ts";
import type { ApiDocsTagOption } from "@/lib/api-docs/types.ts";

/** Cocore AppView docs do not discover fixtures from a database yet. */
export async function discoverApiDocsFixturesFromDb(): Promise<Partial<ApiDocsFixtures>> {
  return {};
}

export async function discoverApiDocsTagOptions(): Promise<Array<ApiDocsTagOption>> {
  return [];
}

export async function prioritizeApiDocsFixtureTag(
  options: Array<ApiDocsTagOption>,
): Promise<Array<ApiDocsTagOption>> {
  return options;
}
