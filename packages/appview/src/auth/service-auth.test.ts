import { describe, expect, it } from "vitest";

import { verifyServiceAuth } from "./service-auth.ts";

const AUD = "did:web:appview.test";
const LXM = "dev.cocore.account.listApiKeys";

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Build a JWT string. The signature segment is a placeholder — every
 *  case here is rejected before signature verification / DID resolution,
 *  so no network or real key is needed. */
function jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  sig = "sig",
): string {
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}

function reqWith(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  return new Request("http://appview.test/xrpc/dev.cocore.account.listApiKeys", { headers });
}

const future = () => Math.floor(Date.now() / 1000) + 300;

const goodHeader = { alg: "ES256", typ: "JWT" };
const goodPayload = () => ({ iss: "did:plc:alice", aud: AUD, lxm: LXM, exp: future() });

async function expectFail(request: Request, error: string) {
  const r = await verifyServiceAuth(request, { audience: AUD, lxm: LXM });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(401);
    expect(r.error).toBe(error);
  }
}

describe("verifyServiceAuth — pre-resolution rejections", () => {
  it("AuthRequired when no bearer token", async () => {
    await expectFail(reqWith(), "AuthRequired");
  });

  it("BadJwt on a malformed (non-3-part) token", async () => {
    await expectFail(reqWith("not.a.jwt.token"), "BadJwt");
    await expectFail(reqWith("onlyonepart"), "BadJwt");
  });

  it("BadJwt on an unsupported alg", async () => {
    await expectFail(reqWith(jwt({ alg: "RS256" }, goodPayload())), "BadJwt");
  });

  it("BadJwtIssuer when iss is not a DID", async () => {
    await expectFail(
      reqWith(jwt(goodHeader, { ...goodPayload(), iss: "alice.test" })),
      "BadJwtIssuer",
    );
  });

  it("BadJwtAudience when aud does not match this service", async () => {
    await expectFail(
      reqWith(jwt(goodHeader, { ...goodPayload(), aud: "did:web:someone-else" })),
      "BadJwtAudience",
    );
  });

  it("BadJwtLexicon when lxm does not match the method", async () => {
    await expectFail(
      reqWith(jwt(goodHeader, { ...goodPayload(), lxm: "dev.cocore.account.createApiKey" })),
      "BadJwtLexicon",
    );
  });

  it("BadJwt when exp is missing", async () => {
    await expectFail(
      reqWith(jwt(goodHeader, { iss: "did:plc:alice", aud: AUD, lxm: LXM })),
      "BadJwt",
    );
  });

  it("JwtExpired when exp is in the past", async () => {
    await expectFail(
      reqWith(jwt(goodHeader, { ...goodPayload(), exp: Math.floor(Date.now() / 1000) - 600 })),
      "JwtExpired",
    );
  });
});
