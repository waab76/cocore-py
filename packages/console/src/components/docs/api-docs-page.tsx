"use client";

import * as stylex from "@stylexjs/stylex";
import { Link, useLoaderData } from "@tanstack/react-router";
import { API_DOCS_CATALOG, API_DOCS_SECTIONS } from "@/lib/api-docs/catalog";
import {
  API_DOCS_SCROLL_SPY_IDS,
  apiDocsSectionEndpointCount,
  apiDocsSectionId,
  apiDocsSectionSubtitle,
} from "@/lib/api-docs/navigation";

import { ApiDocsEndpoint } from "./api-docs-endpoint";
import { ApiDocsPageProvider } from "./api-docs-fixtures-context";
import { ApiDocsIntro } from "./api-docs-intro";
import { DocsApiMobileJumpNav } from "./docs-api-mobile-jump-nav";
import { DocsApiNav } from "./docs-api-nav";
import { docsStyles } from "./docs-page.stylex";
import { DocsRefShell } from "./docs-ref-shell";

export function ApiDocsPage() {
  const { fixtures, tagOptions, appviewBaseUrl, consoleBaseUrl, appviewDid } = useLoaderData({
    from: "/_docs-header-layout/docs/api",
  });

  return (
    <ApiDocsPageProvider
      fixtures={fixtures}
      tagOptions={tagOptions}
      appviewBaseUrl={appviewBaseUrl}
      consoleBaseUrl={consoleBaseUrl}
      appviewDid={appviewDid}
    >
      <DocsRefShell
        scrollSpyIds={API_DOCS_SCROLL_SPY_IDS}
        nav={<DocsApiNav />}
        mobileJumpNav={<DocsApiMobileJumpNav />}
      >
        <ApiDocsIntro />
        {API_DOCS_SECTIONS.map((section) => {
          const entries = API_DOCS_CATALOG.filter((entry) => entry.section === section);
          const count = apiDocsSectionEndpointCount(section);
          const subtitle = apiDocsSectionSubtitle(section);

          const sectionId = apiDocsSectionId(section);
          return (
            <div key={section}>
              <div {...stylex.props(docsStyles.tierHead)} id={sectionId}>
                <h2 {...stylex.props(docsStyles.tierTitle)}>
                  <Link
                    to="/docs/api"
                    search={{ ref: sectionId }}
                    hash={sectionId}
                    {...stylex.props(docsStyles.refAnchor)}
                  >
                    {section}
                  </Link>
                </h2>
                <span {...stylex.props(docsStyles.tierSub)}>
                  {subtitle} · {count} endpoint{count === 1 ? "" : "s"}
                </span>
              </div>
              {entries.map((entry, index) => (
                <ApiDocsEndpoint key={entry.nsid} entry={entry} first={index === 0} />
              ))}
            </div>
          );
        })}
      </DocsRefShell>
    </ApiDocsPageProvider>
  );
}
