// Bootstrap publishing for the cocore-hosted exchange.
//
// On startup the services container calls bootstrapExchangeRecords
// which:
//   1. Builds an ExchangePolicyRecord from env config and publishes
//      it to the exchange's repo via the console proxy.
//   2. Builds an ExchangeAttestationRecord that strong-refs the
//      policy + names the signing-key fingerprint, and publishes
//      that too.
//   3. Returns both StrongRefs so Exchange wires them into every
//      subsequent settlement.
//
// Each restart creates new records (createRecord auto-generates an
// rkey). Acceptable for v1 — settlements pin the policy/attestation
// at the time of charge, so refreshing the records doesn't
// invalidate prior settlements. Future enhancement: putRecord with
// a stable rkey so we keep a single canonical pair per process.

import type { PublishedRecord } from "./publisher.ts";
import type { FeePolicy, SelfLoopRule } from "./exchange.ts";
import { type PrivateJwk, publicKeyFingerprint } from "./signing.ts";

export interface BootstrapInputs {
  exchangeDid: string;
  apiBase: string;
  apiKey: string;
  feePolicy: FeePolicy;
  feeCurrency: string;
  supportedCurrencies: string[];
  selfLoop: SelfLoopRule;
  processor?: string;
  termsUri?: string;
  /** Bumping this triggers re-acceptance prompts in clients. */
  termsVersion?: string;
  softwareVersion: string;
  signingKey?: PrivateJwk;
  auditPosture?: string;
  /** Optional uniform per-token rate the exchange asserts. Mirrors
   *  `dev.cocore.compute.defs#tokenRate`. When set, this is the
   *  canonical rate for any provider settling through this exchange
   *  (until the lexicon adds a per-receipt provider override). */
  tokenRate?: {
    inputPricePerMTok: number;
    outputPricePerMTok: number;
    currency: string;
  };
  /** Initial token grant on first interaction. */
  tokenGrant?: number;
  /** Minimum post-dispatch balance required for the exchange to
   *  admit a new job. */
  tokenFloor?: number;
  /** Explicit treasury DID (defaults to `exchangeDid`). */
  treasuryDid?: string;
  /** Lazy weekly refresh: `amountPerDid` tokens every
   *  `cadenceMinutes` minutes, triggered by any balance touch. */
  weeklyRefresh?: { amountPerDid: number; cadenceMinutes: number };
  /** Periodic patronage rebate from the treasury. */
  patronageDistribution?: { fractionBps: number; cadenceDays: number };
}

export interface BootstrapResult {
  policyRef: PublishedRecord;
  attestationRef: PublishedRecord;
}

/** Publish a record via the console proxy. Bearer-key auth resolves
 *  to the exchange DID; the console writes to that DID's PDS using
 *  its DPoP-aware OAuth session. */
async function proxyCreate(
  apiBase: string,
  apiKey: string,
  collection: string,
  record: Record<string, unknown>,
): Promise<PublishedRecord> {
  const r = await fetch(`${apiBase.replace(/\/$/, "")}/api/pds/createRecord`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ collection, record }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`proxy create ${collection} returned ${r.status}: ${body.slice(0, 300)}`);
  }
  return (await r.json()) as PublishedRecord;
}

export async function bootstrapExchangeRecords(inputs: BootstrapInputs): Promise<BootstrapResult> {
  const createdAt = new Date().toISOString();

  // 1. Policy record.
  const policyRecord: Record<string, unknown> = {
    exchange: inputs.exchangeDid,
    fee: {
      bps: inputs.feePolicy.bps,
      minMinor: inputs.feePolicy.minMinor,
      currency: inputs.feeCurrency,
    },
    ...(inputs.tokenRate
      ? {
          tokenRate: {
            inputPricePerMTok: inputs.tokenRate.inputPricePerMTok,
            outputPricePerMTok: inputs.tokenRate.outputPricePerMTok,
            currency: inputs.tokenRate.currency,
          },
        }
      : {}),
    ...(inputs.tokenGrant !== undefined ? { tokenGrant: inputs.tokenGrant } : {}),
    ...(inputs.tokenFloor !== undefined ? { tokenFloor: inputs.tokenFloor } : {}),
    ...(inputs.treasuryDid ? { treasuryDid: inputs.treasuryDid } : {}),
    ...(inputs.weeklyRefresh ? { weeklyRefresh: inputs.weeklyRefresh } : {}),
    ...(inputs.patronageDistribution
      ? { patronageDistribution: inputs.patronageDistribution }
      : {}),
    supportedCurrencies: inputs.supportedCurrencies,
    selfLoop: {
      feeWaived: inputs.selfLoop.feeWaived,
      ...(inputs.selfLoop.minMinor !== undefined ? { minMinor: inputs.selfLoop.minMinor } : {}),
    },
    ...(inputs.processor ? { processor: inputs.processor } : {}),
    ...(inputs.termsUri ? { termsUri: inputs.termsUri } : {}),
    ...(inputs.termsVersion ? { termsVersion: inputs.termsVersion } : {}),
    active: true,
    createdAt,
  };
  const policyRef = await proxyCreate(
    inputs.apiBase,
    inputs.apiKey,
    "dev.cocore.compute.exchangePolicy",
    policyRecord,
  );

  // 2. Attestation record (strong-refs the policy).
  const fingerprint = inputs.signingKey
    ? await publicKeyFingerprint(inputs.signingKey)
    : "unsigned";
  const attestationRecord: Record<string, unknown> = {
    exchange: inputs.exchangeDid,
    policy: { uri: policyRef.uri, cid: policyRef.cid },
    softwareVersion: inputs.softwareVersion,
    signingKeyFingerprint: fingerprint,
    ...(inputs.auditPosture ? { auditPosture: inputs.auditPosture } : {}),
    createdAt: new Date().toISOString(),
  };
  const attestationRef = await proxyCreate(
    inputs.apiBase,
    inputs.apiKey,
    "dev.cocore.compute.exchangeAttestation",
    attestationRecord,
  );

  return { policyRef, attestationRef };
}
