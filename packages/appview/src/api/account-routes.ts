// XRPC handlers for dev.cocore.account.* (API-key management), served
// by the AppView and backed by the operational AccountStore.
//
// Auth: atproto service-auth only. A client calls the method through
// its PDS's service proxy (`atproto-proxy: <appviewDid>#cocore_appview`);
// the PDS mints a JWT signed by the user's repo key, which we verify
// with `verifyServiceAuthToken`. The authenticated DID scopes every
// operation, so a caller can only ever touch their own keys.
//
// These mirror the console's dev.cocore.account.* routes (the canonical
// path already used service-auth); the difference is the key store now
// lives in the AppView, not console-db.

import type { IncomingMessage, ServerResponse } from "node:http";

import { verifyServiceAuthToken } from "../auth/service-auth.ts";
import type { AccountStore, ApiKeyRow } from "../operational/account-store.ts";

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void | Promise<void>;

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
      // Key-management bodies are tiny; cap to avoid unbounded buffering.
      if (size > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("body must be JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Shape an {@link ApiKeyRow} into the `dev.cocore.account.defs#apiKeyView`
 *  wire form: never the secret, and null optionals dropped (absent, not
 *  null) so the JSON matches the lexicon. */
function apiKeyView(row: ApiKeyRow): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: row.id,
    did: row.did,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
  };
  if (row.expiresAt) view.expiresAt = row.expiresAt;
  if (row.revokedAt) view.revokedAt = row.revokedAt;
  if (row.lastUsedAt) view.lastUsedAt = row.lastUsedAt;
  return view;
}

/** Verify service auth for `lxm`. On success returns the DID; on failure
 *  writes the 401 response and returns null. */
async function authedDid(
  req: IncomingMessage,
  res: ServerResponse,
  audience: string,
  lxm: string,
): Promise<string | null> {
  const result = await verifyServiceAuthToken(bearer(req), { audience, lxm });
  if (!result.ok) {
    json(res, result.status, { error: result.error, message: result.message });
    return null;
  }
  return result.did;
}

function methodNotAllowed(res: ServerResponse, expected: string): void {
  json(res, 405, { error: "MethodNotAllowed", message: `expected HTTP ${expected}` });
}

/** Route map for the four account methods, scoped to `appviewDid` as the
 *  service-auth audience and `store` as the key backend. Merge into the
 *  AppView's route table. */
export function accountRoutes(store: AccountStore, appviewDid: string): Record<string, Handler> {
  const NS = "dev.cocore.account";
  return {
    [`/xrpc/${NS}.listApiKeys`]: async (req, res) => {
      if (req.method !== "GET") return methodNotAllowed(res, "GET");
      const did = await authedDid(req, res, appviewDid, `${NS}.listApiKeys`);
      if (!did) return;
      json(res, 200, { keys: store.listKeysForDid(did).map(apiKeyView) });
    },

    [`/xrpc/${NS}.createApiKey`]: async (req, res) => {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      const did = await authedDid(req, res, appviewDid, `${NS}.createApiKey`);
      if (!did) return;
      let body: { name?: unknown; expiresAt?: unknown };
      try {
        body = (await readJsonBody(req)) as typeof body;
      } catch (e) {
        return json(res, 400, { error: "InvalidRequest", message: (e as Error).message });
      }
      if (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 100) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "name must be a string of length 1..100",
        });
      }
      if (
        body.expiresAt !== undefined &&
        body.expiresAt !== null &&
        typeof body.expiresAt !== "string"
      ) {
        return json(res, 400, {
          error: "InvalidRequest",
          message: "expiresAt must be an RFC3339 string when provided",
        });
      }
      const { key, secret } = store.createKey({
        did,
        name: body.name,
        expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : null,
      });
      json(res, 200, { key: apiKeyView(key), secret });
    },

    [`/xrpc/${NS}.revokeApiKey`]: async (req, res) => {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      const did = await authedDid(req, res, appviewDid, `${NS}.revokeApiKey`);
      if (!did) return;
      const id = await readKeyId(req, res);
      if (id === null) return;
      json(res, 200, { revoked: store.revokeKey({ id, did }) });
    },

    [`/xrpc/${NS}.deleteApiKey`]: async (req, res) => {
      if (req.method !== "POST") return methodNotAllowed(res, "POST");
      const did = await authedDid(req, res, appviewDid, `${NS}.deleteApiKey`);
      if (!did) return;
      const id = await readKeyId(req, res);
      if (id === null) return;
      json(res, 200, { deleted: store.deleteKey({ id, did }) });
    },
  };

  /** Parse the shared `{ id }` body for revoke/delete. Writes a 400 and
   *  returns null on a bad body. */
  async function readKeyId(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
    let body: { id?: unknown };
    try {
      body = (await readJsonBody(req)) as typeof body;
    } catch (e) {
      json(res, 400, { error: "InvalidRequest", message: (e as Error).message });
      return null;
    }
    if (typeof body.id !== "string" || body.id.length < 1 || body.id.length > 200) {
      json(res, 400, { error: "InvalidRequest", message: "id must be a string of length 1..200" });
      return null;
    }
    return body.id;
  }
}
