"use client";

import type { ReactNode } from "react";

import * as stylex from "@stylexjs/stylex";
import { useRouterState } from "@tanstack/react-router";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";
import { DocsScrollSpyProvider } from "@/components/docs/docs-scroll-spy-context.tsx";
import { InferenceDocsMobileNav } from "@/components/inference-docs/inference-docs-mobile-nav.tsx";
import { InferenceDocsNav } from "@/components/inference-docs/inference-docs-nav.tsx";
import { INFERENCE_API_SCROLL_SPY_IDS } from "@/lib/inference-docs/navigation-api.ts";

function isApiReferencePath(pathname: string): boolean {
  return (
    pathname === "/docs/inference/api-reference" || pathname === "/docs/inference/api-reference/"
  );
}

export function InferenceDocsLayout({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const onApiReference = isApiReferencePath(pathname);

  const shell = (
    <>
      <InferenceDocsMobileNav />
      <div {...stylex.props(docsStyles.refLayout)}>
        <div {...stylex.props(docsStyles.refNavColumn)}>
          <InferenceDocsNav />
        </div>
        <main {...stylex.props(docsStyles.refMain)}>{children}</main>
      </div>
    </>
  );

  if (!onApiReference) return shell;

  return <DocsScrollSpyProvider ids={INFERENCE_API_SCROLL_SPY_IDS}>{shell}</DocsScrollSpyProvider>;
}
