// POST /api/xrpc/dev.cocore.proxy.deleteRecord  — DEPRECATED ALIAS
//
// Canonical endpoint is now `/api/pds/deleteRecord`. Kept only for
// already-deployed agents; new callers must use the canonical path.

import { createFileRoute } from "@tanstack/react-router";

import { pdsDeleteRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/xrpc/dev.cocore.proxy.deleteRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsDeleteRecord(request),
    },
  },
});
