import { createFileRoute } from "@tanstack/react-router";

import { InferenceDocsOverviewPage } from "@/components/inference-docs/pages/index.tsx";
import { inferenceBaseUrl } from "@/lib/inference-docs/base-url.ts";

export const Route = createFileRoute("/_docs-header-layout/docs/inference/")({
  head: () => ({
    meta: [
      { title: "Inference API · co/core" },
      {
        name: "description",
        content:
          "OpenAI-compatible chat completions API for co/core. Swap your base URL and API key to route requests to attested providers.",
      },
    ],
  }),
  component: InferenceDocsIndexRoute,
});

function InferenceDocsIndexRoute() {
  return <InferenceDocsOverviewPage baseUrl={inferenceBaseUrl()} />;
}
