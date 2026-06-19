// Hand a freshly minted OAuth session off to the AppView.
//
// The end-state has the AppView own PDS writes (and thus a user's
// DPoP-bound OAuth session). Because refresh tokens are single-use, only
// one process may refresh a given session — so at login the console
// pushes the just-minted session to the AppView, which becomes its owner.
//
// This is best-effort and gated on configuration: when
// COCORE_APPVIEW_INTERNAL_URL + COCORE_INTERNAL_SECRET are set, we POST
// the session blob to the AppView's /internal/oauth-session. A failure
// (or missing config) never blocks login — the console still holds the
// session, so nothing regresses until the write path is cut over.

import { consoleDb } from "@/lib/console-db.server.ts";

/** Push the stored session blob for `did` to the AppView. Resolves to
 *  true on a 2xx handoff, false otherwise (including "not configured").
 *  Never throws. */
export async function handOffSessionToAppview(did: string): Promise<boolean> {
  const base = process.env["COCORE_APPVIEW_INTERNAL_URL"]?.replace(/\/$/, "");
  const secret = process.env["COCORE_INTERNAL_SECRET"];
  if (!base || !secret) return false;

  let data: string | undefined;
  try {
    const row = consoleDb().prepare(`SELECT data FROM oauth_sessions WHERE did = ?`).get(did) as
      | { data: string }
      | undefined;
    data = row?.data;
  } catch {
    return false;
  }
  if (!data) return false;

  try {
    const res = await fetch(`${base}/internal/oauth-session`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cocore-internal-secret": secret },
      // `data` is already the serialized StoredSession; forward verbatim.
      body: JSON.stringify({ did, data }),
    });
    if (!res.ok) {
      console.warn(`[appview-handoff] AppView returned ${res.status} for ${did}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`[appview-handoff] push failed for ${did}:`, (e as Error).message);
    return false;
  }
}
