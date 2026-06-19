"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";
import type { InferenceDocsSlug } from "@/lib/inference-docs/navigation.ts";

export function InferenceDocLink({
  slug,
  children,
  className,
}: {
  slug: InferenceDocsSlug | null;
  children: ReactNode;
  className?: stylex.StyleXStyles;
}) {
  const linkStyle = className ?? docsStyles.proseLink;

  if (slug == null) {
    return (
      <Link to="/docs/inference" {...stylex.props(linkStyle)}>
        {children}
      </Link>
    );
  }

  return (
    <Link to="/docs/inference/$slug" params={{ slug }} {...stylex.props(linkStyle)}>
      {children}
    </Link>
  );
}

export function InferenceApiDocLink({
  fragment,
  children,
  className,
}: {
  fragment: string;
  children: ReactNode;
  className?: stylex.StyleXStyles;
}) {
  const linkStyle = className ?? docsStyles.proseLink;

  return (
    <Link
      to="/docs/inference/$slug"
      params={{ slug: "api-reference" }}
      hash={fragment}
      {...stylex.props(linkStyle)}
    >
      {children}
    </Link>
  );
}
