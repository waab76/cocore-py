// Shared implementation for the console's PDS-write endpoints.
//
// These are internal HTTP RPCs (NOT XRPC/lexicon methods) that write
// ATProto records to the caller's PDS via the console's OAuth session.
// The callers are *other processes* — the Rust provider agent and the
// exchange — that can't talk to bsky directly: real bsky PDSes require
// DPoP-bound tokens, and the JS OAuth client running in the console is
// the only thing that has DPoP wired up.
//
// The canonical routes are `/api/pds/{create,put,delete}Record`. The
// legacy `/xrpc/dev.cocore.proxy.*` routes are thin deprecated aliases
// that call straight into these functions so already-deployed agents
// keep working. Keep the logic here, not in the route files, so the two
// entry points can never drift.

import type { Did } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import { Effect } from "effect";

import { restoreAtprotoSessionEffect } from "@/integrations/auth/atproto.server.ts";
import { resolveBearerKey } from "@/lib/api-keys.server.ts";
import { cocoreConfig } from "@/lib/cocore-config.ts";

/** Collection NSIDs these endpoints will write to a user's PDS. We allow
 *  the full `dev.cocore.*` namespace (compute.* receipts/jobs/etc. AND
 *  account.* profile/grant/friend/patronage records) because the services
 *  container needs to publish account records too — see
 *  infra/services/src/main.ts's `emitTokenGrantRecord` and
 *  `emitPatronageRecords`. A bearer API key still gates the call, so the
 *  worst this can do is scribble cocore-shaped records onto the user's
 *  repo; never anything outside the namespace. */
const COLLECTION_PREFIX = "dev.cocore.";

function rkeyFromUri(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] ?? "";
}

/** Best-effort mirror to the local AppView indexer. We don't await the
 *  response — if the bridge is down the PDS record still wins, and the
 *  AppView will eventually catch up via the firehose. */
function mirrorToBridge(args: {
  uri: string;
  cid: string;
  collection: string;
  repo: string;
  record: Record<string, unknown>;
}): void {
  const bridgeUrl = cocoreConfig().bridgeUrl?.replace(/\/$/, "");
  if (!bridgeUrl) return;
  void fetch(`${bridgeUrl}/xrpc/dev.cocore.bridge.publish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      uri: args.uri,
      cid: args.cid,
      collection: args.collection,
      repo: args.repo,
      rkey: rkeyFromUri(args.uri),
      body: args.record,
    }),
  }).catch(() => {
    // swallowed — this is a cache hint, not a checkpoint
  });
}

function mirrorDeleteToBridge(uri: string): void {
  const bridgeUrl = cocoreConfig().bridgeUrl?.replace(/\/$/, "");
  if (!bridgeUrl) return;
  void fetch(`${bridgeUrl}/xrpc/dev.cocore.bridge.unpublish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri }),
  }).catch(() => {
    // swallowed — AppView eventually catches up via firehose
  });
}

