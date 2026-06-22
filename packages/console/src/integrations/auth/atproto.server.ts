import type { Did } from "@atcute/lexicons";
import type {
  AuthorizeOptions,
  CallbackOptions,
  ClientAssertionPrivateJwk,
  StoredState,
} from "@atcute/oauth-node-client";
import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { NodeDnsHandleResolver } from "@atcute/identity-resolver-node";
import { MemoryStore, OAuthClient } from "@atcute/oauth-node-client";
import { Effect, Either } from "effect";

import { SqliteOauthSessionStore } from "@/lib/oauth-session-store.server.ts";

import { oauthScopes } from "./scope.ts";

const OAUTH_STATE_TTL_MS = 15 * 60_000;

// Sessions live in SQLite (durable across console restarts). API keys
// reference them by DID, so a deploy can't invalidate every issued
// key. State (the in-flight handshake) stays in memory — it's
// short-lived and doesn't need to survive a redeploy.
const sessionStore = new SqliteOauthSessionStore();
const stateMemory = new MemoryStore<string, StoredState>({
  ttl: OAUTH_STATE_TTL_MS,
  ttlAutopurge: true,
});

function getPrivateKey(): ClientAssertionPrivateJwk {
  const keyJson = process.env.ATPROTO_PRIVATE_KEY_JWK;
  if (!keyJson) {
    throw new Error(
      "ATPROTO_PRIVATE_KEY_JWK environment variable is required for non-local OAuth clients.",
    );
  }
  return JSON.parse(keyJson) as ClientAssertionPrivateJwk;
}

/**
 * Railway forks PR/preview environments from production and copies its
 * variables, so an inherited CONSOLE_PUBLIC_URL points every preview at the
 * prod origin. That's why OAuth login on a preview bounces back to prod: the
 * client_id metadata / redirect_uris this client serves are baked from the
 * base URL, so they advertise prod's callback and the PDS redirects there. In
 * a non-production Railway environment, prefer that environment's own public
 * domain so the OAuth client is self-consistent with the URL the user is on.
 */
function railwayPreviewBaseUrl(): string | undefined {
  const env = process.env.RAILWAY_ENVIRONMENT_NAME;
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (domain && env && env !== "production") {
    return `https://${domain}`;
  }
  return undefined;
}

/** Same precedence as kikbak: explicit auth URL, console public URL, localhost. */
function getBaseUrl(): string {
  const url =
    railwayPreviewBaseUrl() ||
    process.env.BETTER_AUTH_URL ||
    process.env.ATPROTO_BASE_URL ||
    process.env.CONSOLE_PUBLIC_URL;
  if (url) {
    return url.replace(/\/$/, "");
  }
  // Match pair-store.ts and provider-session-from-oauth.server.ts — local
  // `pnpm dev` / `mise dev` does not require a .env file for OAuth to start.
  return "http://localhost:3000";
}

function isPublicClient(): boolean {
  const baseUrl = getBaseUrl();
  return baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1");
}

function getRedirectUri(): string {
  const baseUrl = getBaseUrl();
  if (isPublicClient()) {
    return `${baseUrl.replace("localhost", "127.0.0.1").replace(/\/$/, "")}/api/auth/atproto/callback`;
  }
  return `${baseUrl}/api/auth/atproto/callback`;
}

let _atprotoOAuth: InstanceType<typeof OAuthClient> | null = null;

function getAtprotoOAuth(): InstanceType<typeof OAuthClient> {
  if (!_atprotoOAuth) {
    const baseUrl = getBaseUrl();
    const redirectUri = getRedirectUri();
    const isPublic = isPublicClient();

    if (isPublic) {
      _atprotoOAuth = new OAuthClient({
        metadata: {
          redirect_uris: [redirectUri],
          scope: oauthScopes,
        },
        stores: {
          sessions: sessionStore,
          states: stateMemory,
        },
        actorResolver: new LocalActorResolver({
          handleResolver: new CompositeHandleResolver({
            methods: {
              dns: new NodeDnsHandleResolver(),
              http: new WellKnownHandleResolver(),
            },
          }),
          didDocumentResolver: new CompositeDidDocumentResolver({
            methods: {
              plc: new PlcDidDocumentResolver(),
              web: new WebDidDocumentResolver(),
            },
          }),
        }),
      });
    } else {
      _atprotoOAuth = new OAuthClient({
        metadata: {
          client_id: `${baseUrl}/api/auth/atproto/metadata.json`,
          redirect_uris: [redirectUri],
          scope: oauthScopes,
          jwks_uri: `${baseUrl}/api/auth/atproto/jwks.json`,
        },
        keyset: [getPrivateKey()],
        stores: {
          sessions: sessionStore,
          states: stateMemory,
        },
        actorResolver: new LocalActorResolver({
          handleResolver: new CompositeHandleResolver({
            methods: {
              dns: new NodeDnsHandleResolver(),
              http: new WellKnownHandleResolver(),
            },
          }),
          didDocumentResolver: new CompositeDidDocumentResolver({
            methods: {
              plc: new PlcDidDocumentResolver(),
              web: new WebDidDocumentResolver(),
            },
          }),
        }),
      });
    }
  }
  return _atprotoOAuth;
}

