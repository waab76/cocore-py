// POST /api/pds/deleteRecord
//
// Canonical internal endpoint: delete a record on the caller's PDS via
// com.atproto.repo.deleteRecord. Bearer-key auth, `dev.cocore.*`
// allowlist; an already-absent record returns { alreadyGone: true }.
// See lib/pds-write.server.ts.

import { createFileRoute } from "@tanstack/react-router";

import { pdsDeleteRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/pds/deleteRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsDeleteRecord(request),
    },
  },
});
