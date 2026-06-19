import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { InferenceDocsSlugPage } from "@/components/inference-docs/pages/index.tsx";
import { inferenceBaseUrl } from "@/lib/inference-docs/base-url.ts";
import { LEGACY_INFERENCE_API_SLUG_REDIRECTS } from "@/lib/inference-docs/navigation-api.ts";
import { inferenceDocsEntryForSlug, isInferenceDocsSlug } from "@/lib/inference-docs/navigation.ts";

export const Route = createFileRoute("/_docs-header-layout/docs/inference/$slug")({
  beforeLoad: ({ params }) => {
    const hash = LEGACY_INFERENCE_API_SLUG_REDIRECTS[params.slug];
    if (hash) {
      throw redirect({
        to: "/docs/inference/$slug",
        params: { slug: "api-reference" },
        hash,
        replace: true,
      });
    }
    if (!isInferenceDocsSlug(params.slug)) throw notFound();
  },
  loader: ({ params }) => {
    if (!isInferenceDocsSlug(params.slug)) throw notFound();
    const entry = inferenceDocsEntryForSlug(params.slug);
    if (entry == null) throw notFound();
    return entry;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData ? `${loaderData.title} · Inference · co/core` : "Inference · co/core",
      },
      ...(loaderData ? [{ name: "description", content: loaderData.description }] : []),
    ],
  }),
  component: InferenceDocsSlugRoute,
});

function InferenceDocsSlugRoute() {
  const { slug } = Route.useParams();
  if (!isInferenceDocsSlug(slug)) throw notFound();
  return <InferenceDocsSlugPage slug={slug} baseUrl={inferenceBaseUrl()} />;
}
