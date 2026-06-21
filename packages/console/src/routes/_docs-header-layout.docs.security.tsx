import { createFileRoute } from "@tanstack/react-router";

import { SecurityDocsPage } from "@/components/docs/security-page.tsx";
import { InferenceDocsLayout } from "@/components/inference-docs/inference-docs-layout.tsx";
import { ogImageHref, socialMeta } from "@/lib/og-image.shared.ts";

const TITLE = "Secure Mode & Confidential · co/core";
const DESCRIPTION =
  "How co/core's two orthogonal provider guarantees work: Secure Mode (hardware attestation) and the Confidential tier (operator-blind inference).";

export const Route = createFileRoute("/_docs-header-layout/docs/security")({
  head: () => ({
    meta: [
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      ...socialMeta({
        title: TITLE,
        description: DESCRIPTION,
        image: ogImageHref({
          eyebrow: "Docs · Security",
          title: "Secure Mode & Confidential",
          description: DESCRIPTION,
        }),
      }),
    ],
  }),
  component: SecurityRoute,
});

function SecurityRoute() {
  return (
    <InferenceDocsLayout>
      <SecurityDocsPage />
    </InferenceDocsLayout>
  );
}
