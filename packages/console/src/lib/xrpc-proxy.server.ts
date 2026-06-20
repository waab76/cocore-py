// Reverse-proxy for the AppView's public XRPC read/query API.
//
// The AppView is reachable from the console only over private Railway DNS
// (`COCORE_APPVIEW_URL`, e.g. http://services.railway.internal:8081), which
// must never appear in user-facing docs/curl. Serving the same `/xrpc/*`
// surface from the console lets the public base URL be the console's own
// origin (https://console.cocore.dev/xrpc/...).
//
// Only the `/xrpc/*` namespace is proxied — that's the AppView's public API.
// The internal write endpoints (`/internal/pds/*`, `/pds/*`) are a different
// path prefix and are not reachable through here.

import { cocoreConfig } from "@/lib/cocore-config.ts";

const FORWARDED_REQUEST_HEADERS = ["content-type", "authorization", "accept"] as const;

/** Forward an `/xrpc/<nsid>` request to the AppView, preserving method,
 *  query string, body, and auth, and stream the response back verbatim. */
export async function proxyXrpcToAppview(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  const base = cocoreConfig().appviewUrl.replace(/\/$/, "");
  // incoming.pathname is already `/xrpc/<nsid>`; keep it plus the query.
  const target = `${base}${incoming.pathname}${incoming.search}`;

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const init: RequestInit = { method: request.method, headers };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.text();
  }

  let upstream: Response;
  try {
    upstream = await fetch(target, init);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: "AppviewUnreachable", message: (e as Error).message }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }

  const respHeaders = new Headers();
  const contentType = upstream.headers.get("content-type");
  if (contentType) respHeaders.set("content-type", contentType);
  return new Response(upstream.body, { status: upstream.status, headers: respHeaders });
}
