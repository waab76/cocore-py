// Settlement record builder + PDS write seam.
//
// Two backends:
//
//   * `MemorySettlementTransport` (default) keeps the published
//     records in-process. Used by unit tests and the dev bridge —
//     no network needed.
//   * `PdsSettlementTransport` (NEW) calls
//     `com.atproto.repo.createRecord` against a live PDS using the
//     exchange operator's session token. This is what lights the
//     stack up against `@atproto/dev-env`'s TestPDS or a real
//     bsky.network instance.
//
// The class signature is unchanged for callers that already use
// `new SettlementPublisher(did)`; the transport is an optional
// constructor argument.

import type { Money, SettlementRecord, StrongRef } from "@cocore/sdk/types";

export interface PublishedRecord {
  uri: string;
  cid: string;
}

export interface SettlementInputs {
  receipt: StrongRef;
  requesterAuthorization: StrongRef;
  amountCharged: Money;
  providerPayout: Money;
  exchangeFee: Money;
  processorReference: string;
  status: SettlementRecord["status"];
  refundOf?: StrongRef;
  policy?: StrongRef;
  exchangeAttestation?: StrongRef;
}

/** Pluggable transport for writing settlement records. */
export interface SettlementTransport {
  publish(exchangeDid: string, record: SettlementRecord): Promise<PublishedRecord>;
}

/** In-process transport. Default. */
class MemorySettlementTransport implements SettlementTransport {
  async publish(exchangeDid: string, _record: SettlementRecord): Promise<PublishedRecord> {
    const rkey = randomTid();
    return {
      uri: `at://${exchangeDid}/dev.cocore.compute.settlement/${rkey}`,
      cid: `bafyreigh2akiscaildc5sgz5wybizysiehxiv4dhpwwqouytxnvgkpkcaq-mem-${rkey}`,
    };
  }
}

/** Live-PDS transport. POSTs com.atproto.repo.createRecord via
 *  plain Bearer auth (suitable for dev-env's TestPDS and any PDS
 *  that accepts legacy tokens). DPoP-bound tokens are not yet
 *  supported; we'll add that path when the cocore-shell Swift app's
 *  OAuth session blob carries DPoP material end-to-end. */
export class PdsSettlementTransport implements SettlementTransport {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor(opts: { pdsEndpoint: string; accessToken: string }) {
    this.endpoint = opts.pdsEndpoint.replace(/\/$/, "");
    this.accessToken = opts.accessToken;
  }

  async publish(exchangeDid: string, record: SettlementRecord): Promise<PublishedRecord> {
    const res = await fetch(`${this.endpoint}/xrpc/com.atproto.repo.createRecord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        repo: exchangeDid,
        collection: "dev.cocore.compute.settlement",
        record,
      }),
    });
    if (!res.ok) {
      throw new Error(`createRecord settlement returned ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { uri: string; cid: string };
    return body;
  }
}

/** Production transport for the cocore-hosted exchange.
 *
 *  POSTs records to the cocore console's proxy endpoint
 *  (`/api/pds/createRecord`) using a Bearer API
 *  key bound to the exchange's DID. The console handles DPoP
 *  signing internally using the OAuth session for that DID — same
 *  surface the provider agent uses for its own records. The
 *  exchange therefore never needs to hold OAuth tokens directly.
 *
 *  Configuration ships through env on the services container:
 *    COCORE_EXCHANGE_API_KEY  cocore-... key minted on /api-keys
 *                             while signed in as the exchange's DID.
 *    COCORE_EXCHANGE_API_BASE console base URL (default
 *                             https://console.cocore.dev).
 */
export class ConsoleProxySettlementTransport implements SettlementTransport {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(opts: { apiBase: string; apiKey: string }) {
    this.base = opts.apiBase.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
  }

  async publish(_exchangeDid: string, record: SettlementRecord): Promise<PublishedRecord> {
    // The proxy resolves the API key → DID and writes to that DID's
    // PDS, so we don't need to send `repo` separately.
    const res = await fetch(`${this.base}/api/pds/createRecord`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        collection: "dev.cocore.compute.settlement",
        record,
      }),
    });
    if (!res.ok) {
      throw new Error(`proxy settlement createRecord ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as { uri: string; cid: string };
    return body;
  }
}

export class SettlementPublisher {
  private readonly exchangeDid: string;
  private readonly transport: SettlementTransport;
  private readonly published: Map<string, PublishedRecord> = new Map();

  constructor(
    exchangeDid: string,
    transport: SettlementTransport = new MemorySettlementTransport(),
  ) {
    this.exchangeDid = exchangeDid;
    this.transport = transport;
  }

  exchange(): string {
    return this.exchangeDid;
  }

  build(inputs: SettlementInputs): SettlementRecord {
    return {
      receipt: inputs.receipt,
      requesterAuthorization: inputs.requesterAuthorization,
      amountCharged: inputs.amountCharged,
      providerPayout: inputs.providerPayout,
      exchangeFee: inputs.exchangeFee,
      processorReference: inputs.processorReference,
      status: inputs.status,
      ...(inputs.refundOf ? { refundOf: inputs.refundOf } : {}),
      ...(inputs.policy ? { policy: inputs.policy } : {}),
      ...(inputs.exchangeAttestation ? { exchangeAttestation: inputs.exchangeAttestation } : {}),
      settledAt: new Date().toISOString(),
    };
  }

  async publish(rec: SettlementRecord): Promise<PublishedRecord> {
    const result = await this.transport.publish(this.exchangeDid, rec);
    this.published.set(rec.receipt.uri, result);
    return result;
  }

  /** Test affordance: which receipts have we already published settlements for? */
  alreadySettled(): Set<string> {
    return new Set(this.published.keys());
  }
}

function randomTid(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