function readBearer(request: Request): string | null {
  const h = request.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Resolve the bearer key → an authenticated, DPoP-capable OAuth session,
 *  or a `Response` describing the auth failure to return verbatim. The
 *  return type is inferred so `session` narrows to non-null past the guard. */
async function authSession(request: Request) {
  const bearer = readBearer(request);
  if (!bearer) return jsonError(401, "missing Authorization: Bearer header");
  const resolved = resolveBearerKey(bearer);
  if (!resolved) return jsonError(401, "invalid API key");
  if (!isDid(resolved.did)) return jsonError(500, "stored DID is malformed");
  const did = resolved.did as Did;
  const session = await Effect.runPromise(restoreAtprotoSessionEffect(did));
  if (!session) {
    return jsonError(401, "underlying ATProto session no longer valid; re-authenticate");
  }
  return { did, session };
}

// ---- createRecord ---------------------------------------------------

interface CreateRaw {
  collection?: unknown;
  record?: unknown;
  rkey?: unknown;
}
interface CreateParsed {
  collection: string;
  record: Record<string, unknown>;
  rkey?: string;
}

function parseCreate(raw: CreateRaw): CreateParsed | string {
  if (typeof raw.collection !== "string" || raw.collection.length === 0) return "collection required";
  if (!raw.collection.startsWith(COLLECTION_PREFIX)) {
    return `collection must start with ${COLLECTION_PREFIX}`;
  }
  if (typeof raw.record !== "object" || raw.record === null || Array.isArray(raw.record)) {
    return "record must be a non-null object";
  }
  if (raw.rkey !== undefined && typeof raw.rkey !== "string") {
    return "rkey must be a string when provided";
  }
  return {
    collection: raw.collection,
    record: raw.record as Record<string, unknown>,
    ...(typeof raw.rkey === "string" ? { rkey: raw.rkey } : {}),
  };
}

export async function pdsCreateRecord(request: Request): Promise<Response> {
  const auth = await authSession(request);
  if (auth instanceof Response) return auth;
  const { did, session } = auth;

  let raw: CreateRaw;
  try {
    raw = (await request.json()) as CreateRaw;
  } catch {
    return jsonError(400, "body must be JSON");
  }
  const parsed = parseCreate(raw);
  if (typeof parsed === "string") return jsonError(400, parsed);

  const r = await session.handle(`/xrpc/com.atproto.repo.createRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: parsed.collection,
      record: parsed.record,
      ...(parsed.rkey ? { rkey: parsed.rkey } : {}),
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return jsonError(r.status >= 500 ? 502 : r.status, `pds createRecord ${parsed.collection}: ${body.slice(0, 300)}`);
  }
  // com.atproto.repo.createRecord returns `commit: { cid, rev }` — the
  // signed repo commit the record landed in. Forward it so the caller
  // (e.g. the provider, writing a receipt) can surface an inclusion
  // pointer into the provider's signed MST without the verifier having
  // to re-fetch the repo.
  const out = (await r.json()) as { uri: string; cid: string; commit?: { cid: string; rev: string } };
  // Mirror to the local AppView indexer so /machines, /jobs, and /models
  // see the record with low latency. The relay subscription is the
  // durable path; the bridge dispatch shortens the round-trip.
  mirrorToBridge({ uri: out.uri, cid: out.cid, collection: parsed.collection, repo: did, record: parsed.record });
  return jsonOk({ uri: out.uri, cid: out.cid, commit: out.commit });
}

// ---- putRecord ------------------------------------------------------

interface PutRaw {
  collection?: unknown;
  rkey?: unknown;
  record?: unknown;
  swapRecord?: unknown;
}
interface PutParsed {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
  swapRecord?: string;
}

function parsePut(raw: PutRaw): PutParsed | string {
  if (typeof raw.collection !== "string" || raw.collection.length === 0) return "collection required";
  if (!raw.collection.startsWith(COLLECTION_PREFIX)) {
    return `collection must start with ${COLLECTION_PREFIX}`;
  }
  if (typeof raw.rkey !== "string" || raw.rkey.length === 0) {
    return "rkey required for putRecord (use createRecord for fresh rkeys)";
  }
  if (typeof raw.record !== "object" || raw.record === null || Array.isArray(raw.record)) {
    return "record must be a non-null object";
  }
  if (raw.swapRecord !== undefined && typeof raw.swapRecord !== "string") {
    return "swapRecord must be a string when provided";
  }
  return {
    collection: raw.collection,
    rkey: raw.rkey,
    record: raw.record as Record<string, unknown>,
    ...(typeof raw.swapRecord === "string" ? { swapRecord: raw.swapRecord } : {}),
  };
}

export async function pdsPutRecord(request: Request): Promise<Response> {
  const auth = await authSession(request);
  if (auth instanceof Response) return auth;
  const { did, session } = auth;

  let raw: PutRaw;
  try {
    raw = (await request.json()) as PutRaw;
  } catch {
    return jsonError(400, "body must be JSON");
  }
  const parsed = parsePut(raw);
  if (typeof parsed === "string") return jsonError(400, parsed);

  const r = await session.handle(`/xrpc/com.atproto.repo.putRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: parsed.collection,
      rkey: parsed.rkey,
      record: parsed.record,
      ...(parsed.swapRecord ? { swapRecord: parsed.swapRecord } : {}),
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return jsonError(r.status >= 500 ? 502 : r.status, `pds putRecord ${parsed.collection}: ${body.slice(0, 300)}`);
  }
  const out = (await r.json()) as { uri: string; cid: string };
  mirrorToBridge({ uri: out.uri, cid: out.cid, collection: parsed.collection, repo: did, record: parsed.record });
  return jsonOk({ uri: out.uri, cid: out.cid });
}

// ---- deleteRecord ---------------------------------------------------

interface DeleteRaw {
  collection?: unknown;
  rkey?: unknown;
  swapRecord?: unknown;
}
interface DeleteParsed {
  collection: string;
  rkey: string;
  swapRecord?: string;
}

function parseDelete(raw: DeleteRaw): DeleteParsed | string {
  if (typeof raw.collection !== "string" || raw.collection.length === 0) return "collection required";
  if (!raw.collection.startsWith(COLLECTION_PREFIX)) {
    return `collection must start with ${COLLECTION_PREFIX}`;
  }
  if (typeof raw.rkey !== "string" || raw.rkey.length === 0) return "rkey required";
  if (raw.swapRecord !== undefined && typeof raw.swapRecord !== "string") {
    return "swapRecord must be a string when provided";
  }
  return {
    collection: raw.collection,
    rkey: raw.rkey,
    ...(typeof raw.swapRecord === "string" ? { swapRecord: raw.swapRecord } : {}),
  };
}

export async function pdsDeleteRecord(request: Request): Promise<Response> {
  const auth = await authSession(request);
  if (auth instanceof Response) return auth;
  const { did, session } = auth;

  let raw: DeleteRaw;
  try {
    raw = (await request.json()) as DeleteRaw;
  } catch {
    return jsonError(400, "body must be JSON");
  }
  const parsed = parseDelete(raw);
  if (typeof parsed === "string") return jsonError(400, parsed);

  const r = await session.handle(`/xrpc/com.atproto.repo.deleteRecord`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repo: did,
      collection: parsed.collection,
      rkey: parsed.rkey,
      ...(parsed.swapRecord ? { swapRecord: parsed.swapRecord } : {}),
    }),
  });
  // Mirror deletion regardless of PDS outcome: a record that's already
  // gone from PDS is still expected to disappear from the AppView (the
  // goal is "this row vanishes from /machines").
  const uri = `at://${did}/${parsed.collection}/${parsed.rkey}`;
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    // 404 / "InvalidSwap" / "could not locate" all collapse to "the
    // record is already gone" — clear the AppView and return success so
    // the agent's dedup loop can move on.
    if (r.status === 404 || /not.*locate|InvalidSwap|not.*found/i.test(body)) {
      mirrorDeleteToBridge(uri);
      return jsonOk({ uri, alreadyGone: true });
    }
    return jsonError(r.status >= 500 ? 502 : r.status, `pds deleteRecord ${parsed.collection}: ${body.slice(0, 300)}`);
  }
  mirrorDeleteToBridge(uri);
  return jsonOk({ uri });
}
