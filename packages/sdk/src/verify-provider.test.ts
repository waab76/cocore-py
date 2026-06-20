import { test } from "vitest";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { canonicalize } from "./canonical.ts";
import {
  compareOsVersion,
  type SessionKey,
  sessionKeyMessage,
  verifyProviderForSeal,
} from "./verify-provider.ts";
import type { AttestationRecord } from "./types.ts";

// A P-256 signer that produces DER signatures (node:crypto default) and a raw
// 64-byte X‖Y base64 public key — the exact encoding attestation.publicKey
// uses, so the same key serves as the attestation signing key, the
// selfSignature signer, and the session signer.
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
const METALLIB = "c".repeat(64);
const NONCE = "f".repeat(32);
const ATT_CID = "bafyattestationcid";

// A confidential-eligible attestation EXCEPT it carries no MDA chain (supplied
// separately). publicKey is the caller's signer so selfSignature + session
// signatures verify.
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
    metallibHash: METALLIB,
    inProcessBackend: true,
    antiDebug: true,
    coreDumpsDisabled: true,
    envScrubbed: true,
    sipEnabled: true,
    secureBootEnabled: true,
    secureEnclaveAvailable: true,
    authenticatedRootEnabled: true,
    selfSignature: "",
    attestedAt: "2026-06-19T00:00:00Z",
    expiresAt: "2026-06-20T00:00:00Z",
  };
}

/** Sign an attestation's selfSignature over its canonical body (matching the
 *  Rust producer + the SDK's verifyAttestationSignature). Sign AFTER any patch
 *  so the signature honestly covers the (possibly insecure) posture — the
 *  attack model is a provider that validly signs a weak attestation. */
function signAtt(att: AttestationRecord, signDerB64: (m: Uint8Array) => string): AttestationRecord {
  const { selfSignature: _omit, ...rest } = att;
  // Drop undefined-valued keys so the canonical body matches the wire, where
  // absent optional fields are skip-serialized (never present as `undefined`).
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) body[k] = v;
  const sig = signDerB64(new TextEncoder().encode(canonicalize(body)));
  return { ...body, selfSignature: sig } as AttestationRecord;
}

/** Build + patch + sign an attestation in one go. */
function mkAtt(
  pubB64: string,
  signDerB64: (m: Uint8Array) => string,
  patch: Partial<AttestationRecord> = {},
): AttestationRecord {
  return signAtt({ ...goodAttestation(pubB64), ...patch }, signDerB64);
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
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.equal(r.tier, "best-effort");
  assert.equal(r.ok, true); // best-effort acceptable when not demanded
  assert.ok(codes(r.findings).includes("no-mda-chain"));
  assert.ok(r.findings.every((f) => f.severity === "warn"));
  assert.equal(r.sealToKey, undefined);
});

test("requireConfidential fails closed when the chain is missing", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.equal(r.tier, "best-effort");
  assert.equal(r.ok, false);
  assert.ok(r.findings.some((f) => f.severity === "error" && f.code === "no-mda-chain"));
  assert.equal(r.sealToKey, undefined);
});

// ---- the attestation self-signature is load-bearing ------------------------

test("a tampered attestation (invalid selfSignature) is rejected", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  // Sign a clean attestation, then flip a posture field WITHOUT re-signing —
  // exactly the forge-the-posture attack the selfSignature gate defends.
  const att = mkAtt(pubB64, signDerB64);
  const forged = { ...att, getTaskAllow: true };
  const r = await verifyProviderForSeal(forged, undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("attestation-signature-invalid"));
  assert.equal(r.ok, false);
});

test("an honestly-signed but INSECURE attestation still fails confidential", async () => {
  // The signature is valid (signed after the patch) but reports getTaskAllow.
  const { pubB64, signDerB64 } = makeSigner();
  const att = mkAtt(pubB64, signDerB64, { getTaskAllow: true });
  const r = await verifyProviderForSeal(att, undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    now: NOW,
  });
  // selfSignature is fine; the posture gate is what rejects it.
  assert.ok(!codes(r.findings).includes("attestation-signature-invalid"));
  assert.ok(codes(r.findings).includes("get-task-allow"));
  assert.equal(r.ok, false);
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
    const att = mkAtt(pubB64, signDerB64, patch);
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
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
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
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [],
    nonce: NONCE,
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("no-known-good-set"));
});

test("metallib hash not in the known-good set blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    knownGoodMetallibHashes: ["d".repeat(64)],
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("metallib-unknown"));
});

test("osVersion below floor blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const att = mkAtt(pubB64, signDerB64, { osVersion: "macOS 14.4.0" });
  const r = await verifyProviderForSeal(att, undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    osFloor: "14.6.0",
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("os-below-floor"));
});

