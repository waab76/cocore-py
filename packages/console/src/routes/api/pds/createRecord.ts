// POST /api/pds/createRecord
//
// Canonical internal endpoint that creates an ATProto record on the
// caller's PDS via the console's DPoP-bound OAuth session. Bearer-key
// auth resolves the key → DID; only `dev.cocore.*` collections are
// allowed. See lib/pds-write.server.ts for the implementation and the
// rationale (the Rust agent + exchange can't mint DPoP tokens
// themselves, so they post here).

import { createFileRoute } from "@tanstack/react-router";

import { pdsCreateRecord } from "@/lib/pds-write.server.ts";

export const Route = createFileRoute("/api/pds/createRecord")({
  server: {
    handlers: {
      POST: ({ request }) => pdsCreateRecord(request),
    },
  },
});
