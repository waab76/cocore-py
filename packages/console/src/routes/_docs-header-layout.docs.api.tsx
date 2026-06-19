import { createFileRoute } from "@tanstack/react-router";
import { getApiDocsPageData } from "@/integrations/tanstack-query/api-docs.functions.ts";

import { ApiDocsPage } from "@/components/docs/api-docs-page.tsx";

export const Route = createFileRoute("/_docs-header-layout/docs/api")({
  loader: async () => getApiDocsPageData(),
  head: () => ({
    meta: [
      { title: "AppView API · co/core" },
      {
        name: "description",
        content:
          "Read-only XRPC queries over the co/core AppView index — receipts, jobs, providers, and social graph state.",
      },
    ],
  }),
  component: ApiDocsPage,
});
