"use client";

import * as stylex from "@stylexjs/stylex";
import { Link } from "@tanstack/react-router";

import { Flex } from "@/design-system/flex";
import { NavbarLogo } from "@/design-system/navbar";
import { primaryColor } from "@/design-system/theme/color.stylex";
import { fontSize } from "@/design-system/theme/typography.stylex";
import { Text } from "@/design-system/typography/text";

import { docsStyles } from "./docs-page.stylex.tsx";

const logoStyles = stylex.create({
  logoLink: {
    textDecoration: "none",
    color: primaryColor.text2,
  },
  logoText: {
    color: primaryColor.textContrast,
    cornerRadius: "squircle",
    fontSize: fontSize.xs,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  },
  logoMark: {
    display: "block",
    width: "1.125rem",
    height: "1.125rem",
  },
});

const NAV_ITEMS = [
  { label: "Inference", to: "/docs/inference" as const },
  { label: "XRPC", to: "/docs/api" as const },
  { label: "Lexicons", to: "/docs/lexicons" as const },
] as const;

export function DocsTopbar() {
  return (
    <header {...stylex.props(docsStyles.topbar)}>
      <div {...stylex.props(docsStyles.topbarLeft)}>
        <Link to="/" preload="intent" {...stylex.props(logoStyles.logoLink)}>
          <NavbarLogo>
            <Flex align="center" gap="md">
              <div {...stylex.props(logoStyles.logoText)}>
                <img
                  src="/favicon.svg"
                  alt=""
                  width={18}
                  height={18}
                  {...stylex.props(logoStyles.logoMark)}
                />
              </div>
              <Text>co/core</Text>
            </Flex>
          </NavbarLogo>
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
