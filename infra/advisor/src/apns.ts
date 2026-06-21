// APNs code-identity sender. The advisor's half of the AMFI-gated code-identity
// challenge: it seals a fresh nonce to the provider's X25519 key `K` and pushes
// it to the measured agent's device token over APNs. Only the genuine,
// team-signed binary can receive that push (AMFI gates the topic to our code
// signature) and open it (K lives in the agent's protected memory), so a valid
// response proves code identity in a way a self-reported cdHash cannot.
//
// Token-auth (.p8) ES256 JWT, production gateway. The .p8 is a secret and is
// read from the environment (never the repo). Proven end-to-end by the S5 spike
// (provider/spikes/apns) — this is the same flow in TypeScript.

import crypto from "node:crypto";
import nacl from "tweetnacl";

const APNS_HOST = "https://api.push.apple.com";
// Apple rejects a provider token refreshed more than once per ~20 min
// (TooManyProviderTokenUpdates) and expires it after 60 min. Refresh well
// inside that window and reuse otherwise.
const JWT_TTL_MS = 40 * 60_000;

export interface ApnsConfig {
  /** PEM contents of the .p8 token-auth key (APNS_AUTH_KEY). */
  authKeyPem: string;
  /** 10-char Key ID of the .p8 (APNS_KEY_ID). */
  keyId: string;
  /** 10-char Apple Team ID (APNS_TEAM_ID). */
  teamId: string;
  /** Push topic = the agent's bundle id, e.g. dev.cocore.provider (APNS_TOPIC). */
  topic: string;
}

/** Read APNs config from the environment. Returns null (feature disabled, no
 *  enforcement) unless all four vars are present — so an advisor without APNs
 *  configured keeps its current behavior and never blocks confidential. */
export function loadApnsConfig(
  env: Record<string, string | undefined> = process.env,
): ApnsConfig | null {
  const authKeyPem = env.APNS_AUTH_KEY;
  const keyId = env.APNS_KEY_ID;
  const teamId = env.APNS_TEAM_ID;
  const topic = env.APNS_TOPIC;
  if (!authKeyPem || !keyId || !teamId || !topic) return null;
  return { authKeyPem, keyId, teamId, topic };
}

function b64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Build (and cache) the ES256 provider JWT. Exported for testing. */
export function buildApnsJwt(
  cfg: ApnsConfig,
  now = Date.now(),
  cache: { jwt?: string; iat?: number } = jwtCache,
): string {
  if (cache.jwt && cache.iat && now - cache.iat < JWT_TTL_MS) return cache.jwt;
  const header = { alg: "ES256", kid: cfg.keyId };
  const payload = { iss: cfg.teamId, iat: Math.floor(now / 1000) };
  const signingInput =
    b64url(Buffer.from(JSON.stringify(header))) +
    "." +
    b64url(Buffer.from(JSON.stringify(payload)));
  const key = crypto.createPrivateKey(cfg.authKeyPem);
  // JOSE requires the raw R||S form (ieee-p1363), not DER.
  const sig = crypto.sign("SHA256", Buffer.from(signingInput), {
    key,
    dsaEncoding: "ieee-p1363",
  });
  const jwt = signingInput + "." + b64url(sig);
  cache.jwt = jwt;
  cache.iat = now;
  return jwt;
}
const jwtCache: { jwt?: string; iat?: number } = {};

/** Seal `nonce` to the provider's X25519 key with a fresh ephemeral key
 *  (NaCl box, same wire format as the provider's `open_from`). Returns the
 *  push payload's `cc` object. Exported for testing. */
export function sealCodeChallenge(
  nonce: string,
  encryptionPubKeyB64: string,
): { epk: string; n: string } {
  const recipient = new Uint8Array(Buffer.from(encryptionPubKeyB64, "base64"));
  const eph = nacl.box.keyPair();
  const msg = new TextEncoder().encode(nonce);
  const boxNonce = nacl.randomBytes(nacl.box.nonceLength);
  const body = nacl.box(msg, boxNonce, recipient, eph.secretKey);
  const framed = new Uint8Array(boxNonce.length + body.length);
  framed.set(boxNonce, 0);
  framed.set(body, boxNonce.length);
  return {
    epk: Buffer.from(eph.publicKey).toString("base64"),
    n: Buffer.from(framed).toString("base64"),
  };
}

export interface ApnsSendResult {
  ok: boolean;
  status: number;
  /** Apple's reason string on failure (BadDeviceToken, TopicDisallowed, …). */
  reason?: string;
  apnsId?: string;
}

/** Push a sealed code-identity challenge to a provider's device token. */
export async function sendCodeChallenge(
  cfg: ApnsConfig,
  deviceToken: string,
  encryptionPubKeyB64: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ApnsSendResult> {
  const cc = sealCodeChallenge(nonce, encryptionPubKeyB64);
  const body = JSON.stringify({ aps: { "content-available": 1 }, cc });
  let res: Response;
  try {
    res = await fetchImpl(`${APNS_HOST}/3/device/${deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${buildApnsJwt(cfg)}`,
        "apns-topic": cfg.topic,
        "apns-push-type": "background",
        "apns-priority": "5",
        "apns-expiration": "0",
      },
      body,
    });
  } catch (e) {
    return { ok: false, status: 0, reason: String(e) };
  }
  const apnsId = res.headers.get("apns-id") ?? undefined;
  if (res.status === 200) return { ok: true, status: 200, apnsId };
  let reason: string | undefined;
  try {
    reason = (JSON.parse(await res.text()) as { reason?: string }).reason;
  } catch {
    // non-JSON body; leave reason undefined
  }
  return { ok: false, status: res.status, reason, apnsId };
}
