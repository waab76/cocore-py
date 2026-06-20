/** Helpers for per-page OG cards rendered by the `/og.png` route. */
import { OG_HEIGHT, OG_WIDTH } from "@/og/root-og.tokens.ts";

interface OgCardParams {
  eyebrow?: string;
  title?: string;
  description?: string;
}

function ogOrigin(): string {
  return process.env["CONSOLE_PUBLIC_URL"]?.trim().replace(/\/$/, "") ?? "";
}

/**
 * Absolute (when `CONSOLE_PUBLIC_URL` is set) or root-relative URL to the
 * `/og.png` card. Params customize the rendered card; pass none for the root
 * marketing card. Social crawlers require absolute URLs, so prefer setting
 * `CONSOLE_PUBLIC_URL` in deployed environments.
 */
export function ogImageHref(params?: OgCardParams): string {
  const base = ogOrigin();
  const qs = new URLSearchParams();
  if (params?.eyebrow) qs.set("eyebrow", params.eyebrow);
  if (params?.title) qs.set("title", params.title);
  if (params?.description) qs.set("description", params.description);
  const query = qs.toString();
  const path = query ? `/og.png?${query}` : "/og.png";
  return base ? `${base}${path}` : path;
}

/** og:* + twitter:* meta entries for a page, sharing one `image`. */
export function socialMeta(opts: { title: string; description: string; image: string }) {
  return [
    { property: "og:title", content: opts.title },
    { property: "og:description", content: opts.description },
    { property: "og:type", content: "website" },
    { property: "og:image", content: opts.image },
    { property: "og:image:width", content: String(OG_WIDTH) },
    { property: "og:image:height", content: String(OG_HEIGHT) },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: opts.title },
    { name: "twitter:description", content: opts.description },
    { name: "twitter:image", content: opts.image },
  ];
}
