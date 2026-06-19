// AT Protocol service-auth verification for AppView XRPC methods.
//
// Ported from the console's service-auth.server.ts (the canonical
// `dev.cocore.account.*` path), parameterized so it isn't tied to the
// console's config: the caller passes the expected `audience` (this
// service's DID) and `lxm` (the method NSID).
//
// A requester's client asks its own PDS to proxy the call
// (`atproto-proxy: <appviewDid>#cocore_appview`); the PDS mints a
// short-lived JWT signed by the user's repo signing key and forwards it
// as `Authorization: Bearer <jwt>`. The JWT carries:
//
//   iss  the requester's DID            (who we authenticate)
//   aud  this service's DID              (must equal `audience`)
//   lxm  the method NSID being called    (must equal `lxm`)
//   exp  expiry (unix seconds)
//
// We verify the signature against the key published in the issuer's DID
// document — a valid token *is* proof the holder controls that DID, with
// no shared secret and no credential of ours to leak.

import { getPublicKeyFromDidController, verifySig } from "@atcute/crypto";
import { getAtprotoVerificationMaterial } from "@atcute/identity";
import {
  CompositeDidDocumentResolver,
  PlcDidDocumentResolver,
  WebDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { Did } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import { fromBase64Url } from "@atcute/multibase";

/** Tolerance for clock skew between the issuing PDS and us. */
const CLOCK_SKEW_SECONDS = 30;

/** Success carries the authenticated DID; failure carries everything a
 *  handler needs to emit an error response. Distinct error codes mirror
 *  the standard atproto auth-failure vocabulary so callers can tell an
 *  expired token from a wrong audience. */
export type ServiceAuthResult =
  | { ok: true; did: string }
  | { ok: false; status: number; error: string; message: string };

function fail(status: number, error: string, message: string): ServiceAuthResult {
  return { ok: false, status, error, message };
}

// did:plc and did:web only — matches the repo-wide DID policy.
const didResolver = new CompositeDidDocumentResolver({
  methods: {
    plc: new PlcDidDocumentResolver(),
    web: new WebDidDocumentResolver(),
  },
});

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  lxm?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

function decodeJson(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(fromBase64Url(segment)));
}

export interface VerifyServiceAuthOptions {
  /** This service's DID. The JWT's `aud` must equal it. */
  audience: string;
  /** The method NSID. The JWT's `lxm` must equal it. */
  lxm: string;
}

/** Verify the service-auth JWT on `request` for `opts.audience` +
 *  `opts.lxm`. Convenience wrapper over {@link verifyServiceAuthToken}
 *  for Web `Request` callers; node:http handlers should extract the
 *  bearer token themselves and call `verifyServiceAuthToken`. */
export function verifyServiceAuth(
  request: Request,
  opts: VerifyServiceAuthOptions,
): Promise<ServiceAuthResult> {
  return verifyServiceAuthToken(readBearer(request), opts);
}

/** Verify a raw service-auth JWT string for `opts.audience` + `opts.lxm`.
 *  Returns the authenticated DID on success. Every failure collapses to
 *  a 401-shaped result (success vs. each failure isn't meaningfully
 *  distinguishable to an attacker; the error code aids legitimate
 *  debugging). Pass `null` when no token was presented. */
export async function verifyServiceAuthToken(
  jwt: string | null,
  opts: VerifyServiceAuthOptions,
): Promise<ServiceAuthResult> {
  if (!jwt) {
    return fail(401, "AuthRequired", "Authorization: Bearer <service-auth jwt> required");
  }

  const parts = jwt.split(".");
  if (parts.length !== 3) return fail(401, "BadJwt", "malformed JWT");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: unknown };
  let payload: JwtPayload;
  try {
    header = decodeJson(headerB64) as { alg?: unknown };
    payload = decodeJson(payloadB64) as JwtPayload;
  } catch {
    return fail(401, "BadJwt", "JWT header/payload not valid base64url JSON");
  }

  if (header.alg !== "ES256" && header.alg !== "ES256K") {
    return fail(401, "BadJwt", "unsupported JWT alg (expected ES256 or ES256K)");
  }

  const { iss, aud, lxm, exp, nbf } = payload;

  if (typeof iss !== "string" || !isDid(iss)) {
    return fail(401, "BadJwtIssuer", "iss must be a DID");
  }
  if (!iss.startsWith("did:plc:") && !iss.startsWith("did:web:")) {
    return fail(401, "BadJwtIssuer", "iss must be a did:plc or did:web");
  }
  if (aud !== opts.audience) {
    return fail(401, "BadJwtAudience", "aud does not match this service");
  }
  if (lxm !== opts.lxm) {
    return fail(401, "BadJwtLexicon", `lxm does not match ${opts.lxm}`);
  }
  if (typeof exp !== "number") {
    return fail(401, "BadJwt", "exp missing");
  }
  const now = Date.now() / 1000;
  if (exp <= now - CLOCK_SKEW_SECONDS) {
    return fail(401, "JwtExpired", "token expired");
  }
  if (typeof nbf === "number" && nbf > now + CLOCK_SKEW_SECONDS) {
    return fail(401, "BadJwt", "token not yet valid");
  }

  // Resolve the issuer's DID document and pull the atproto signing key.
  let material: { type: string; publicKeyMultibase: string } | undefined;
  try {
    const doc = await didResolver.resolve(iss as Did<"plc" | "web">);
    material = getAtprotoVerificationMaterial(doc);
  } catch {
    return fail(401, "BadJwtIssuer", "could not resolve issuer DID document");
  }
  if (!material) {
    return fail(401, "BadJwtIssuer", "issuer DID document has no atproto signing key");
  }

  let verified: boolean;
  try {
    const key = getPublicKeyFromDidController(material);
    if (key.jwtAlg !== header.alg) {
      return fail(401, "BadJwtSignature", "JWT alg does not match issuer key");
    }
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    verified = await verifySig(key, fromBase64Url(sigB64), data);
  } catch {
    return fail(401, "BadJwtSignature", "signature verification failed");
  }
  if (!verified) return fail(401, "BadJwtSignature", "signature verification failed");

  return { ok: true, did: iss };
}
