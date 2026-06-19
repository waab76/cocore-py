"use client";

import type { ReactNode } from "react";

import * as stylex from "@stylexjs/stylex";

import { docsStyles } from "@/components/docs/docs-page.stylex.tsx";

export function InferenceDocsPage({
  kicker,
  title,
  description,
  children,
}: {
  kicker: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <>
      <header {...stylex.props(docsStyles.pageHead)}>
        <div {...stylex.props(docsStyles.kicker)}>{kicker}</div>
        <h1 {...stylex.props(docsStyles.pageTitle)}>{title}</h1>
        <p {...stylex.props(docsStyles.pageDek)}>{description}</p>
      </header>
      <div {...stylex.props(docsStyles.introProse)}>{children}</div>
    </>
  );
}

export function InferenceDocsOverview({
  baseUrl,
  children,
}: {
  baseUrl: string;
  children?: ReactNode;
}) {
  return (
    <>
      <div {...stylex.props(docsStyles.masthead)}>
        <div {...stylex.props(docsStyles.kicker)}>Inference</div>
        <h1 {...stylex.props(docsStyles.title)}>Inference API</h1>
        <p {...stylex.props(docsStyles.dek)}>
          OpenAI-compatible chat completions. Point your client at{" "}
          <code {...stylex.props(docsStyles.codeInline)}>{baseUrl}</code>, send a co/core API key as
          the Bearer token, and requests route to an attested provider on the network.
        </p>
        <div {...stylex.props(docsStyles.baseUrl)}>
          <span {...stylex.props(docsStyles.baseUrlLabel)}>Base URL</span>
          <span>{baseUrl}</span>
        </div>
      </div>
      <div {...stylex.props(docsStyles.introProse)}>{children}</div>
    </>
  );
}
