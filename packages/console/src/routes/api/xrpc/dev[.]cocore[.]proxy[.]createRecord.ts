// POST /api/xrpc/dev.cocore.proxy.createRecord  — DEPRECATED ALIAS
//
// This path masquerades as an XRPC/lexicon method but never was one;
// the canonical endpoint is now `/api/pds/createRecord`. We keep this
// alias only so provider agents and exchange builds deployed before the
// rename keep publishing. New callers must use `/api/pds/createRecord`.
// Remove once old agents have aged out.

import { createFileRoute } from "@tanstack/react-router";

import { pdsCreateRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/xrpc/dev.cocore.proxy.createRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsCreateRecord(request),
    },
  },
});
