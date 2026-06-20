// P-256 ECDSA verification using WebCrypto.
//
// Receipts and attestations carry their signatures DER-encoded
// (matches Apple CryptoKit's wire format on macOS, and what the
// `p256` Rust crate produces on other platforms). WebCrypto's
// SubtleCrypto.verify only accepts raw r||s (64 bytes), so we
// decode the DER ourselves before delegating.
//
// SubtleCrypto handles the SHA-256 pre-hash internally when we ask
// for `{ name: 'ECDSA', hash: 'SHA-256' }`, which matches the Rust
// `p256::ecdsa::Signer for SigningKey` default and Apple's
// `P256.Signing.PrivateKey.signature(for:)`.

import { canonicalize } from "./canonical.ts";

export class SignatureVerifyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "SignatureVerifyError";
  }
}

/** Verify a P-256 ECDSA signature over `message` with the given
 *  public key. Both inputs use base64 in transit; the message is
 *  raw bytes as produced by [`canonicalize`]. */
export async function verifyP256(
  publicKeyB64: string,
  signatureDerB64: string,
  message: Uint8Array,
): Promise<boolean> {
  const pubRaw = decodeBase64(publicKeyB64);
  if (pubRaw.byteLength !== 64) {
    throw new SignatureVerifyError(
      "bad-pubkey-length",
      `expected 64 raw P-256 bytes (X||Y), got ${pubRaw.byteLength}`,
    );
  }
  const sigDer = decodeBase64(signatureDerB64);
  const sigRaw = derToRawSignature(sigDer);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    prefixUncompressed(pubRaw),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, sigRaw, message);
}

/** Verify a receipt body's `enclaveSignature` against an attestation's
 *  `publicKey`. Strips the signature field, canonicalises everything
 *  else, and runs WebCrypto. Returns false if the math fails or any
 *  field is missing/malformed. */
export async function verifyReceiptSignature(
  receipt: { enclaveSignature?: string } & Record<string, unknown>,
  attestationPublicKeyB64: string,
): Promise<boolean> {
  const sig = receipt.enclaveSignature;
  if (!sig) return false;
  const { enclaveSignature: _omit, ...signed } = receipt;
  const message = new TextEncoder().encode(canonicalize(signed));
  try {
    return await verifyP256(attestationPublicKeyB64, sig, message);
  } catch (e) {
    if (e instanceof SignatureVerifyError) return false;
    throw e;
  }
}

/** Verify an attestation record's `selfSignature` against its own
 *  `publicKey`. This is what authenticates every posture field — `cdHash`,
 *  `getTaskAllow`, `hardenedRuntime`, `encryptionPubKey`, … — as having been
 *  signed by the enclave key, so a verifier MUST run this before trusting any
 *  of them. (The MDA binding only proves `publicKey` is the device's key; the
 *  session-key signature only covers the ephemeral key. Neither covers
 *  posture.) Strips `selfSignature` (and any `$type` lexicon framing),
 *  canonicalises the rest, and runs WebCrypto. */
export async function verifyAttestationSignature(
  attestation: { selfSignature?: string } & Record<string, unknown>,
  publicKeyB64: string,
): Promise<boolean> {
  const sig = attestation.selfSignature;
  if (!sig) return false;
  const { selfSignature: _omit, $type: _type, ...signed } = attestation as Record<string, unknown>;
  const message = new TextEncoder().encode(canonicalize(signed));
  try {
    return await verifyP256(publicKeyB64, sig, message);
  } catch (e) {
    if (e instanceof SignatureVerifyError) return false;
    throw e;
  }
}

// ---- internals -------------------------------------------------------

function decodeBase64(b64: string): Uint8Array {
  // Node 18+ exposes Buffer; we avoid relying on it so this module
  // also works in browsers and edge runtimes.
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function prefixUncompressed(raw64: Uint8Array): Uint8Array {
  const out = new Uint8Array(65);
  out[0] = 0x04;
  out.set(raw64, 1);
  return out;
}

/** Convert a DER-encoded ECDSA signature to the IEEE P-1363 raw
 *  format WebCrypto expects: r (32 bytes) || s (32 bytes), big-endian,
 *  zero-padded. */
export function derToRawSignature(der: Uint8Array): Uint8Array {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new SignatureVerifyError("bad-der", "not a DER SEQUENCE");
  }
  let pos = 2;
  // Length byte may be long-form for very long sigs, but a P-256
  // signature is always short-form.
  if ((der[1]! & 0x80) !== 0) {
    const lenBytes = der[1]! & 0x7f;
    pos = 2 + lenBytes;
  }
  const r = readDerInteger(der, pos);
  const s = readDerInteger(der, r.next);
  const out = new Uint8Array(64);
  out.set(padTo32(r.bytes), 0);
  out.set(padTo32(s.bytes), 32);
  return out;
}

function readDerInteger(der: Uint8Array, pos: number): { bytes: Uint8Array; next: number } {
  if (der[pos] !== 0x02) {
    throw new SignatureVerifyError("bad-der", `expected INTEGER at ${pos}`);
  }
  const len = der[pos + 1]!;
  let start = pos + 2;
  let actualLen = len;
  // Strip a single leading 0x00 padding byte added when the
  // high-order bit of the value would otherwise make it negative.
  if (actualLen > 32 && der[start] === 0x00) {
    start++;
    actualLen--;
  }
  if (actualLen > 32) {
    throw new SignatureVerifyError("bad-der", `INTEGER too long (${actualLen}) for P-256`);
  }
  return { bytes: der.slice(start, start + actualLen), next: start + actualLen };
}

function padTo32(b: Uint8Array): Uint8Array {
  if (b.length === 32) return b;
  if (b.length > 32) {
    throw new SignatureVerifyError("bad-der", "INTEGER > 32 bytes");
  }
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
}
