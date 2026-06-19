import { Outlet, createFileRoute } from "@tanstack/react-router";

import { InferenceDocsLayout } from "@/components/inference-docs/inference-docs-layout.tsx";

export const Route = createFileRoute("/_docs-header-layout/docs/inference")({
  component: InferenceDocsLayoutRoute,
});

function InferenceDocsLayoutRoute() {
  return (
    <InferenceDocsLayout>
      <Outlet />
    </InferenceDocsLayout>
  );
}
