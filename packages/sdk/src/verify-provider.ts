// Requester-side, fail-closed provider verification — run BEFORE sealing a
// prompt to a provider.
//
// This is the load-bearing client-edge check for the `attested-confidential`
// tier (see lexicons/dev/cocore/compute/defs.json#tier). The AppView's
// server-side dispatch seal is always `best-effort` because a service we run
// is in the plaintext path; genuine privacy-from-the-provider requires the
// requester (SDK/browser/`sdk/py`) to verify the provider's attestation and
// the per-job ephemeral session key here, and to seal to that ephemeral key
// only when every gate passes.
//
// It composes existing primitives rather than re-implementing them:
//   * `verifyChain` (mda.ts)  — Apple-rooted MDA chain + CA constraints,
//                               and returns the leaf P-256 key for binding.
//   * `verifyP256` (p256.ts)  — ES256 over the enclave-signed session key.
//   * `Finding`/`ValidationReport` (validate.ts) — the structured result shape.
//
// The contract: returns `attested-confidential` ONLY when ALL of —
//   1. an MDA chain that verifies to the Apple Enterprise Attestation Root, and
//   2. is BOUND (leaf P-256 key === attestation.publicKey), and
//   3. a measured `cdHash` that is in the caller's known-good set, and
//   4. the hardened posture: sip && hardenedRuntime && libraryValidation &&
//      !getTaskAllow && secureBoot (with MDA-reported sip/secureBoot, when the
//      chain carries them, required to agree), and
//   5. osVersion >= the caller's floor, and
//   6. the attestation is unexpired, and
//   7. a fresh, enclave-signed SessionKey bound to the caller's nonce and to
//      this attestation's CID
// — hold. Anything weaker is `best-effort`. When the caller set
// `requireConfidential`, any unmet confidential gate makes `ok === false`
// (fail closed: the caller MUST NOT seal); otherwise the same gaps are
// recorded as warnings and `ok` stays true at the best-effort tier.

import { canonicalBytes } from "./canonical.ts";
import { type MdaResult, verifyChain, verifyChainAgainst } from "./mda.ts";
import { verifyAttestationSignature, verifyP256, SignatureVerifyError } from "./p256.ts";
import type { AttestationRecord, Tier } from "./types.ts";
import type { Finding, Severity, ValidationReport } from "./validate.ts";

/** The enclave-signed, per-job ephemeral key a confidential requester seals
 *  to. Minted fresh inside the measured engine for each request, signed by the
 *  attestation's P-256 key over a canonical `{attestationCid, ephemeralPubKey,
 *  nonce}` so the requester can prove the key was produced for THIS request
 *  (nonce) by the attested enclave (attestationCid + signature). */
export interface SessionKey {
  /** base64 X25519 public key the requester seals the input to. */
  ephemeralPubKey: string;
  /** lowercase-hex echo of the requester's fresh nonce. */
  nonce: string;
  /** CID of the attestation record this session is bound to. */
  attestationCid: string;
  /** DER ECDSA P-256 signature (base64) over the canonical bytes of
   *  `{attestationCid, ephemeralPubKey, nonce}`, verified against
   *  `attestation.publicKey`. */
  signature: string;
}

