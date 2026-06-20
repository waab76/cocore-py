import { createFileRoute } from "@tanstack/react-router";

import { CommunityToolsPage } from "@/components/docs/community-tools-page.tsx";
import { InferenceDocsLayout } from "@/components/inference-docs/inference-docs-layout.tsx";
import { ogImageHref, socialMeta } from "@/lib/og-image.shared.ts";

const TITLE = "Community tools · co/core";
const DESCRIPTION =
  "Community-built extensions and integrations that connect co/core with tools like pi.";

export const Route = createFileRoute("/_docs-header-layout/docs/community-tools")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      ...socialMeta({
        title: TITLE,
        description: DESCRIPTION,
        image: ogImageHref({
          eyebrow: "Docs · Community tools",
          title: "Community tools",
          description: DESCRIPTION,
        }),
      }),
    ],
  }),
  component: CommunityToolsRoute,
});

function CommunityToolsRoute() {
  return (
    <InferenceDocsLayout>
      <CommunityToolsPage />
    </InferenceDocsLayout>
  );
}
