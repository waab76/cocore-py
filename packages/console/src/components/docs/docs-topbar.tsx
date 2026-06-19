"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { docsStyles } from "./docs-page.stylex.tsx";

const NAV_ITEMS = [
  { label: "Inference", to: "/docs/inference" as const },
  { label: "XRPC", to: "/docs/api" as const },
  { label: "Lexicons", to: "/docs/lexicons" as const },
] as const;

export function DocsTopbar() {
  return (
    <header {...stylex.props(docsStyles.topbar)}>
      <div {...stylex.props(docsStyles.topbarLeft)}>
        <Link to="/docs/inference" {...stylex.props(docsStyles.brandLink)}>
          co<span {...stylex.props(docsStyles.brandEm)}>/core</span>
        </Link>
        <span {...stylex.props(docsStyles.topbarTag, docsStyles.topbarTagFull)}>
          Developer docs
        </span>
        <span {...stylex.props(docsStyles.topbarTag, docsStyles.topbarTagShort)}>Docs</span>
      </div>
      <nav {...stylex.props(docsStyles.topbarNav)} aria-label="Developer docs">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.label}
            to={item.to}
            {...stylex.props(docsStyles.topbarNavLink)}
            activeProps={stylex.props(docsStyles.topbarNavLink, docsStyles.topbarNavLinkActive)}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
