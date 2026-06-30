// Tests for the PDS-backed durable dependency resolver.
//
// The 2026-06 incident: the exchange resolved receipt deps against the local
// store only, so a dead relay + a dropped mirror hint stranded receipts in
// resolve-failed forever. These tests pin the fallback contract: store-first,
// PDS on miss, back-fill the cache, negative-cache genuine absences, and
// NEVER cache a transient error (so it retries).

import { describe, expect, it, vi } from "vitest";

import type { IndexedRecord } from "@cocore/sdk";
import { ResolveError } from "@cocore/sdk/resolve";

import { makePdsBackedResolver, type ResolverStore } from "./resolve-record.ts";

function makeStore(): ResolverStore & { rows: Map<string, IndexedRecord> } {
  const rows = new Map<string, IndexedRecord>();
  return {
    rows,
    get: (uri) => rows.get(uri) ?? null,
    upsert: (rec) => {
      rows.set(rec.uri, rec);
    },
  };
}

function rec(uri: string): IndexedRecord {
  return {
    uri,
    cid: "bafyfake",
    collection: "dev.cocore.compute.attestation",
    repo: "did:plc:provider",
    rkey: uri.split("/").pop() ?? "",
    body: { hello: "world" },
  } as IndexedRecord;
}

const URI = "at://did:plc:provider/dev.cocore.compute.attestation/att1";

describe("makePdsBackedResolver", () => {
  it("returns a local store hit without touching the PDS", async () => {
    const store = makeStore();
    store.upsert(rec(URI));
    const resolveOverPds = vi.fn();
    const resolve = makePdsBackedResolver({ store, resolveOverPds, log: () => {} });

    expect(await resolve(URI)).toMatchObject({ uri: URI });
    expect(resolveOverPds).not.toHaveBeenCalled();
  });

  it("falls back to the PDS on a store miss and back-fills the cache", async () => {
    const store = makeStore();
    const resolveOverPds = vi.fn().mockResolvedValue(rec(URI));
    const resolve = makePdsBackedResolver({ store, resolveOverPds, log: () => {} });

    // First call: store miss → PDS fetch → back-fill.
    expect(await resolve(URI)).toMatchObject({ uri: URI });
    expect(resolveOverPds).toHaveBeenCalledTimes(1);
    expect(store.rows.has(URI)).toBe(true);

    // Second call: now a local hit — no further PDS round-trip.
    expect(await resolve(URI)).toMatchObject({ uri: URI });
    expect(resolveOverPds).toHaveBeenCalledTimes(1);
  });

  it("negative-caches a genuine not-found, then re-queries after the TTL", async () => {
    const store = makeStore();
    const resolveOverPds = vi.fn().mockResolvedValue(null);
    let clock = 1_000;
    const resolve = makePdsBackedResolver({
      store,
      resolveOverPds,
      log: () => {},
      negativeTtlMs: 30_000,
      now: () => clock,
    });

    expect(await resolve(URI)).toBeNull();
    expect(await resolve(URI)).toBeNull(); // within TTL → no second PDS call
    expect(resolveOverPds).toHaveBeenCalledTimes(1);

    clock += 30_001; // TTL elapsed
    expect(await resolve(URI)).toBeNull();
    expect(resolveOverPds).toHaveBeenCalledTimes(2);
  });

  it("does NOT cache a transient PDS error — every call retries", async () => {
    const store = makeStore();
    const resolveOverPds = vi
      .fn()
      .mockRejectedValue(new ResolveError("plc-fetch", "plc.directory 503"));
    const resolve = makePdsBackedResolver({ store, resolveOverPds, log: () => {} });

    expect(await resolve(URI)).toBeNull();
    expect(await resolve(URI)).toBeNull();
    // No negative cache for errors: both calls hit the PDS.
    expect(resolveOverPds).toHaveBeenCalledTimes(2);
  });

  it("recovers: a transient error then a success resolves + back-fills", async () => {
    const store = makeStore();
    const resolveOverPds = vi
      .fn()
      .mockRejectedValueOnce(new ResolveError("get-record", "getRecord 502"))
      .mockResolvedValueOnce(rec(URI));
    const resolve = makePdsBackedResolver({ store, resolveOverPds, log: () => {} });

    expect(await resolve(URI)).toBeNull(); // transient
    expect(await resolve(URI)).toMatchObject({ uri: URI }); // recovered
    expect(store.rows.has(URI)).toBe(true);
  });
});
