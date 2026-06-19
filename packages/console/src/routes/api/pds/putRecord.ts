// POST /api/pds/putRecord
//
// Canonical internal endpoint: idempotent upsert at a stable rkey via
// com.atproto.repo.putRecord on the caller's PDS. Bearer-key auth,
// `dev.cocore.*` allowlist. See lib/pds-write.server.ts.

import { createFileRoute } from "@tanstack/react-router";

import { pdsPutRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/pds/putRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsPutRecord(request),
    },
  },
});
