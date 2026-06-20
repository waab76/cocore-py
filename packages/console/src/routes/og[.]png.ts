import { Effect } from "effect";
import { createFileRoute } from "@tanstack/react-router";

import { renderOgPngEffect, type OgCardOptions } from "@/og/render-root-og-png.server.ts";

const ONE_DAY = 60 * 60 * 24;

/** Trim crawler-supplied params so a long query can't blow up the card layout. */
function clamp(value: string | null, max: number): string | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

export const Route = createFileRoute("/og.png")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const opts: OgCardOptions = {
          eyebrow: clamp(url.searchParams.get("eyebrow"), 60),
          title: clamp(url.searchParams.get("title"), 60),
          description: clamp(url.searchParams.get("description"), 200),
        };
        const body = await Effect.runPromise(renderOgPngEffect(opts));
        return new Response(body, {
          headers: {
            "Content-Type": "image/png",
            "Cache-Control": `public, max-age=${ONE_DAY}, s-maxage=${ONE_DAY}`,
          },
        });
      },
    },
  },
});