test("expired attestation blocks confidential", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    now: () => new Date("2026-06-21T00:00:00Z"), // past expiresAt
  });
  assert.ok(codes(r.findings).includes("attestation-expired"));
});

// ---- session-key handshake (optional, advisor-trustless freshness) ---------

test("a valid session signature produces no session findings", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
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
  const forged: SessionKey = { ...sk, ephemeralPubKey: "dGFtcGVyZWRLZXk=" };
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
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
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: "e".repeat(32),
    attestationCid: ATT_CID,
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("session-nonce-mismatch"));
});

test("session key bound to a different attestation is rejected", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    knownGoodCdHashes: [CDHASH],
    nonce: NONCE,
    attestationCid: "bafiSOMEOTHERcid",
    sessionKey: freshSessionKey(signDerB64),
    now: NOW,
  });
  assert.ok(codes(r.findings).includes("session-attestation-mismatch"));
});

test("no session key is fine by default (seal to bound encryptionPubKey)", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const att = mkAtt(pubB64, signDerB64);
  const r = await verifyProviderForSeal(att, undefined, {
    knownGoodCdHashes: [CDHASH],
    now: NOW,
  });
  // No MDA chain so still best-effort, but the absence of a session key is NOT
  // itself a blocker in the default (advisor-vouched) mode.
  assert.ok(!codes(r.findings).includes("no-session-key"));
});

test("requireSessionKey demands a session key", async () => {
  const { pubB64, signDerB64 } = makeSigner();
  const r = await verifyProviderForSeal(mkAtt(pubB64, signDerB64), undefined, {
    requireConfidential: true,
    requireSessionKey: true,
    knownGoodCdHashes: [CDHASH],
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
  assert.ok(compareOsVersion("unknown", "14.0.0") < 0);
});

// ---- cross-language confidential PASS (Rust producer → TS verifier) ---------
//
// The definitive parity test: a fully-signed confidential attestation produced
// by the Rust fixture generator (one P-256 key as MDA leaf + attestation
// publicKey + selfSignature signer + session signer) must verify, end-to-end,
// as attested-confidential through every gate. Skipped if the fixture hasn't
// been generated (the Rust `cross_lang_fixture` test writes it).

const CONF_FIXTURE = join(
  new URL(".", import.meta.url).pathname,
  "..",
  "..",
  "..",
  "target",
  "confidential-attestation-fixture.json",
);

test.skipIf(!existsSync(CONF_FIXTURE))(
  "cross-language: a Rust confidential attestation verifies as attested-confidential",
  async () => {
    const f = JSON.parse(readFileSync(CONF_FIXTURE, "utf-8"));
    const rootDer = Uint8Array.from(Buffer.from(f.rootDerB64, "base64"));
    const att = f.attestation as AttestationRecord;
    const chain: string[] = att.mdaCertChain!;

    // (a) advisor-trustless mode: full chain + session key → seal to the
    // enclave-signed ephemeral key.
    const withKey = await verifyProviderForSeal(att, chain, {
      requireConfidential: true,
      requireSessionKey: true,
      knownGoodCdHashes: [f.knownGoodCdHash],
      knownGoodMetallibHashes: [f.knownGoodMetallibHash],
      osFloor: f.osFloor,
      trustAnchorDer: rootDer,
      attestationCid: f.attestationCid,
      nonce: f.nonce,
      sessionKey: f.sessionKey,
      now: () => new Date(),
    });
    assert.equal(
      withKey.tier,
      "attested-confidential",
      `unexpected findings: ${JSON.stringify(withKey.findings)}`,
    );
    assert.equal(withKey.ok, true);
    assert.equal(withKey.sealToKey, f.sessionKey.ephemeralPubKey);

    // (b) advisor-vouched mode: no session key → seal to the
    // selfSignature-authenticated long-lived encryptionPubKey.
    const noKey = await verifyProviderForSeal(att, chain, {
      requireConfidential: true,
      knownGoodCdHashes: [f.knownGoodCdHash],
      knownGoodMetallibHashes: [f.knownGoodMetallibHash],
      osFloor: f.osFloor,
      trustAnchorDer: rootDer,
      now: () => new Date(),
    });
    assert.equal(
      noKey.tier,
      "attested-confidential",
      `unexpected findings: ${JSON.stringify(noKey.findings)}`,
    );
    assert.equal(noKey.sealToKey, att.encryptionPubKey);

    // (c) tamper the signed posture → selfSignature gate catches it.
    const tampered = { ...att, getTaskAllow: true };
    const bad = await verifyProviderForSeal(tampered, chain, {
      requireConfidential: true,
      knownGoodCdHashes: [f.knownGoodCdHash],
      trustAnchorDer: rootDer,
      now: () => new Date(),
    });
    assert.ok(codes(bad.findings).includes("attestation-signature-invalid"));
    assert.equal(bad.ok, false);
  },
);
