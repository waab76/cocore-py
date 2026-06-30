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

import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform";
import { makeRuntime } from "@cocore/o11y";
import { Effect } from "effect";

import type { PublishedRecord } from "./publisher.ts";
import type { FeePolicy, SelfLoopRule } from "./exchange.ts";
import { type PrivateJwk, publicKeyFingerprint } from "./signing.ts";

// One o11y runtime for the module — provides the tracing layer that
// `Effect.withSpan` reports through. The fetch-backed HttpClient is
// supplied per-call via `Effect.provide(FetchHttpClient.layer)`;
// `FetchHttpClient.layer` reads `globalThis.fetch` at request time, so
// test fetch-mocking keeps working unchanged.
const runtime = makeRuntime({ serviceName: "cocore-exchange" });

export interface BootstrapInputs {
  exchangeDid: string;
  /** Console base + bearer key for the default console-proxy write path.
   *  Optional when `writeRecord` is supplied (the app-password path writes
   *  directly to the PDS and needs neither). */
  apiBase?: string;
  apiKey?: string;
  /** Record-write seam. When provided, policy + attestation are written via
   *  this (the app-password direct-to-PDS path); otherwise they go through the
   *  console proxy using apiBase/apiKey. Lets the bootstrap share the exact
   *  same lapse-proof write path the settlement transport uses. */
  writeRecord?: (collection: string, record: Record<string, unknown>) => Promise<PublishedRecord>;
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
  const effect = Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.post(
      `${apiBase.replace(/\/$/, "")}/api/pds/createRecord`,
    ).pipe(
      HttpClientRequest.setHeaders({
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      }),
      HttpClientRequest.bodyJson({ collection, record }),
    );
    const res = yield* client.execute(request);
    if (res.status < 200 || res.status >= 300) {
      const body = yield* res.text.pipe(Effect.orElseSucceed(() => ""));
      return yield* Effect.fail(
        new Error(`proxy create ${collection} returned ${res.status}: ${body.slice(0, 300)}`),
      );
    }
    return (yield* res.json) as PublishedRecord;
  }).pipe(
    // Map any non-Error failure (HttpBodyError / transport / decode) into a
    // thrown Error so the external Promise rejects with an Error, matching
    // the old `await fetch(...)` boundary.
    Effect.catchAll((e) => Effect.fail(e instanceof Error ? e : new Error(String(e)))),
    Effect.withSpan("exchange.bootstrap.proxyCreate", { attributes: { collection } }),
    Effect.provide(FetchHttpClient.layer),
  );
  return runtime.runPromise(effect);
}

export async function bootstrapExchangeRecords(inputs: BootstrapInputs): Promise<BootstrapResult> {
  const createdAt = new Date().toISOString();

  // Prefer the injected writer (app-password direct-to-PDS); fall back to the
  // console proxy. Either way the two bootstrap records go out the same path
  // the settlement transport uses, so they can't diverge in auth health.
  const write = (collection: string, record: Record<string, unknown>): Promise<PublishedRecord> => {
    if (inputs.writeRecord) return inputs.writeRecord(collection, record);
    if (!inputs.apiBase || !inputs.apiKey) {
      return Promise.reject(
        new Error(
          "bootstrap: no writeRecord and missing apiBase/apiKey for console-proxy fallback",
        ),
      );
    }
    return proxyCreate(inputs.apiBase, inputs.apiKey, collection, record);
  };

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
  const policyRef = await write("dev.cocore.compute.exchangePolicy", policyRecord);

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
  const attestationRef = await write("dev.cocore.compute.exchangeAttestation", attestationRecord);

  return { policyRef, attestationRef };
}
