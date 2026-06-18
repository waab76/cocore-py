import * as stylex from "@stylexjs/stylex";
import type { QueryClient } from "@tanstack/react-query";
import { HeadContent, Scripts, createRootRouteWithContext } from "@tanstack/react-router";

import appCss from "../styles.css?url";

import { SITE_MARKETING_DESCRIPTION, SITE_MARKETING_TITLE } from "@/lib/site-marketing.shared.ts";
import { OG_HEIGHT, OG_WIDTH } from "@/og/root-og.tokens.ts";
import { ToastRegion } from "@/design-system/toast";
import { primaryColor, uiColor } from "@/design-system/theme/color.stylex";
import { radius } from "@/design-system/theme/radius.stylex";
import { fontFamily } from "@/design-system/theme/typography.stylex";
import { sand } from "@/design-system/theme/colors/sand.stylex";
import { brown } from "@/design-system/theme/colors/brown.stylex";

const THEME_INIT_SCRIPT = `(function(){try{var stored=window.localStorage.getItem('theme');var mode=(stored==='light'||stored==='dark'||stored==='auto')?stored:'auto';var prefersDark=window.matchMedia('(prefers-color-scheme: dark)').matches;var resolved=mode==='auto'?(prefersDark?'dark':'light'):mode;var root=document.documentElement;root.classList.remove('light','dark');root.classList.add(resolved);if(mode==='auto'){root.removeAttribute('data-theme')}else{root.setAttribute('data-theme',mode)}root.style.colorScheme=resolved;}catch(e){}})();`;

function openGraphImageHref(): string {
  const base = process.env["CONSOLE_PUBLIC_URL"]?.trim().replace(/\/$/, "");
  return base ? `${base}/og.png` : "/og.png";
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "co/core console" },
      {
        name: "description",
        content: "co/core: ATProto-native receipts of work for decentralized compute.",
      },
      { property: "og:title", content: SITE_MARKETING_TITLE },
      { property: "og:description", content: SITE_MARKETING_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:image", content: openGraphImageHref() },
      { property: "og:image:width", content: String(OG_WIDTH) },
      { property: "og:image:height", content: String(OG_HEIGHT) },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: SITE_MARKETING_TITLE },
      { name: "twitter:description", content: SITE_MARKETING_DESCRIPTION },
      { name: "twitter:image", content: openGraphImageHref() },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "apple-touch-icon", href: "/app-icon.svg" },
      {
        rel: "stylesheet",
        href: appCss,
      },
      import.meta.env.DEV
        ? {
            rel: "stylesheet",
            href: "/virtual:stylex.css",
          }
        : null,
      {
        rel: "preconnect",
        href: "https://fonts.googleapis.com",
      },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossorigin: true,
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=Space+Mono:ital,wght@0,400;0,700;1,400;1,700&display=swap",
      },
    ].filter((x): x is NonNullable<typeof x> => x !== null),
  }),
  shellComponent: RootDocument,
});

const styles = stylex.create({
  html: {
    height: "100%",
  },
  body: {
    backgroundColor: uiColor.bg,
    color: uiColor.text2,
    fontFamily: fontFamily.sans,
    margin: 0,
    height: "100%",
  },
});

const primaryColorTheme = stylex.createTheme(primaryColor, {
  bg: brown.bg,
  bgSubtle: brown.bgSubtle,
  component1: brown.component1,
  component2: brown.component2,
  component3: brown.component3,
  border1: brown.border1,
  border2: brown.border2,
  border3: brown.border3,
  solid1: brown.solid1,
  solid2: brown.solid2,
  text1: brown.text1,
  text2: brown.text2,
});

const uiColorTheme = stylex.createTheme(uiColor, {
  bg: sand.bg,
  bgSubtle: sand.bgSubtle,
  component1: sand.component1,
  component2: sand.component2,
  component3: sand.component3,
  border1: sand.border1,
  border2: sand.border2,
  border3: sand.border3,
  solid1: sand.solid1,
  solid2: sand.solid2,
  text1: sand.text1,
  text2: sand.text2,
});

const fontTheme = stylex.createTheme(fontFamily, {
  mono: "Space Mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  sans: "Space Mono, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
  serif: "Georgia, serif",
  title: "Space Grotesk, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
});

const radiusTheme = stylex.createTheme(radius, {
  xs: "0.25rem",
  sm: "0.375rem",
  md: "0.5rem",
  lg: "0.75rem",
  xl: "1rem",
  "2xl": "1.25rem",
  "3xl": "1.5rem",
  "4xl": "2rem",
  full: "9999px",
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning {...stylex.props(styles.html)}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        {/* Privacy-friendly analytics by Plausible */}
        <script async src="https://plausible.io/js/pa-RGZxFs9DuADEgNjdbqduF.js" />
        <script
          dangerouslySetInnerHTML={{
            __html:
              "window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};plausible.init()",
          }}
        />
        <HeadContent />
      </head>
      <body {...stylex.props(fontTheme, radiusTheme, primaryColorTheme, uiColorTheme, styles.body)}>
        {children}
        <ToastRegion />
        <Scripts />
      </body>
    </html>
  );
}
