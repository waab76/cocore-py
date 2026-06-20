import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  compareOsVersion,
  type SessionKey,
  sessionKeyMessage,
  verifyProviderForSeal,
} from "./verify-provider.ts";
import { verifyChainAgainst } from "./mda.ts";
import type { AttestationRecord } from "./types.ts";

// A P-256 signer that produces DER signatures (node:crypto default) and a raw
// 64-byte X‖Y base64 public key — the exact encoding attestation.publicKey
// uses, so the same key serves as the attestation signing key and the session
// signer.
function makeSigner(): { pubB64: string; signDerB64: (msg: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const pubB64 = Buffer.concat([x, y]).toString("base64");
  const signDerB64 = (msg: Uint8Array): string =>
    nodeSign("SHA256", Buffer.from(msg), privateKey).toString("base64");
  return { pubB64, signDerB64 };
}

const CDHASH = "a".repeat(40);
const NONCE = "f".repeat(32);
const ATT_CID = "bafyattestationcid";

// A fully confidential-eligible attestation EXCEPT it carries no MDA chain —
// the chain is supplied separately to verifyProviderForSeal. publicKey is the
// caller-supplied signer so session signatures verify.
function goodAttestation(pubB64: string): AttestationRecord {
  return {
    publicKey: pubB64,
    encryptionPubKey: "ZW5jcnlwdGlvbktleQ==",
    chipName: "Apple M3 Max",
    hardwareModel: "Mac15,8",
    serialNumberHash: "0".repeat(64),
    osVersion: "macOS 14.6.1",
    binaryHash: "1".repeat(64),
    cdHash: CDHASH,
    teamId: "TEAM123456",
    hardenedRuntime: true,
    libraryValidation: true,
    getTaskAllow: false,
    inProcessBackend: true,
    antiDebug: true,
    coreDumpsDisabled: true,
    envScrubbed: true,
    sipEnabled: true,
    secureBootEnabled: true,
    secureEnclaveAvailable: true,
    authenticatedRootEnabled: true,
    selfSignature: "c2ln",
    attestedAt: "2026-06-19T00:00:00Z",
    expiresAt: "2026-06-20T00:00:00Z",
  };
}

function freshSessionKey(signDerB64: (m: Uint8Array) => string): SessionKey {
  const base = { ephemeralPubKey: "ZXBoZW1lcmFsUHViS2V5", nonce: NONCE, attestationCid: ATT_CID };
  return { ...base, signature: signDerB64(sessionKeyMessage(base)) };
}

const NOW = () => new Date("2026-06-19T12:00:00Z");

function codes(findings: { code: string }[]): string[] {
  return findings.map((f) => f.code);
}

// ---- fail-closed core ------------------------------------------------------

test("a self-attested provider (no MDA chain) is best-effort, not confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.equal(r.tier, "best-effort");
  // Without requireConfidential, best-effort is acceptable (ok stays true).
  assert.equal(r.ok, true);
  assert.ok(codes(r.findings).includes("no-mda-chain"));
  // The confidential gaps are warnings, not errors, in downgrade mode.
  assert.ok(r.findings.every((f) => f.severity === "warn"));
  assert.equal(r.sealToKey, undefined);
});

test("requireConfidential fails closed when the chain is missing", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.equal(r.tier, "best-effort");
  assert.equal(r.ok, false); // fail closed — caller MUST NOT seal
  assert.ok(r.findings.some((f) => f.severity === "error" && f.code === "no-mda-chain"));
  assert.equal(r.sealToKey, undefined);
});

// ---- each posture gate blocks confidential ---------------------------------

const POSTURE_CASES: Array<[string, Partial<AttestationRecord>, string]> = [
  ["SIP off", { sipEnabled: false }, "sip-off"],
  ["Secure Boot off", { secureBootEnabled: false }, "secure-boot-off"],
  ["no hardened runtime", { hardenedRuntime: false }, "no-hardened-runtime"],
  ["no library validation", { libraryValidation: false }, "no-library-validation"],
  ["get-task-allow true", { getTaskAllow: true }, "get-task-allow"],
  ["get-task-allow absent (unsafe default)", { getTaskAllow: undefined }, "get-task-allow"],
  ["cdHash absent", { cdHash: undefined }, "no-cdhash"],
  ["subprocess backend", { inProcessBackend: false }, "not-in-process"],
  ["in-process absent (unsafe default)", { inProcessBackend: undefined }, "not-in-process"],
  ["anti-debug off", { antiDebug: false }, "no-anti-debug"],
  ["core dumps enabled", { coreDumpsDisabled: false }, "core-dumps-enabled"],
  ["env not scrubbed", { envScrubbed: false }, "env-not-scrubbed"],
];

for (const [name, patch, expectedCode] of POSTURE_CASES) {
  test(`posture gate: ${name} blocks confidential`, async () => {
    const { pubB64, signDerB64 } = makeSigner();
    const att = { ...goodAttestation(pubB64), ...patch };
    const r = await verifyProviderForSeal(att, undefined, {
      requireConfidential: true,
      knownGoodCdHashes: [CDHASH],
      nonce: NONCE,
      attestationCid: ATT_CID,
      sessionKey: freshSessionKey(signDerB64),
      now: NOW,
    });
    assert.equal(r.tier, "best-effort");
    assert.equal(r.ok, false);
    assert.ok(codes(r.findings).includes(expectedCode), `expected finding ${expectedCode}`);
  });
}

