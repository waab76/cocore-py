// Proof-backed trust-tier resolution for providers.
//
// A provider record's `trustLevel` and a machine's claimed tier are
// SELF-ASSERTED — anyone can write them to their own PDS. This module
// recomputes the tier from the ACTUAL attestation, so a badge or a routing
// decision can never be faked by editing a record:
//
//   * hardware-attested — proven OFFLINE: the SDK verifier checks the
//     provider's signed attestation carries an Apple-rooted MDA chain that
//     verifies AND binds to the signing key (leaf-key or freshness-code).
//     No known-good set or coordinator needed — pure Apple-CA crypto.
//   * attested-confidential — the above PLUS the advisor's MEASURED standing
//     (`confidentialEligible`: a known-good cdHash + the un-forgeable,
//     AMFI-gated APNs code-attestation). The code-attestation is the one leg
//     an operator can't forge; it's advisor-asserted by design (the
//     documented coordinator-trust carve-out — see sdk/verify-provider.ts).
//
// The offline crypto (Apple cert-chain verification) is cached by attestation
// CID: a machine's attestation only changes when it re-attests (~daily), so
// the hot path is a cache hit. The LIVE confidential bit (which can flip with
// code-attestation) is layered on per-call, never cached.

import { verifyProviderForSeal } from "@cocore/sdk/verify-provider";
import type { AttestationRecord } from "@cocore/sdk/types";

import { cocoreConfig } from "@/lib/cocore-config.ts";

export type VerifiedTier = "best-effort" | "hardware-attested" | "attested-confidential";

/** The floor a requester can demand. `hardware-attested` accepts EITHER
 *  verified tier (confidential is strictly stronger); `attested-confidential`
 *  is strict. */
export type TrustFloor = "hardware-attested" | "attested-confidential";

export function meetsFloor(tier: VerifiedTier, floor: TrustFloor): boolean {
  if (floor === "attested-confidential") return tier === "attested-confidential";
  return tier === "hardware-attested" || tier === "attested-confidential";
}

/** Map a requester-facing param value to a TrustFloor, or null if invalid.
 *  Accepts `hardware-attested` and `confidential`/`attested-confidential`. */
export function parseTrustFloor(v: unknown): TrustFloor | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (s === "hardware-attested" || s === "hardware") return "hardware-attested";
  if (s === "confidential" || s === "attested-confidential") return "attested-confidential";
  return null;
}

interface AdvisorRow {
  did: string;
  machineId?: string;
  supportedModels?: string[];
  attestationUri?: string | null;
  attestedAt?: string | null;
  confidentialEligible?: boolean;
  codeAttested?: boolean;
}

// Codes the SDK verifier emits when the OFFLINE hardware-attestation proof
// fails (self-signature, the Apple MDA chain, or its binding to the signing
// key). If NONE are present, genuine-Apple-hardware-bound-to-the-signing-key
// holds — i.e. at least hardware-attested.
export const HARDWARE_BLOCKER_CODES = new Set([
  "attestation-signature-invalid",
  "mda-invalid",
  "mda-unbound",
  "mda-no-binding-material",
  "no-hardware-attestation",
  "no-mda-chain",
]);

// offline proof (hardware-attested?) keyed by attestation CID — immutable.
const offlineTierCache = new Map<string, "hardware-attested" | "best-effort">();

function advisorBase(): string {
  return cocoreConfig().advisorUrl.replace(/\/$/, "");
}

