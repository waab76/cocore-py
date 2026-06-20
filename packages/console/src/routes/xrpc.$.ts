// Catch-all proxy for the AppView's public XRPC API.
//
// `/xrpc/<nsid>` requests that aren't served by an explicit console route
// (the API-key methods above) are forwarded to the AppView over private
// Railway DNS. This lets the documented public base URL be the console's
// own origin (https://console.cocore.dev/xrpc/...) instead of leaking the
// internal `COCORE_APPVIEW_URL`. Explicit routes outrank this splat, so the
// service-auth'd key methods keep their dedicated handlers.

import { createFileRoute } from "@tanstack/react-router";

import { proxyXrpcToAppview } from "@/lib/xrpc-proxy.server.ts";

export const Route = createFileRoute("/xrpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => proxyXrpcToAppview(request),
      POST: ({ request }) => proxyXrpcToAppview(request),
    },
  },
});
