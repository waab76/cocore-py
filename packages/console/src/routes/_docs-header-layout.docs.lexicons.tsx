import { createFileRoute } from "@tanstack/react-router";
import { getLexiconDocsPageData } from "@/integrations/tanstack-query/api-lexicon-docs.functions.ts";

import { LexiconDocsPage } from "@/components/docs/lexicon-docs-page.tsx";

export const Route = createFileRoute("/_docs-header-layout/docs/lexicons")({
  loader: async () => getLexiconDocsPageData(),
  head: () => ({
    meta: [
      { title: "Lexicons · co/core" },
      {
        name: "description",
        content:
          "Published dev.cocore.* AT Proto record schemas for compute receipts, jobs, and account state.",
      },
    ],
  }),
  component: LexiconDocsPage,
});