test("cdHash not in the known-good set blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: ["b".repeat(40)],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("cdhash-unknown"));
});

test("empty known-good set means no build can be trusted", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("no-known-good-set"));
});

test("osVersion below floor blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const att = { ...goodAttestation(pubB64), osVersion: "macOS 14.4.0" };
  const r = await verifyProviderForSeal(att, undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    osFloor: "14.6.0",
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("os-below-floor"));
});

test("expired attestation blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: () => new Date("2026-06-21T00:00:00Z"), // past expiresAt
  });
  assert.ok(codes(r.findings).includes("attestation-expired"));
});

// ---- session-key handshake -------------------------------------------------

test("a valid session signature produces no session findings", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(!codes(r.findings).some((c) => c.startsWith("session-")));
});

test("tampered session signature is rejected", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const sk = freshSessionKey(signDerB64);
  // Sign a DIFFERENT ephemeral key than the one presented → signature no
  // longer matches the message over the presented key.
  const forged: SessionKey = { ...sk, ephemeralPubKey: "dGFtcGVyZWRLZXk=" };
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: forged,
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("session-signature-invalid"));
  assert.equal(r.ok, false);
});

test("stale nonce (replayed session key) is rejected", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: "e".repeat(32), // caller's fresh nonce differs from the key's
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("session-nonce-mismatch"));
});

test("session key bound to a different attestation is rejected", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: "bafiSOMEOTHERcid",
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("session-attestation-mismatch"));
});

test("missing session key blocks confidential", async () => {
  const { pubB64 } = makeSigner();
  const r = await verifyProviderForSeal(goodAttestation(pubB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("no-session-key"));
});

// ---- osVersion comparator --------------------------------------------------

test("compareOsVersion handles prefixes and component counts", () => {
  assert.equal(compareOsVersion("macOS 14.6.1", "14.6.1"), 0);
  assert.ok(compareOsVersion("14.6.1", "14.6.0") > 0);
  assert.ok(compareOsVersion("14.5.9", "14.6.0") < 0);
  assert.ok(compareOsVersion("15.0", "14.9.9") > 0);
  assert.ok(compareOsVersion("14.6", "14.6.0") === 0);
  // A version with no numeric run sorts below any real floor.
  assert.ok(compareOsVersion("unknown", "14.0.0") < 0);
});

// ---- bound-MDA integration (uses the Rust cross-language fixture) -----------
//
// The fixture provides a chain + synthetic root + a random leaf key whose
// PRIVATE half we don't hold, so we can exercise the chain-verify + binding +
// posture + cdHash gates passing while the session signature (which we can't
// produce for that key) remains the single, final fail-closed gate. A full
// attested-confidential PASS requires the cross-language vector to also carry
// an enclave-signed session key (WS-EPHEMERAL) — added there.

const FIXTURE = join(new URL(".", import.meta.url).pathname, "..", "..", "..", "target", "mda-cross-lang-fixture.json");

test.skipIf(!existsSync(FIXTURE))(
  "bound MDA chain + posture pass; session signature is the final gate",
  async () => {
    const f = JSON.parse(readFileSync(FIXTURE, "utf-8")) as {
      rootDerB64: string;
      chainDerB64: string[];
    };
    const rootDer = Uint8Array.from(Buffer.from(f.rootDerB64, "base64"));
    const chainDer = f.chainDerB64.map((b) => Uint8Array.from(Buffer.from(b, "base64")));
    // Extract the leaf key the same way verify-provider will, and bind the
    // attestation to it so the chain verifies AND is bound.
    const mda = verifyChainAgainst(chainDer, rootDer, new Date());
    assert.ok(mda.valid && mda.leafPublicKey);

    const att = { ...goodAttestation(mda.leafPublicKey!), osVersion: "macOS 14.6.1" };
    // A session key signed by a DIFFERENT key (ours) — it will not verify
    // against the fixture's leaf key, so the session gate is the only blocker.
    const { signDerB64 } = makeSigner();
    const r = await verifyProviderForSeal(att, f.chainDerB64, {
      requireConfidential: true,
      knownGoodCdHashes: [CDHASH],
      trustAnchorDer: rootDer,
      nonce: NONCE,
      attestationCid: ATT_CID,
      sessionKey: freshSessionKey(signDerB64),
      now: () => new Date(), // fixture certs are valid "now"
    });
    const cs = codes(r.findings);
    assert.ok(!cs.includes("no-mda-chain") && !cs.includes("mda-invalid") && !cs.includes("mda-unbound"));
    assert.ok(!cs.includes("no-cdhash") && !cs.includes("cdhash-unknown"));
    assert.ok(!cs.some((c) => c.startsWith("sip") || c.startsWith("secure") || c.startsWith("no-")));
    assert.ok(cs.includes("session-signature-invalid"), "session sig should be the final gate");
  },
);
