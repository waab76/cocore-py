import { createFileRoute } from "@tanstack/react-router";

import { CommunityToolsPage } from "@/components/docs/community-tools-page.tsx";
import { InferenceDocsLayout } from "@/components/inference-docs/inference-docs-layout.tsx";

export const Route = createFileRoute("/_docs-header-layout/docs/community-tools")({
  head: () => ({
    meta: [
      { title: "Community tools · co/core" },
      {
        name: "description",
        content:
          "Community-built extensions and integrations that connect co/core with tools like pi.",
      },
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
