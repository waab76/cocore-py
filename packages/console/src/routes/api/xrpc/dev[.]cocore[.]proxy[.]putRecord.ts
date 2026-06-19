// POST /api/xrpc/dev.cocore.proxy.putRecord  — DEPRECATED ALIAS
//
// Canonical endpoint is now `/api/pds/putRecord`. Kept only for
// already-deployed agents; new callers must use the canonical path.

import { createFileRoute } from "@tanstack/react-router";

import { pdsPutRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/xrpc/dev.cocore.proxy.putRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsPutRecord(request),
    },
  },
});