export interface VerifyProviderOptions {
  /** Hard-fail when the confidential tier cannot be proven, instead of
   *  silently downgrading to best-effort. Set this whenever the caller needs
   *  privacy from the provider. */
  requireConfidential?: boolean;
  /** Code-signing cdhashes (lowercase hex) the caller trusts — the output of
   *  the transparency log / reproducible-build set. Required for confidential;
   *  an empty/absent set means no build can earn `attested-confidential`. */
  knownGoodCdHashes?: Iterable<string>;
  /** SHA-256 hex of metallibs the caller trusts (the GPU kernels that touch
   *  plaintext). When provided, an in-process provider's `metallibHash` must be
   *  in this set. Empty/absent skips the metallib pin (cdHash already pins the
   *  binary that loads it). */
  knownGoodMetallibHashes?: Iterable<string>;
  /** Minimum acceptable macOS version, e.g. "14.6.1" or "macOS 14.6.1".
   *  Providers below the floor cannot earn confidential. */
  osFloor?: string;
  /** CID of the attestation record the caller fetched — the SessionKey MUST
   *  name this CID so a key signed for a different attestation can't be
   *  replayed. */
  attestationCid?: string;
  /** The fresh nonce the caller generated for this request and sent to the
   *  provider. The SessionKey MUST echo it. */
  nonce?: string;
  /** The enclave-signed ephemeral key returned for this request (optional;
   *  the stronger advisor-trustless freshness mode). */
  sessionKey?: SessionKey;
  /** Require a per-request enclave-signed `SessionKey` (advisor-trustless
   *  freshness). Default false: liveness is vouched by the advisor's standing
   *  5-min challenge-response and the attestation's own expiry window. */
  requireSessionKey?: boolean;
  /** Clock seam for tests. */
  now?: () => Date;
  /** ADVANCED / TEST ONLY. Verify the MDA chain against this DER trust anchor
   *  instead of the embedded Apple Enterprise Attestation Root. Production
   *  callers MUST leave this unset so the chain is rooted in Apple's CA; the
   *  cross-language fixture sets it to a synthetic root. Mirrors mda.ts's
   *  `verifyChainAgainst`. */
  trustAnchorDer?: Uint8Array;
}

export interface ProviderVerifyResult extends ValidationReport {
  /** The tier the caller may rely on. Recomputed from evidence; never the
   *  provider's self-asserted value. */
  tier: Tier;
  /** When `tier === "attested-confidential"`, the base64 X25519 key the caller
   *  MUST seal to (the verified ephemeral key). Undefined otherwise — a
   *  best-effort caller seals to the provider record's `encryptionPubKey`. */
  sealToKey?: string;
}

/** The canonical message an enclave signs for a SessionKey. Pinned by a
 *  cross-language vector (Rust signs, this verifies) so the producer and this
 *  verifier never drift. */
export function sessionKeyMessage(sk: {
  attestationCid: string;
  ephemeralPubKey: string;
  nonce: string;
}): Uint8Array {
  return canonicalBytes({
    attestationCid: sk.attestationCid,
    ephemeralPubKey: sk.ephemeralPubKey,
    nonce: sk.nonce,
  });
}

/**
 * Verify a provider is safe to seal a prompt to, and at what tier.
 *
 * @param attestation the provider's current attestation record (already
 *   fetched from its PDS and shape-validated).
 * @param mdaChain the DER MDA chain (base64 strings, leaf first) — usually
 *   `attestation.mdaCertChain`. Pass `undefined`/empty for a self-attested
 *   provider.
 * @param opts caller policy + the per-job session handshake material.
 */
