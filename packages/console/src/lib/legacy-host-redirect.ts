// Redirect the human-facing console pages from the legacy host
// (console.cocore.dev) to the canonical apex (cocore.dev).
//
// CRITICAL SAFETY CONSTRAINT: console.cocore.dev must keep *serving*
// (never redirect) the paths baked into already-installed agents and the
// `curl …/agent | sh` installer — `/agent*`, `/api*`, `/v1*`, `/xrpc*`,
// `/.well-known/*` (plus the DID docs and `/lexicons/*`). Those are all
// server-handler routes that live OUTSIDE the two page layouts, and only
// the page routes (`/_header-layout/*`, `/_docs-header-layout/*`, `/login`)
// call `enforceCanonicalConsoleHost`. So the redirect is safe by
// construction: this code is never in the agent/API request path, and the
// failure mode is "a page we forgot doesn't redirect" — never "an agent
// path got redirected". See the cocore.dev cutover notes / CLAUDE.md.

import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

const LEGACY_CONSOLE_HOST = "console.cocore.dev";
const CANONICAL_CONSOLE_HOST = "cocore.dev";

/**
 * Pure host-decision core (kept separate from the server fn so it's
 * unit-testable). Given the request URL and the relevant headers, returns
 * the absolute https://cocore.dev URL to redirect to — path + query
 * preserved — when the request arrived on the legacy console host, or
 * `null` when it didn't (canonical host, localhost, *.up.railway.app
 * previews, etc.).
 *
 * `x-forwarded-host` wins over the `Host` header because Railway's edge
 * forwards the public hostname there; both fall back to the URL's own host.
 */
export function canonicalConsoleRedirectUrl(
  requestUrl: string,
  hostHeader: string | null,
  forwardedHost: string | null,
): string | null {
  const url = new URL(requestUrl);
  const rawHost = (forwardedHost?.split(",")[0] ?? hostHeader ?? url.host).trim();
  const hostname = rawHost.split(":")[0]?.toLowerCase() ?? "";
  if (hostname !== LEGACY_CONSOLE_HOST) return null;
  url.protocol = "https:";
  url.hostname = CANONICAL_CONSOLE_HOST;
  // Drop any inbound port so we always land on plain https://cocore.dev
  // (setting `hostname` alone would leave an existing :port attached).
  url.port = "";
  return url.toString();
}

/**
 * Server fn: reads the current request and returns the canonical redirect
 * target (or null). `@tanstack/react-start/server` can't be imported from
 * route files (the import-protection plugin blocks it), so the page routes
 * call this instead of touching `getRequest` directly.
 */
const legacyConsoleHostRedirectFn = createServerFn({ method: "GET" }).handler(async () => {
  const { getRequest } = await import("@tanstack/react-start/server");
  const request = getRequest();
  return canonicalConsoleRedirectUrl(
    request.url,
    request.headers.get("host"),
    request.headers.get("x-forwarded-host"),
  );
});

/**
 * Call from a page route's `beforeLoad`. On the server (initial document
 * render) it 30x's legacy-host requests to the canonical apex; on the
 * client it's a no-op (the body is dead-code-eliminated from the browser
 * bundle via `import.meta.env.SSR`, and the user is already on cocore.dev
 * after the first hop anyway).
 *
 * Uses 302 (temporary) for the initial rollout so a mistake isn't
 * hard-cached by browsers. Once the page/agent split is confirmed in
 * production, flip to `statusCode: 301`.
 */
export async function enforceCanonicalConsoleHost(): Promise<void> {
  if (!import.meta.env.SSR) return;
  const target = await legacyConsoleHostRedirectFn();
  if (target) {
    throw redirect({ href: target, statusCode: 302 });
  }
}
