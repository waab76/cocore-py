// AppView PDS-write endpoints: /pds/{create,put,delete}Record.
//
// Internal HTTP RPCs (NOT XRPC/lexicon methods) that write ATProto
// records to the caller's PDS via a DPoP-bound OAuth session the AppView
// owns. Ported from the console's pds-write.server.ts; the difference is
// that auth (bearer API key -> DID) and the OAuth session both now live
// in the AppView. Callers (the Rust provider agent, the exchange) present
// `Authorization: Bearer cocore-...`; only `dev.cocore.*` collections are
// writable.

import type { Did } from "@atcute/lexicons";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AccountStore } from "../operational/account-store.ts";
import { type AppviewOAuthClient, restoreSession } from "../auth/oauth-client.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

const COLLECTION_PREFIX = "dev.cocore.";

interface PdsWriteContext {
  accounts: AccountStore;
  oauth: AppviewOAuthClient;
  /** Bridge base URL for the best-effort AppView-cache mirror. When
   *  unset, writes still land on the PDS and the firehose catches up. */
  bridgeUrl?: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1]!.trim() : null;
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

function rkeyFromUri(uri: string): string {
  const parts = uri.split("/");
  return parts[parts.length - 1] ?? "";
}

function mirrorPublish(
  bridgeUrl: string | undefined,
  args: {
    uri: string;
    cid: string;
    collection: string;
    repo: string;
    record: Record<string, unknown>;
  },
): void {
  if (!bridgeUrl) return;
  void fetch(`${bridgeUrl.replace(/\/$/, "")}/xrpc/dev.cocore.bridge.publish`, {
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
    /* swallowed — cache hint, not a checkpoint */
  });
}

function mirrorUnpublish(bridgeUrl: string | undefined, uri: string): void {
  if (!bridgeUrl) return;
  void fetch(`${bridgeUrl.replace(/\/$/, "")}/xrpc/dev.cocore.bridge.unpublish`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uri }),
  }).catch(() => {
    /* swallowed — firehose catches up */
  });
}

/** Resolve a bearer API key -> a DPoP-bound session, or write the error
 *  response and return null. */
async function authedSession(req: IncomingMessage, res: ServerResponse, ctx: PdsWriteContext) {
  const token = bearer(req);
  if (!token) {
    json(res, 401, { error: "AuthRequired", message: "missing Authorization: Bearer header" });
    return null;
  }
  const resolved = ctx.accounts.resolveBearerKey(token);
  if (!resolved) {
    json(res, 401, { error: "AuthRequired", message: "invalid API key" });
    return null;
  }
  const session = await restoreSession(ctx.oauth, resolved.did as Did);
  if (!session) {
    json(res, 401, {
      error: "AuthRequired",
      message: "underlying ATProto session no longer valid; re-authenticate",
    });
    return null;
  }
  return { did: resolved.did, session };
}

function badCollection(collection: unknown): collection is string {
  return typeof collection === "string" && collection.startsWith(COLLECTION_PREFIX);
}

