import { createFileRoute } from "@tanstack/react-router";

import { InferenceDocsOverviewPage } from "@/components/inference-docs/pages/index.tsx";
import { inferenceBaseUrl } from "@/lib/inference-docs/base-url.ts";
import { ogImageHref, socialMeta } from "@/lib/og-image.shared.ts";

const TITLE = "Inference API · co/core";
const DESCRIPTION =
  "OpenAI-compatible chat completions API for co/core. Swap your base URL and API key to route requests to attested providers.";

export const Route = createFileRoute("/_docs-header-layout/docs/inference/")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      ...socialMeta({
        title: TITLE,
        description: DESCRIPTION,
        image: ogImageHref({
          eyebrow: "Docs · Inference API",
          title: "Inference API",
          description: DESCRIPTION,
        }),
      }),
    ],
  }),
  component: InferenceDocsIndexRoute,
});

function InferenceDocsIndexRoute() {
  return <InferenceDocsOverviewPage baseUrl={inferenceBaseUrl()} />;
}
