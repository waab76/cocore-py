// Build challenges and verify the provider's signed responses.
//
// The provider signs a sorted-key canonical JSON payload of
// `{ nonce, sipEnabled, timestamp }` (plus optional `hypervisorPresent`)
// with its P-256 attestation key. The wire ↔ signed-payload key
// mapping is *not* identical: wire fields are snake_case
// (`sip_enabled`, `hypervisor_present`) because the Rust struct
// fields are; the signed payload uses camelCase
// (`sipEnabled`, `hypervisorPresent`) to match the rest of the
// signed-record format documented in
// docs/adr/0001-d-inference-delta.md.
//
// We re-canonicalise here using the existing
// @cocore/sdk/canonical port (byte-identical to provider's
// canonical.rs) and verify with @cocore/sdk/p256.

import { canonicalize } from "@cocore/sdk/canonical";
import { verifyP256 } from "@cocore/sdk/p256";

import type {
  AttestationChallenge,
  AttestationResponse,
  CodeAttestationResponse,
} from "./protocol.ts";
import { bytesToBase64 } from "./protocol.ts";

/** Build a fresh challenge with a random nonce + current UTC. */
export function makeChallenge(now = new Date()): AttestationChallenge {
  const nonceBytes = new Uint8Array(16);
  crypto.getRandomValues(nonceBytes);
  // hex nonce — opaque to the provider, easy to grep in logs.
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    nonce,
    timestamp: rfc3339Seconds(now),
  };
}

/** A fresh random hex nonce for an APNs code-identity challenge. The advisor
 *  seals this to the provider's X25519 key and pushes it; the provider proves
 *  code identity by recovering and signing it. */
export function makeCodeNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** Reconstruct the canonical bytes the provider SE-signed for a code-identity
 *  challenge: `canonicalize({ nonce })` — byte-identical to the provider's
 *  `build_code_attestation_response`. */
export function codeSignedPayloadFor(nonce: string): Uint8Array {
  return new TextEncoder().encode(canonicalize({ nonce }));
}

/** Verify a CodeAttestationResponse signature against the provider's P-256
 *  attestation public key. The recovered nonce must equal `expectedNonce`
 *  (caller checks freshness) and the SE signature must verify over the
 *  canonical `{ nonce }`. Resolves false on any shape/verify error. */
export async function verifyCodeAttestation(
  resp: CodeAttestationResponse,
  expectedNonce: string,
  attestationPubKeyB64: string,
): Promise<boolean> {
  if (resp.nonce !== expectedNonce) return false;
  const sigDerB64 = bytesToBase64(resp.signature);
  const message = codeSignedPayloadFor(resp.nonce);
  try {
    return await verifyP256(attestationPubKeyB64, sigDerB64, message);
  } catch {
    return false;
  }
}

/** Reconstruct the canonical bytes the provider signed. */
export function signedPayloadFor(resp: AttestationResponse): Uint8Array {
  const obj: Record<string, unknown> = {
    nonce: resp.nonce,
    sipEnabled: resp.sip_enabled,
    timestamp: resp.timestamp,
  };
  if (typeof resp.hypervisor_present === "boolean") {
    obj["hypervisorPresent"] = resp.hypervisor_present;
  }
  return new TextEncoder().encode(canonicalize(obj));
}

/** Verify the AttestationResponse signature against an attestation
 *  public key (base64 raw uncompressed-without-04, 64 bytes — the
 *  shape published in the Register frame). Resolves to false on any
 *  shape error. */
export async function verifyAttestation(
  resp: AttestationResponse,
  attestationPubKeyB64: string,
): Promise<boolean> {
  const sigDerB64 = bytesToBase64(resp.signature);
  const message = signedPayloadFor(resp);
  try {
    return await verifyP256(attestationPubKeyB64, sigDerB64, message);
  } catch {
    return false;
  }
}

/** Assert the response echoes the challenge it was issued against
 *  AND the timestamp is recent enough that we haven't been replayed
 *  a stale exchange. `maxSkewMs` defaults to 5 minutes. */
export function isFresh(
  challenge: AttestationChallenge,
  resp: AttestationResponse,
  now = Date.now(),
  maxSkewMs = 5 * 60_000,
): boolean {
  if (resp.nonce !== challenge.nonce) return false;
  if (resp.timestamp !== challenge.timestamp) return false;
  const t = Date.parse(resp.timestamp);
  if (Number.isNaN(t)) return false;
  return Math.abs(now - t) <= maxSkewMs;
}

// RFC 3339 with seconds precision and a `Z` suffix — matches
// chrono's `to_rfc3339_opts(SecondsFormat::Secs, true)` which the
// provider uses to produce the canonical `timestamp` field.
function rfc3339Seconds(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