export function pdsRoutes(ctx: PdsWriteContext): Record<string, Handler> {
  return {
    "/pds/createRecord": async (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "MethodNotAllowed" });
      const auth = await authedSession(req, res, ctx);
      if (!auth) return;

      let body: { collection?: unknown; record?: unknown; rkey?: unknown };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch (e) {
        return json(res, 400, { error: "InvalidRequest", message: (e as Error).message });
      }
      if (!badCollection(body.collection)) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: `collection must start with ${COLLECTION_PREFIX}`,
        });
      }
      if (typeof body.record !== "object" || body.record === null || Array.isArray(body.record)) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "record must be a non-null object",
        });
      }
      if (body.rkey !== undefined && typeof body.rkey !== "string") {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "rkey must be a string when provided",
        });
      }
      const collection = body.collection;
      const record = body.record as Record<string, unknown>;

      const r = await auth.session.handle(`/xrpc/com.atproto.repo.createRecord`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: auth.did,
          collection,
          record,
          ...(body.rkey ? { rkey: body.rkey } : {}),
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return json(res, r.status >= 500 ? 502 : r.status, {
          error: "PdsError",
          message: `createRecord ${collection}: ${text.slice(0, 300)}`,
        });
      }
      const out = (await r.json()) as {
        uri: string;
        cid: string;
        commit?: { cid: string; rev: string };
      };
      mirrorPublish(ctx.bridgeUrl, {
        uri: out.uri,
        cid: out.cid,
        collection,
        repo: auth.did,
        record,
      });
      json(res, 200, { uri: out.uri, cid: out.cid, commit: out.commit });
    },

    "/pds/putRecord": async (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "MethodNotAllowed" });
      const auth = await authedSession(req, res, ctx);
      if (!auth) return;

      let body: { collection?: unknown; rkey?: unknown; record?: unknown; swapRecord?: unknown };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch (e) {
        return json(res, 400, { error: "InvalidRequest", message: (e as Error).message });
      }
      if (!badCollection(body.collection)) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: `collection must start with ${COLLECTION_PREFIX}`,
        });
      }
      if (typeof body.rkey !== "string" || body.rkey.length === 0) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "rkey required (use createRecord for fresh rkeys)",
        });
      }
      if (typeof body.record !== "object" || body.record === null || Array.isArray(body.record)) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "record must be a non-null object",
        });
      }
      if (body.swapRecord !== undefined && typeof body.swapRecord !== "string") {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "swapRecord must be a string when provided",
        });
      }
      const collection = body.collection;
      const record = body.record as Record<string, unknown>;

      const r = await auth.session.handle(`/xrpc/com.atproto.repo.putRecord`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: auth.did,
          collection,
          rkey: body.rkey,
          record,
          ...(body.swapRecord ? { swapRecord: body.swapRecord } : {}),
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        return json(res, r.status >= 500 ? 502 : r.status, {
          error: "PdsError",
          message: `putRecord ${collection}: ${text.slice(0, 300)}`,
        });
      }
      const out = (await r.json()) as { uri: string; cid: string };
      mirrorPublish(ctx.bridgeUrl, {
        uri: out.uri,
        cid: out.cid,
        collection,
        repo: auth.did,
        record,
      });
      json(res, 200, { uri: out.uri, cid: out.cid });
    },

    "/pds/deleteRecord": async (req, res) => {
      if (req.method !== "POST") return json(res, 405, { error: "MethodNotAllowed" });
      const auth = await authedSession(req, res, ctx);
      if (!auth) return;

      let body: { collection?: unknown; rkey?: unknown; swapRecord?: unknown };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch (e) {
        return json(res, 400, { error: "InvalidRequest", message: (e as Error).message });
      }
      if (!badCollection(body.collection)) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: `collection must start with ${COLLECTION_PREFIX}`,
        });
      }
      if (typeof body.rkey !== "string" || body.rkey.length === 0) {
        return json(res, 400, { error: "InvalidRequest", message: "rkey required" });
      }
      if (body.swapRecord !== undefined && typeof body.swapRecord !== "string") {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "swapRecord must be a string when provided",
        });
      }
      const collection = body.collection;
      const uri = `at://${auth.did}/${collection}/${body.rkey}`;

      const r = await auth.session.handle(`/xrpc/com.atproto.repo.deleteRecord`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo: auth.did,
          collection,
          rkey: body.rkey,
          ...(body.swapRecord ? { swapRecord: body.swapRecord } : {}),
        }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        // Already-gone collapses to success so the agent's dedup loop moves on.
        if (r.status === 404 || /not.*locate|InvalidSwap|not.*found/i.test(text)) {
          mirrorUnpublish(ctx.bridgeUrl, uri);
          return json(res, 200, { uri, alreadyGone: true });
        }
        return json(res, r.status >= 500 ? 502 : r.status, {
          error: "PdsError",
          message: `deleteRecord ${collection}: ${text.slice(0, 300)}`,
        });
      }
      mirrorUnpublish(ctx.bridgeUrl, uri);
      json(res, 200, { uri });
    },
  };
}
