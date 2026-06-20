import { createFileRoute } from "@tanstack/react-router";
import { getApiDocsPageData } from "@/integrations/tanstack-query/api-docs.functions.ts";

import { ApiDocsPage } from "@/components/docs/api-docs-page.tsx";
import { apiDocsEndpointByRef, apiDocsNsidLeaf } from "@/lib/api-docs/navigation.ts";
import { ogImageHref, socialMeta } from "@/lib/og-image.shared.ts";

const TITLE = "AppView API · co/core";
const DESCRIPTION =
  "Read-only XRPC queries over the co/core AppView index — receipts, jobs, providers, and social graph state.";
const EYEBROW = "Docs · AppView API";

interface ApiDocsSearch {
  /** Mirror of the `#ref-<endpoint>` anchor; lets SSR build a per-endpoint OG card. */
  ref?: string;
}

export const Route = createFileRoute("/_docs-header-layout/docs/api")({
  validateSearch: (search: Record<string, unknown>): ApiDocsSearch => {
    const ref = typeof search["ref"] === "string" && search["ref"].length > 0 ? search["ref"] : undefined;
    return ref ? { ref } : {};
  },
  loader: async () => getApiDocsPageData(),
  head: ({ match }) => {
    const entry = apiDocsEndpointByRef(match.search.ref);
    if (entry) {
      const leaf = apiDocsNsidLeaf(entry.nsid);
      const title = `${leaf} · AppView API · co/core`;
      return {
        meta: [
          { title },
          { name: "description", content: entry.description },
          ...socialMeta({
            title,
            description: entry.description,
            image: ogImageHref({ eyebrow: EYEBROW, title: leaf, description: entry.description }),
          }),
        ],
      };
    }
    return {
      meta: [
        { title: TITLE },
        { name: "description", content: DESCRIPTION },
        ...socialMeta({
          title: TITLE,
          description: DESCRIPTION,
          image: ogImageHref({ eyebrow: EYEBROW, title: "AppView API", description: DESCRIPTION }),
        }),
      ],
    };
  },
  component: ApiDocsPage,
});
