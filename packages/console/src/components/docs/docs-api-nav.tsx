"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";
import { API_DOCS_CATALOG, API_DOCS_SECTIONS } from "@/lib/api-docs/catalog";
import {
  API_DOCS_INTRO_IDS,
  apiDocsEndpointId,
  apiDocsNsidLeaf,
  apiDocsSectionEndpointCount,
} from "@/lib/api-docs/navigation";

import { docsStyles } from "./docs-page.stylex";
import { useDocsScrollSpyActive } from "./docs-scroll-spy-context";

export function DocsApiNav() {
  const active = useDocsScrollSpyActive();

  return (
    <nav {...stylex.props(docsStyles.refNav)} aria-label="API reference">
      <div {...stylex.props(docsStyles.refNavGroup)}>
        <div {...stylex.props(docsStyles.refNavHeadingRow)}>
          <span {...stylex.props(docsStyles.refNavHeading)}>Getting started</span>
        </div>
        <a
          href={`#${API_DOCS_INTRO_IDS.overview}`}
          {...stylex.props(
            docsStyles.refNavLink,
            active === API_DOCS_INTRO_IDS.overview && docsStyles.refNavLinkActive,
          )}
        >
          Overview
        </a>
        <a
          href={`#${API_DOCS_INTRO_IDS.discovery}`}
          {...stylex.props(
            docsStyles.refNavLink,
            active === API_DOCS_INTRO_IDS.discovery && docsStyles.refNavLinkActive,
          )}
        >
          Service discovery
        </a>
        <a
          href={`#${API_DOCS_INTRO_IDS.inference}`}
          {...stylex.props(
            docsStyles.refNavLink,
            active === API_DOCS_INTRO_IDS.inference && docsStyles.refNavLinkActive,
          )}
        >
          Inference API
        </a>
      </div>

      {API_DOCS_SECTIONS.map((section) => {
        const entries = API_DOCS_CATALOG.filter((entry) => entry.section === section);
        const count = apiDocsSectionEndpointCount(section);
        return (
          <div key={section} {...stylex.props(docsStyles.refNavGroup)}>
            <div {...stylex.props(docsStyles.refNavHeadingRow)}>
              <span {...stylex.props(docsStyles.refNavHeading)}>{section}</span>
              <span {...stylex.props(docsStyles.refNavHeadingCount)}>{count}</span>
            </div>
            {entries.map((entry) => {
              const id = apiDocsEndpointId(entry.nsid);
              const leaf = apiDocsNsidLeaf(entry.nsid);
              return (
                <Link
                  key={entry.nsid}
                  to="/docs/api"
                  search={{ ref: leaf }}
                  hash={id}
                  {...stylex.props(
                    docsStyles.refNavLink,
                    docsStyles.refNavLinkMono,
                    active === id && docsStyles.refNavLinkActive,
                  )}
                >
                  {leaf}
                </Link>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
