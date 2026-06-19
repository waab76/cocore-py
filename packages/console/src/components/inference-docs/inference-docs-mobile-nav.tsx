"use client";

import { useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";

import { DocsMobileJumpSelect } from "@/components/docs/docs-mobile-jump-select.tsx";
import {
  COMMUNITY_TOOLS_NAV_ID,
  INFERENCE_DOCS_CATALOG,
  inferenceDocsJumpNavGroups,
  isCommunityToolsPath,
  type InferenceDocsSlug,
} from "@/lib/inference-docs/navigation.ts";

const groups = inferenceDocsJumpNavGroups();
const OVERVIEW_KEY = "overview";

function activeNavId(pathname: string): string {
  if (isCommunityToolsPath(pathname)) return COMMUNITY_TOOLS_NAV_ID;

  const prefix = "/docs/inference/";
  if (pathname === "/docs/inference" || pathname === "/docs/inference/") return OVERVIEW_KEY;
  if (!pathname.startsWith(prefix)) return OVERVIEW_KEY;
  return pathname.slice(prefix.length) as InferenceDocsSlug;
}

const selectGroups = groups.map((group) => ({
  label: group.label,
  options: group.options.map((option) => ({
    id: option.id,
    label: option.label,
  })),
}));

export function InferenceDocsMobileNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const value = activeNavId(pathname);

  const onValueChange = useCallback((id: string) => {
    const option = groups.flatMap((group) => group.options).find((entry) => entry.id === id);
    if (option == null) return;
    globalThis.location.assign(option.href);
  }, []);

  return (
    <DocsMobileJumpSelect
      ariaLabel="Jump to page"
      groups={selectGroups}
      value={value}
      onValueChange={onValueChange}
    />
  );
}

export function inferenceDocsPageTitle(pathname: string): string {
  if (isCommunityToolsPath(pathname)) {
    return INFERENCE_DOCS_CATALOG.find((entry) => entry.href != null)?.title ?? "Community tools";
  }

  const prefix = "/docs/inference/";
  const slug =
    pathname === "/docs/inference" || pathname === "/docs/inference/"
      ? null
      : pathname.startsWith(prefix)
        ? (pathname.slice(prefix.length) as InferenceDocsSlug)
        : null;
  const entry = INFERENCE_DOCS_CATALOG.find((item) => item.slug === slug);
  return entry?.title ?? "Inference API";
}
