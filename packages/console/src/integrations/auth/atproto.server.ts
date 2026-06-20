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

function oauthRestoreSessionEffect(did: Did): Effect.Effect<RestoredSession, unknown> {
  return Effect.async((resume) => {
    void getAtprotoOAuth()
      .restore(did)
      .then(
        (r) => resume(Effect.succeed(r)),
        (e) => resume(Effect.fail(e)),
      );
  });
}

export const restoreAtprotoSessionEffect = (did: Did): Effect.Effect<RestoredSession | null> =>
  Effect.gen(function* () {
    const outcome = yield* Effect.either(oauthRestoreSessionEffect(did));
    if (Either.isLeft(outcome)) return null;
    return outcome.right;
  });