export async function verifyProviderForSeal(
  attestation: AttestationRecord,
  mdaChain: string[] | undefined,
  opts: VerifyProviderOptions = {},
): Promise<ProviderVerifyResult> {
  const requireConfidential = opts.requireConfidential ?? false;
  const now = opts.now ? opts.now() : new Date();
  const knownGood = new Set<string>(
    [...(opts.knownGoodCdHashes ?? [])].map((h) => h.toLowerCase()),
  );
  const knownGoodMetallibs = new Set<string>(
    [...(opts.knownGoodMetallibHashes ?? [])].map((h) => h.toLowerCase()),
  );

  // Confidential blockers are collected here. If empty at the end, the
  // provider earns `attested-confidential`; otherwise each blocker is surfaced
  // as an error (when confidential was required) or a warning (downgrade).
  const blockers: Array<{ code: string; message: string }> = [];
  const block = (code: string, message: string): void => {
    blockers.push({ code, message });
  };

  // --- 0. The attestation must be self-signed by its own publicKey. ---
  // This authenticates every posture field below (cdHash, getTaskAllow,
  // encryptionPubKey, …). Without it those are unsigned claims: the MDA
  // binding only proves `publicKey` is the device key and the session-key
  // signature only covers the ephemeral key — neither covers posture. Run it
  // first; a forged/tampered attestation fails here before anything else.
  {
    let selfOk = false;
    try {
      selfOk = await verifyAttestationSignature(
        attestation as unknown as { selfSignature?: string } & Record<string, unknown>,
        attestation.publicKey,
      );
    } catch (e) {
      if (!(e instanceof SignatureVerifyError)) throw e;
      selfOk = false;
    }
    if (!selfOk) {
      block(
        "attestation-signature-invalid",
        "attestation.selfSignature did not verify against attestation.publicKey — posture fields are unauthenticated",
      );
    }
  }

  // --- 1+2. MDA chain present, verifies, and is bound to the signing key. ---
  let mda: MdaResult | undefined;
  if (!mdaChain || mdaChain.length === 0) {
    block("no-mda-chain", "attestation carries no MDA certificate chain");
  } else {
    try {
      const chainDer = mdaChain.map((b64) => base64ToBytes(b64));
      mda = opts.trustAnchorDer
        ? verifyChainAgainst(chainDer, opts.trustAnchorDer, now)
        : verifyChain(chainDer);
    } catch (e) {
      block("mda-invalid", `MDA chain did not verify: ${(e as Error).message}`);
    }
    if (mda) {
      if (!mda.valid) {
        block("mda-invalid", "MDA chain did not verify");
      }
      if (!mda.leafPublicKey) {
        block("mda-no-leaf-key", "MDA leaf has no extractable P-256 key to bind");
      } else if (mda.leafPublicKey !== attestation.publicKey) {
        block(
          "mda-unbound",
          "MDA leaf public key does not equal attestation.publicKey (chain not bound to the signing key)",
        );
      }
    }
  }

  // --- 3. Measured cdHash is in the known-good set. ---
  if (!attestation.cdHash) {
    block("no-cdhash", "attestation has no measured cdHash");
  } else if (knownGood.size === 0) {
    block("no-known-good-set", "no known-good cdHash set supplied; cannot trust any build");
  } else if (!knownGood.has(attestation.cdHash.toLowerCase())) {
    block("cdhash-unknown", `cdHash ${attestation.cdHash} is not in the known-good set`);
  }

  // Metallib pin (the GPU kernels touching plaintext), when the caller supplies
  // a known-good metallib set.
  if (knownGoodMetallibs.size > 0) {
    if (!attestation.metallibHash) {
      block("no-metallib-hash", "attestation has no measured metallibHash");
    } else if (!knownGoodMetallibs.has(attestation.metallibHash.toLowerCase())) {
      block("metallib-unknown", `metallibHash ${attestation.metallibHash} is not in the known-good set`);
    }
  }

  // --- 4. Hardened-runtime posture. getTaskAllow absent ⇒ unsafe default. ---
  if (attestation.sipEnabled !== true) block("sip-off", "SIP is not enabled");
  if (attestation.secureBootEnabled !== true) {
    block("secure-boot-off", "Secure Boot is not enabled");
  }
  if (attestation.hardenedRuntime !== true) {
    block("no-hardened-runtime", "binary is not running under the hardened runtime");
  }
  if (attestation.libraryValidation !== true) {
    block("no-library-validation", "library validation is not enforced");
  }
  if (attestation.getTaskAllow !== false) {
    block(
      "get-task-allow",
      "get-task-allow is not provably false (debugger/memory-read is possible)",
    );
  }
  // The load-bearing property: the prompt must be handled inside the measured
  // binary, not an owner-controlled subprocess. Without this, nothing else
  // about the binary's posture matters.
  if (attestation.inProcessBackend !== true) {
    block(
      "not-in-process",
      "inference does not run in-process in the measured binary (subprocess backend)",
    );
  }
  // darkbloom-parity startup hardening capabilities.
  if (attestation.antiDebug !== true) block("no-anti-debug", "PT_DENY_ATTACH not applied");
  if (attestation.coreDumpsDisabled !== true) {
    block("core-dumps-enabled", "core dumps not disabled (RLIMIT_CORE!=0)");
  }
  if (attestation.envScrubbed !== true) block("env-not-scrubbed", "DYLD_* env not scrubbed");
  // The MDA chain, when present, is the stronger source for SIP/Secure Boot;
  // a self-reported posture that contradicts the signed chain is rejected.
  if (mda?.sipEnabled === false) block("mda-sip-off", "MDA chain reports SIP disabled");
  if (mda?.secureBootEnabled === false) {
    block("mda-secure-boot-off", "MDA chain reports Secure Boot disabled");
  }

  // --- 5. OS version floor. ---
  if (opts.osFloor && compareOsVersion(attestation.osVersion, opts.osFloor) < 0) {
    block(
      "os-below-floor",
      `osVersion ${attestation.osVersion} is below the floor ${opts.osFloor}`,
    );
  }

  // --- 6. Attestation freshness. ---
  const t = now.getTime();
  if (t < Date.parse(attestation.attestedAt) || t > Date.parse(attestation.expiresAt)) {
    block("attestation-expired", "attestation is outside its [attestedAt, expiresAt] window");
  }

  // --- 7. Freshness + the key to seal to. ---
  // The confidential seal target is the attestation's `encryptionPubKey`,
  // which the selfSignature gate (#0) just authenticated as enclave-bound.
  // Forward secrecy comes from the requester's per-request ephemeral SENDER
  // key (see `sealToProvider`). Liveness has two modes:
  //   * Advisor-vouched (default): rely on the advisor's standing 5-min
  //     challenge-response — it only advertises providers it has freshly
  //     challenged — plus the attestation's own [attestedAt, expiresAt].
  //   * Advisor-trustless (opt `requireSessionKey`): demand a per-request
  //     enclave-signed `SessionKey` over the requester's nonce, so the
  //     requester proves liveness itself without trusting the advisor.
  // When a SessionKey is supplied it is always verified, and (being
  // enclave-signed) its `ephemeralPubKey` becomes the seal target.
  const sk = opts.sessionKey;
  if (sk) {
    if (!opts.nonce || sk.nonce !== opts.nonce) {
      block("session-nonce-mismatch", "session key nonce does not match the request nonce");
    }
    if (!opts.attestationCid || sk.attestationCid !== opts.attestationCid) {
      block(
        "session-attestation-mismatch",
        "session key is not bound to the supplied attestation CID",
      );
    }
    let sigOk = false;
    try {
      sigOk = await verifyP256(attestation.publicKey, sk.signature, sessionKeyMessage(sk));
    } catch (e) {
      if (!(e instanceof SignatureVerifyError)) throw e;
      sigOk = false;
    }
    if (!sigOk) {
      block("session-signature-invalid", "session key signature did not verify against attestation.publicKey");
    }
  } else if (opts.requireSessionKey) {
    block(
      "no-session-key",
      "advisor-trustless freshness was required but no enclave-signed session key was supplied",
    );
  } else if (!attestation.encryptionPubKey) {
    block("no-encryption-key", "attestation has no encryptionPubKey to seal to");
  }

  // --- Resolve tier + findings. ---
  const confidential = blockers.length === 0;
  const tier: Tier = confidential ? "attested-confidential" : "best-effort";
  const severity: Severity = requireConfidential ? "error" : "warn";
  const findings: Finding[] = blockers.map((b) => ({ severity, code: b.code, message: b.message }));

  const result: ProviderVerifyResult = {
    tier,
    ok: confidential || !requireConfidential,
    findings,
  };
  // Seal to the enclave-signed ephemeral key when present, else the
  // selfSignature-authenticated long-lived encryptionPubKey.
  if (confidential) result.sealToKey = sk ? sk.ephemeralPubKey : attestation.encryptionPubKey;
  return result;
}

// ---- internals -------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Compare two macOS version strings. Extracts the first dotted-numeric run
 *  from each (so "macOS 14.6.1" and "14.6.1" compare equal) and compares
 *  component-wise. Returns <0, 0, or >0. A string with no numeric run sorts
 *  lowest (treated as below any real floor) so it fails the floor check. */
export function compareOsVersion(a: string, b: string): number {
  const pa = extractVersion(a);
  const pb = extractVersion(b);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function extractVersion(s: string): number[] {
  const m = s.match(/\d+(?:\.\d+)*/);
  if (!m) return [-1];
  return m[0].split(".").map((p) => Number.parseInt(p, 10));
}
