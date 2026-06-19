"use client";

import * as stylex from "@stylexjs/stylex";
import { useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";
import {
  INFERENCE_DOCS_CATALOG,
  inferenceDocsHref,
  inferenceDocsJumpNavGroups,
  type InferenceDocsSlug,
} from "@/lib/inference-docs/navigation.ts";

const groups = inferenceDocsJumpNavGroups();

function activeSlug(pathname: string): InferenceDocsSlug | null {
  const prefix = "/docs/inference/";
  if (pathname === "/docs/inference" || pathname === "/docs/inference/") return null;
  if (!pathname.startsWith(prefix)) return null;
  const slug = pathname.slice(prefix.length);
  return slug as InferenceDocsSlug;
}

export function InferenceDocsMobileNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const value = activeSlug(pathname);

  const onChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
    const slug = event.target.value;
    globalThis.location.assign(inferenceDocsHref(slug === "" ? null : (slug as InferenceDocsSlug)));
  }, []);

  return (
    <div {...stylex.props(docsStyles.mobileJumpBar)}>
      <label {...stylex.props(docsStyles.mobileJumpLabel)} htmlFor="inference-docs-jump-nav">
        Jump to
      </label>
      <select
        id="inference-docs-jump-nav"
        {...stylex.props(docsStyles.mobileJumpSelect)}
        value={value ?? ""}
        onChange={onChange}
        aria-label="Jump to page"
      >
        {groups.map((group) => (
          <optgroup key={group.label} label={group.label}>
            {group.options.map((option) => (
              <option key={option.label} value={option.slug ?? ""}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
}

export function inferenceDocsPageTitle(pathname: string): string {
  const slug = activeSlug(pathname);
  const entry = INFERENCE_DOCS_CATALOG.find((item) => item.slug === slug);
  return entry?.title ?? "Inference API";
}
