export const INFERENCE_DOCS_SECTIONS = ["Getting started", "API reference", "Tool setup"] as const;

export type InferenceDocsSection = (typeof INFERENCE_DOCS_SECTIONS)[number];

export type InferenceDocsSlug =
  | "quickstart"
  | "api-reference"
  | "opencode"
  | "cursor"
  | "claude-code";

export type InferenceDocsEntry = {
  slug: InferenceDocsSlug | null;
  section: InferenceDocsSection;
  label: string;
  title: string;
  description: string;
};

export const INFERENCE_DOCS_CATALOG: Array<InferenceDocsEntry> = [
  {
    slug: null,
    section: "Getting started",
    label: "Overview",
    title: "Inference API",
    description: "OpenAI-compatible chat completions routed to attested co/core providers.",
  },
  {
    slug: "quickstart",
    section: "Getting started",
    label: "Quickstart",
    title: "Quickstart",
    description: "Create an API key, then swap the base URL and key in your OpenAI client.",
  },
  {
    slug: "api-reference",
    section: "API reference",
    label: "API reference",
    title: "API reference",
    description: "HTTP endpoints, parameters, curl examples, and error codes.",
  },
  {
    slug: "opencode",
    section: "Tool setup",
    label: "OpenCode",
    title: "OpenCode",
    description: "Configure co/core as a custom OpenAI-compatible provider.",
  },
  {
    slug: "cursor",
    section: "Tool setup",
    label: "Cursor",
    title: "Cursor",
    description: "Point Cursor's OpenAI override at co/core.",
  },
  {
    slug: "claude-code",
    section: "Tool setup",
    label: "Claude Code",
    title: "Claude Code",
    description: "Route Claude Code through a local Anthropic→OpenAI proxy.",
  },
];

const SLUG_SET = new Set(
  INFERENCE_DOCS_CATALOG.map((entry) => entry.slug).filter(
    (slug): slug is InferenceDocsSlug => slug != null,
  ),
);

export function inferenceDocsHref(slug: InferenceDocsSlug | null): string {
  return slug == null ? "/docs/inference" : `/docs/inference/${slug}`;
}

export type InferenceDocsLinkTarget =
  | { to: "/docs/inference" }
  | { to: "/docs/inference/$slug"; params: { slug: InferenceDocsSlug } };

export function inferenceDocsLink(slug: InferenceDocsSlug | null): InferenceDocsLinkTarget {
  if (slug == null) return { to: "/docs/inference" };
  return { to: "/docs/inference/$slug", params: { slug } };
}

export function inferenceDocsEntryForSlug(
  slug: InferenceDocsSlug | null,
): InferenceDocsEntry | undefined {
  return INFERENCE_DOCS_CATALOG.find((entry) => entry.slug === slug);
}

export function isInferenceDocsSlug(value: string): value is InferenceDocsSlug {
  return SLUG_SET.has(value as InferenceDocsSlug);
}

export type InferenceDocsJumpNavGroup = {
  label: string;
  options: Array<{ slug: InferenceDocsSlug | null; label: string; hash?: string }>;
};

export function inferenceDocsJumpNavGroups(): Array<InferenceDocsJumpNavGroup> {
  return INFERENCE_DOCS_SECTIONS.map((section) => ({
    label: section,
    options: INFERENCE_DOCS_CATALOG.filter((entry) => entry.section === section).map((entry) => ({
      slug: entry.slug,
      label: entry.label,
    })),
  }));
}
