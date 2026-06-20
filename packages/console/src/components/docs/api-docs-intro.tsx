"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { APPVIEW_SERVICE_ID } from "@/lib/api-docs/discovery.ts";
import { API_DOCS_INTRO_IDS } from "@/lib/api-docs/navigation.ts";

import { useApiDocsPageContext } from "./api-docs-fixtures-context.tsx";
import { docsStyles } from "./docs-page.stylex.tsx";

export function ApiDocsIntro() {
  const { consoleBaseUrl, appviewDid } = useApiDocsPageContext();
  const xrpcBaseUrl = `${consoleBaseUrl.replace(/\/$/, "")}/xrpc`;
  return (
    <>
      <div {...stylex.props(docsStyles.masthead)}>
        <div {...stylex.props(docsStyles.kicker)}>Developer docs</div>
        <h1 {...stylex.props(docsStyles.title)}>AppView API</h1>
        <p {...stylex.props(docsStyles.dek)}>
          Read-only XRPC queries over the co/core indexed read-model — receipts, jobs, providers,
          and social graph state.
        </p>
        <div {...stylex.props(docsStyles.baseUrl)}>
          <span {...stylex.props(docsStyles.baseUrlLabel)}>Base</span>
          <span>{xrpcBaseUrl}</span>
          <span {...stylex.props(docsStyles.baseUrlDot)}>·</span>
          <span {...stylex.props(docsStyles.baseUrlOk)}>
            <span {...stylex.props(docsStyles.baseUrlOkDot)} aria-hidden />
            read-only
          </span>
        </div>
      </div>

      <div {...stylex.props(docsStyles.introProse)}>
        <h2 id={API_DOCS_INTRO_IDS.overview} {...stylex.props(docsStyles.h2, docsStyles.h2First)}>
          Overview
        </h2>
        <p {...stylex.props(docsStyles.prose)}>
          The co/core AppView indexes provider-signed records under{" "}
          <code {...stylex.props(docsStyles.codeInline)}>dev.cocore.*</code> from the network
          firehose. It exposes a small read API at{" "}
          <code {...stylex.props(docsStyles.codeInline)}>{xrpcBaseUrl}</code> for discovery,
          verification, and analytics. Authoritative state remains in each actor&apos;s PDS — the
          AppView is a cache, not a ledger.
        </p>

        <h2 id={API_DOCS_INTRO_IDS.discovery} {...stylex.props(docsStyles.h2)}>
          Service discovery
        </h2>
        <p {...stylex.props(docsStyles.prose)}>
          Service DID is{" "}
          <code {...stylex.props(docsStyles.codeInline, docsStyles.codeInlineAccent)}>
            {appviewDid}
          </code>
          . Production deployments advertise the AppView endpoint via{" "}
          <code {...stylex.props(docsStyles.codeInline)}>#{APPVIEW_SERVICE_ID}</code> on the console
          DID document.
        </p>

        <h2 id={API_DOCS_INTRO_IDS.inference} {...stylex.props(docsStyles.h2)}>
          Inference API
        </h2>
        <p {...stylex.props(docsStyles.prose)}>
          To run inference against co/core providers, use the OpenAI-compatible chat completions
          surface documented on{" "}
          <Link to="/docs/inference" {...stylex.props(docsStyles.proseLink)}>
            /docs/inference
          </Link>
          . Drop-in replacement: change the base URL and API key in your existing OpenAI SDK client.
        </p>
      </div>
    </>
  );
}
