import type { OAuthSession } from "@atcute/oauth-node-client";
import { isDid } from "@atcute/lexicons/syntax";
import { Effect } from "effect";

import { restoreAtprotoSessionEffect } from "@/integrations/auth/atproto.server.ts";
import {
  resolveAppSessionToken,
  revokeAppSession,
} from "@/integrations/auth/app-session-store.server.ts";
import {
  appviewBackedSession,
  appviewSessionInfo,
} from "@/lib/appview-backed-session.server.ts";
import { isAppviewForwardConfigured } from "@/lib/appview-pds-forward.server.ts";
import { runTraced } from "@/lib/o11y.server.ts";
import { readAllAuthSessionTokens } from "@/integrations/auth/cookie-parse.ts";

export type AtprotoSessionContext = {
  did: string;
  oauthSession: OAuthSession;
};

export function atprotoSessionForRequestEffect(
  request: Request,
): Effect.Effect<AtprotoSessionContext | undefined> {
  return Effect.gen(function* () {
    // The browser may present more than one `cocore-auth.session_token` after
    // the host-only → Domain=cocore.dev cookie cutover (see
    // readAllAuthSessionTokens). The stale host-only cookie sorts first, so we
    // can't trust just the first value — try each candidate and use the first
    // that resolves to a live session.
    const sessionTokens = readAllAuthSessionTokens(request.headers.get("cookie"));
    if (sessionTokens.length === 0) return undefined;

    for (const sessionToken of sessionTokens) {
      const app = resolveAppSessionToken(sessionToken);
      if (!app) continue;

      const { did } = app;
      if (!isDid(did)) continue;

      // Single-owner cutover: when forwarding is configured the AppView owns
      // (and solely refreshes) this DID's session. Restoring locally here
      // would refresh in parallel and cannibalize the single-use refresh
      // token, so instead hand back an AppView-backed session and ask the
      // AppView — the owner — whether a live session exists. Only a
      // DEFINITIVE "absent" (not a transient AppView blip) drops the app
      // session for re-auth.
      if (isAppviewForwardConfigured()) {
        const info = yield* Effect.promise(() => appviewSessionInfo(did));
        if (info.checked && !info.present) {
          revokeAppSession(sessionToken);
          continue;
        }
        return { did, oauthSession: appviewBackedSession(did) };
      }

      const oauthSession = yield* restoreAtprotoSessionEffect(did);
      if (!oauthSession) {
        // OAuth session is gone (revoked or never written). Drop this app
        // session so the user re-authenticates; don't try to revoke at the
        // auth server (already gone). Keep checking the other candidates.
        revokeAppSession(sessionToken);
        continue;
      }

      return { did, oauthSession };
    }

    return undefined;
  });
}

/** Valid AT Proto OAuth session plus DID from opaque server cookie. */
export function getAtprotoSessionForRequest(
  request: Request,
): Promise<AtprotoSessionContext | undefined> {
  return runTraced("auth.sessionForRequest", atprotoSessionForRequestEffect(request));
}
