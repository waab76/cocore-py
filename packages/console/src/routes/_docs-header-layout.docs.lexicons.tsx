import { createFileRoute } from "@tanstack/react-router";
import { getLexiconDocsPageData } from "@/integrations/tanstack-query/api-lexicon-docs.functions.ts";

import { LexiconDocsPage } from "@/components/docs/lexicon-docs-page.tsx";
import { ogImageHref, socialMeta } from "@/lib/og-image.shared.ts";

const TITLE = "Lexicons · co/core";
const DESCRIPTION =
  "Published dev.cocore.* AT Proto record schemas for compute receipts, jobs, and account state.";

export const Route = createFileRoute("/_docs-header-layout/docs/lexicons")({
  loader: async () => getLexiconDocsPageData(),
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      ...socialMeta({
        title: TITLE,
        description: DESCRIPTION,
        image: ogImageHref({
          eyebrow: "Docs · Lexicons",
          title: "Lexicons",
          description: DESCRIPTION,
        }),
      }),
    ],
  }),
  component: LexiconDocsPage,
});
