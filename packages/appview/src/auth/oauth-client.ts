// AppView-side atproto OAuth client.
//
// The AppView is the *executor* of PDS writes: it `restore()`s a
// DPoP-bound session and calls `session.handle()` for com.atproto.repo.*
// operations. It never runs the authorize/callback handshake — that
// stays browser-facing on the console, which hands the freshly minted
// session off to the AppView (see the session store). Because OAuth
// refresh tokens are single-use, exactly one process may own a session's
// refresh; once handed off, the AppView is that owner.
//
// For token refresh to succeed, this client must present the SAME
// `client_id` + keyset as the console that minted the session — so we
// mirror the console's config (client metadata served at the console
// origin, private key from ATPROTO_PRIVATE_KEY_JWK).

import type { Did } from "@atcute/lexicons";
import type { ClientAssertionPrivateJwk, StoredState } from "@atcute/oauth-node-client";
import {
  CompositeDidDocumentResolver,
  CompositeHandleResolver,
  LocalActorResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
  WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { NodeDnsHandleResolver } from "@atcute/identity-resolver-node";
import { MemoryStore, OAuthClient, scope as atprotoScope } from "@atcute/oauth-node-client";

import type { AccountStore } from "../operational/account-store.ts";
import { AccountOauthSessionStore } from "./oauth-session-store.ts";

const OAUTH_STATE_TTL_MS = 15 * 60_000;

/** Base URL of the console origin that owns the OAuth client identity
 *  (serves /api/auth/atproto/metadata.json + jwks.json). Same precedence
 *  as the console's getBaseUrl so both resolve to the same client_id. */
function getClientBaseUrl(): string {
  const url =
    process.env["ATPROTO_BASE_URL"] ||
    process.env["CONSOLE_PUBLIC_URL"] ||
    process.env["BETTER_AUTH_URL"];
  if (url) return url.replace(/\/$/, "");
  return "http://localhost:3000";
}

function isPublicClient(baseUrl: string): boolean {
  return baseUrl.startsWith("http://localhost") || baseUrl.startsWith("http://127.0.0.1");
}

function getRedirectUri(baseUrl: string): string {
  if (isPublicClient(baseUrl)) {
    return `${baseUrl.replace("localhost", "127.0.0.1").replace(/\/$/, "")}/api/auth/atproto/callback`;
  }
  return `${baseUrl}/api/auth/atproto/callback`;
}

function getPrivateKey(): ClientAssertionPrivateJwk {
  const keyJson = process.env["ATPROTO_PRIVATE_KEY_JWK"];
  if (!keyJson) {
    throw new Error("ATPROTO_PRIVATE_KEY_JWK is required for a non-local OAuth client");
  }
  return JSON.parse(keyJson) as ClientAssertionPrivateJwk;
}

// MUST stay in sync with the console's scope list
// (packages/console/src/integrations/auth/scope.ts) — both the minting
// client (console) and this restoring client should present the same
// grant. The AppView never calls authorize(), so this is low-impact for
// restore/refresh, but matching avoids any client-metadata mismatch.
const oauthScopes = [
  atprotoScope.account({ attr: "email", action: "read" }),
  atprotoScope.blob({ accept: ["image/*", "video/*"] }),
  atprotoScope.repo({
    collection: [
      "dev.cocore.compute.provider",
      "dev.cocore.compute.job",
      "dev.cocore.compute.paymentAuthorization",
      "dev.cocore.compute.attestation",
      "dev.cocore.compute.receipt",
      "dev.cocore.compute.settlement",
      "dev.cocore.compute.exchangePolicy",
      "dev.cocore.compute.exchangeAttestation",
      "dev.cocore.compute.termsAcceptance",
      "dev.cocore.compute.dispute",
      "dev.cocore.account.profile",
      "dev.cocore.account.friend",
      "dev.cocore.account.tokenGrant",
      "dev.cocore.account.tokenPatronage",
    ],
    action: ["create", "update", "delete"],
  }),
];

function actorResolver(): LocalActorResolver {
  return new LocalActorResolver({
    handleResolver: new CompositeHandleResolver({
      methods: { dns: new NodeDnsHandleResolver(), http: new WellKnownHandleResolver() },
    }),
    didDocumentResolver: new CompositeDidDocumentResolver({
      methods: { plc: new PlcDidDocumentResolver(), web: new WebDidDocumentResolver() },
    }),
  });
}

export type AppviewOAuthClient = InstanceType<typeof OAuthClient>;
export type RestoredSession = Awaited<ReturnType<AppviewOAuthClient["restore"]>>;

/** True when this process can construct a usable OAuth client: always for
 *  a localhost/public client, and for a confidential client only when the
 *  private key is present. Used to decide whether to register the PDS
 *  write routes. */
export function isOAuthConfigured(): boolean {
  const baseUrl = getClientBaseUrl();
  if (isPublicClient(baseUrl)) return true;
  return Boolean(process.env["ATPROTO_PRIVATE_KEY_JWK"]);
}

/** Build the AppView OAuth client, reading/writing sessions through the
 *  AccountStore. States live in memory (only the authorize/callback
 *  handshake uses them, which the AppView does not perform). */
export function makeAppviewOAuth(accounts: AccountStore): AppviewOAuthClient {
  const baseUrl = getClientBaseUrl();
  const redirectUri = getRedirectUri(baseUrl);
  const sessions = new AccountOauthSessionStore(accounts);
  const states = new MemoryStore<string, StoredState>({
    ttl: OAUTH_STATE_TTL_MS,
    ttlAutopurge: true,
  });

  if (isPublicClient(baseUrl)) {
    return new OAuthClient({
      metadata: { redirect_uris: [redirectUri], scope: oauthScopes },
      stores: { sessions, states },
      actorResolver: actorResolver(),
    });
  }
  return new OAuthClient({
    metadata: {
      client_id: `${baseUrl}/api/auth/atproto/metadata.json`,
      redirect_uris: [redirectUri],
      scope: oauthScopes,
      jwks_uri: `${baseUrl}/api/auth/atproto/jwks.json`,
    },
    keyset: [getPrivateKey()],
    stores: { sessions, states },
    actorResolver: actorResolver(),
  });
}

/** Restore the DPoP-bound session for `did`, or null if none is stored /
 *  it can no longer be refreshed. */
export async function restoreSession(
  client: AppviewOAuthClient,
  did: Did,
): Promise<RestoredSession | null> {
  try {
    return await client.restore(did);
  } catch {
    return null;
  }
}