/** Resolve a DID's PDS host (public, unauthenticated). */
async function resolvePds(did: string): Promise<string | null> {
  try {
    const r = await fetch(
      `https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc?identifier=${encodeURIComponent(did)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const mini = (await r.json()) as { pds?: string };
    return typeof mini.pds === "string" ? mini.pds.replace(/\/$/, "") : null;
  } catch {
    return null;
  }
}

/** Public getRecord of the provider's attestation. */
async function fetchAttestation(
  did: string,
  attestationUri: string,
): Promise<{ record: AttestationRecord; cid: string } | null> {
  const m = /^at:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(attestationUri);
  if (!m) return null;
  const collection = m[1]!;
  const rkey = m[2]!;
  const pds = await resolvePds(did);
  if (!pds) return null;
  try {
    const r = await fetch(
      `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}` +
        `&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`,
      { headers: { Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const body = (await r.json()) as { value?: unknown; cid?: unknown };
    if (!body.value || typeof body.cid !== "string") return null;
    return { record: body.value as AttestationRecord, cid: body.cid };
  } catch {
    return null;
  }
}

/** The offline half: does the signed attestation prove genuine Apple hardware
 *  bound to the signing key? Cached per attestation CID. */
async function offlineHardwareTier(
  did: string,
  attestationUri: string,
): Promise<"hardware-attested" | "best-effort"> {
  const fetched = await fetchAttestation(did, attestationUri);
  if (!fetched) return "best-effort";
  const cached = offlineTierCache.get(fetched.cid);
  if (cached) return cached;

  const record = fetched.record;
  const mdaChain = (record as { mdaCertChain?: string[] }).mdaCertChain;
  let hardwareOk = false;
  try {
    // requireConfidential:false → compute the tier without hard-failing; we
    // only read the findings to see if the hardware-attestation gates passed.
    const result = await verifyProviderForSeal(record, mdaChain, { requireConfidential: false });
    hardwareOk = !result.findings.some((f) => HARDWARE_BLOCKER_CODES.has(f.code));
  } catch {
    hardwareOk = false;
  }
  const tier = hardwareOk ? "hardware-attested" : "best-effort";
  offlineTierCache.set(fetched.cid, tier);
  return tier;
}

/** Recompute a machine's tier from its actual attestation (offline proof) +
 *  the advisor's live measured confidential standing. Never trusts the
 *  self-asserted trustLevel. */
export async function verifiedTierFor(row: AdvisorRow): Promise<VerifiedTier> {
  if (!row.attestationUri) return "best-effort";
  const offline = await offlineHardwareTier(row.did, row.attestationUri);
  if (offline === "best-effort") return "best-effort";
  // Genuine Apple hardware bound to the key. Confidential additionally needs
  // the advisor's measured + code-attested standing (the un-forgeable leg).
  return row.confidentialEligible === true ? "attested-confidential" : "hardware-attested";
}

/** Set of MACHINE keys (`${did}:${machineId}`) whose VERIFIED tier meets
 *  `floor` (optionally for a given model). This is the proof-backed allow-set
 *  the verified completions path routes against.
 *
 *  MUST be keyed per machine, not per owner DID. Tier is computed per row
 *  (each row carries its own `attestationUri` + advisor-measured
 *  `confidentialEligible`), but a DID can hold many machines: a genuinely
 *  attested Mac and an unattested Linux box under the SAME DID. A DID-scoped
 *  allow-set lets {@link filterByAllowedDids} widen from the attested machine
 *  to every sibling under that DID — so an `attested-confidential` request
 *  routes to the unattested node, which then reads the plaintext prompt and
 *  serves whatever model it likes. The composite `${did}:${machineId}` key is
 *  matched by {@link filterByAllowedDids} against the advisor row's
 *  `(did, machineId)`, exactly like the pro-bono path
 *  ({@link resolveProBonoProviderKeys}), so standing never leaks across an
 *  owner's machines.
 *
 *  Fail closed: a row that passes the tier check but carries no `machineId`
 *  can't be bound to a specific machine, so it is dropped rather than added as
 *  a bare DID (which would re-open the widening hole). */
export async function resolveVerifiedProviderKeys(
  floor: TrustFloor,
  model?: string,
): Promise<Set<string>> {
  const r = await fetch(`${advisorBase()}/providers`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`advisor /providers ${r.status}`);
  const rows = (await r.json()) as AdvisorRow[];
  const online = rows.filter((p) => p.attestedAt);
  const keys = new Set<string>();
  await Promise.all(
    online.map(async (row) => {
      if (
        model &&
        row.supportedModels &&
        row.supportedModels.length > 0 &&
        !row.supportedModels.includes(model)
      ) {
        return;
      }
      // Can't machine-bind a row with no machineId → fail closed (drop it)
      // rather than fall back to a DID-scoped key that would re-admit the
      // owner's unattested siblings.
      if (!row.machineId) return;
      const tier = await verifiedTierFor(row);
      if (meetsFloor(tier, floor)) keys.add(`${row.did}:${row.machineId}`);
    }),
  );
  return keys;
}