export const atprotoOAuth = new Proxy({} as InstanceType<typeof OAuthClient>, {
  get(_target, prop) {
    return getAtprotoOAuth()[prop as keyof InstanceType<typeof OAuthClient>];
  },
});

/** Effect version of {@link OAuthClient.authorize}; failures are typed as `unknown`. */
export function atprotoOAuthAuthorizeEffect(
  options: AuthorizeOptions,
): Effect.Effect<Awaited<ReturnType<InstanceType<typeof OAuthClient>["authorize"]>>, unknown> {
  return Effect.async((resume) => {
    void getAtprotoOAuth()
      .authorize(options)
      .then(
        (r) => resume(Effect.succeed(r)),
        (e) => resume(Effect.fail(e)),
      );
  });
}

/** Effect version of {@link OAuthClient.callback}; failures are typed as `unknown`. */
export function atprotoOAuthCallbackEffect(
  params: URLSearchParams,
  options?: CallbackOptions,
): Effect.Effect<Awaited<ReturnType<InstanceType<typeof OAuthClient>["callback"]>>, unknown> {
  return Effect.async((resume) => {
    void getAtprotoOAuth()
      .callback(params, options)
      .then(
        (r) => resume(Effect.succeed(r)),
        (e) => resume(Effect.fail(e)),
      );
  });
}

type RestoredSession = Awaited<ReturnType<OAuthClient["restore"]>>;

// Per-DID single-flight around OAuthClient.restore(). When an access token has
// expired, restore() refreshes it — and the DPoP refresh token is SINGLE-USE
// (rotated on every refresh). The agent writes a burst of records (provisioning
// provider + provider + attestation) as separate concurrent requests; without
// coalescing, each restore refreshes in parallel, races on the same refresh
// token, and all but one fail with invalid_grant — which the client treats as a
// dead session and deletes, so EVERY subsequent write 401s ("underlying ATProto
// session no longer valid") until re-auth… whereupon the next burst kills it
// again. `@atcute/oauth-node-client` has no built-in request lock, so we
// serialize per DID here: the first caller refreshes once, the rest await it and
// reuse the freshly-rotated session.
const restoreInFlight = new Map<string, Promise<RestoredSession>>();

function restoreSessionOnce(did: Did): Promise<RestoredSession> {
  const existing = restoreInFlight.get(did);
  if (existing) return existing;
  const p = getAtprotoOAuth()
    .restore(did)
    .finally(() => {
      restoreInFlight.delete(did);
    });
  restoreInFlight.set(did, p);
  return p;
}

function oauthRestoreSessionEffect(did: Did): Effect.Effect<RestoredSession, unknown> {
  return Effect.async((resume) => {
    void restoreSessionOnce(did).then(
      (r) => resume(Effect.succeed(r)),
      (e) => resume(Effect.fail(e)),
    );
  });
}

// DIAGNOSTIC: restore historically swallowed ANY error into `null`, so a dead
// session was indistinguishable from a refresh-failure / store-miss / DPoP
// problem. Capture the last failure reason per DID (logged + surfaced in the
// 401 body) so we can finally see WHY a freshly-authed session won't restore.
const lastRestoreErrorByDid = new Map<string, string>();

export function lastRestoreError(did: string): string | undefined {
  return lastRestoreErrorByDid.get(did);
}

export const restoreAtprotoSessionEffect = (did: Did): Effect.Effect<RestoredSession | null> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.either(oauthRestoreSessionEffect(did));
    if (Either.isLeft(outcome)) {
      const reason =
        outcome.left instanceof Error
          ? `${outcome.left.name}: ${outcome.left.message}`
          : String(outcome.left);
      lastRestoreErrorByDid.set(did, reason.slice(0, 300));
      console.error(`[atproto.restore] FAILED did=${did} reason=${reason}`);
      return null;
    }
    if (outcome.right == null) {
      lastRestoreErrorByDid.set(did, "restore returned null (no stored session)");
      console.error(`[atproto.restore] null session did=${did} (no stored session)`);
      return null;
    }
    lastRestoreErrorByDid.delete(did);
    return outcome.right;
  });
