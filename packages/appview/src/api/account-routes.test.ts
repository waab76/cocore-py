import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";

import { Store } from "../store.ts";
import { AccountStore } from "../operational/account-store.ts";
import { buildServer } from "./server.ts";

// Mock service-auth so we can drive the authed flow without a real
// signing key / DID resolution: a bearer token `ok-<did>` authenticates
// as <did>; anything else is AuthRequired. The real verifier has its own
// unit tests (service-auth.test.ts).
vi.mock("../auth/service-auth.ts", () => ({
  verifyServiceAuthToken: async (jwt: string | null) => {
    if (jwt && jwt.startsWith("ok-")) return { ok: true, did: jwt.slice(3) };
    return { ok: false, status: 401, error: "AuthRequired", message: "no token" };
  },
}));

const APPVIEW_DID = "did:web:appview.test";
const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";

function startServer(opts: { withAccount: boolean }): Promise<{ base: string; server: Server }> {
  const store = new Store(":memory:");
  const accountStore = opts.withAccount ? new AccountStore(":memory:") : undefined;
  const server = buildServer(store, {
    accountStore,
    appviewDid: opts.withAccount ? APPVIEW_DID : undefined,
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) throw new Error("no address");
      resolve({ base: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

let server: Server | undefined;
let base = "";
afterEach(() => {
  server?.close();
  server = undefined;
});

async function withServer(withAccount = true): Promise<void> {
  const s = await startServer({ withAccount });
  server = s.server;
  base = s.base;
}

function authed(did: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...init.headers, authorization: `Bearer ok-${did}` } };
}

const N = "dev.cocore.account";

describe("account.* over the AppView", () => {
  beforeEach(() => withServer());

  it("creates a key (secret once), lists it without the secret, then revokes + deletes", async () => {
    // create
    const created = await fetch(
      `${base}/xrpc/${N}.createApiKey`,
      authed(ALICE, { method: "POST", body: JSON.stringify({ name: "laptop" }) }),
    );
    expect(created.status).toBe(200);
    const c = (await created.json()) as { key: { id: string; did: string }; secret: string };
    expect(c.secret.startsWith("cocore-")).toBe(true);
    expect(c.key.did).toBe(ALICE);

    // list — has the key, never the secret/hash
    const listed = await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(ALICE));
    const l = (await listed.json()) as { keys: Array<Record<string, unknown>> };
    expect(l.keys).toHaveLength(1);
    expect(l.keys[0]).toMatchObject({ id: c.key.id, did: ALICE, name: "laptop" });
    expect(JSON.stringify(l.keys[0])).not.toContain(c.secret);
    expect(l.keys[0]).not.toHaveProperty("hash");

    // revoke
    const revoked = await fetch(
      `${base}/xrpc/${N}.revokeApiKey`,
      authed(ALICE, { method: "POST", body: JSON.stringify({ id: c.key.id }) }),
    );
    expect((await revoked.json()) as unknown).toEqual({ revoked: true });
    const afterRevoke = (await (
      await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(ALICE))
    ).json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(afterRevoke.keys[0]).toHaveProperty("revokedAt");

    // delete
    const deleted = await fetch(
      `${base}/xrpc/${N}.deleteApiKey`,
      authed(ALICE, { method: "POST", body: JSON.stringify({ id: c.key.id }) }),
    );
    expect((await deleted.json()) as unknown).toEqual({ deleted: true });
    const afterDelete = (await (
      await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(ALICE))
    ).json()) as {
      keys: unknown[];
    };
    expect(afterDelete.keys).toHaveLength(0);
  });

  it("scopes keys to the owner — Bob can't see, revoke, or delete Alice's key", async () => {
    const c = (await (
      await fetch(
        `${base}/xrpc/${N}.createApiKey`,
        authed(ALICE, { method: "POST", body: JSON.stringify({ name: "k" }) }),
      )
    ).json()) as { key: { id: string } };

    const bobList = (await (await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(BOB))).json()) as {
      keys: unknown[];
    };
    expect(bobList.keys).toHaveLength(0);

    const bobRevoke = await fetch(
      `${base}/xrpc/${N}.revokeApiKey`,
      authed(BOB, { method: "POST", body: JSON.stringify({ id: c.key.id }) }),
    );
    expect((await bobRevoke.json()) as unknown).toEqual({ revoked: false });

    const bobDelete = await fetch(
      `${base}/xrpc/${N}.deleteApiKey`,
      authed(BOB, { method: "POST", body: JSON.stringify({ id: c.key.id }) }),
    );
    expect((await bobDelete.json()) as unknown).toEqual({ deleted: false });
  });

  it("401s without a valid service-auth token", async () => {
    expect((await fetch(`${base}/xrpc/${N}.listApiKeys`)).status).toBe(401);
    expect(
      (await fetch(`${base}/xrpc/${N}.createApiKey`, { method: "POST", body: "{}" })).status,
    ).toBe(401);
  });

  it("405s on the wrong HTTP method", async () => {
    expect((await fetch(`${base}/xrpc/${N}.createApiKey`, authed(ALICE))).status).toBe(405); // GET
    expect(
      (await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(ALICE, { method: "POST" }))).status,
    ).toBe(405);
  });

  it("400s on invalid input", async () => {
    const noName = await fetch(
      `${base}/xrpc/${N}.createApiKey`,
      authed(ALICE, { method: "POST", body: "{}" }),
    );
    expect(noName.status).toBe(400);
    const noId = await fetch(
      `${base}/xrpc/${N}.revokeApiKey`,
      authed(ALICE, { method: "POST", body: "{}" }),
    );
    expect(noId.status).toBe(400);
  });
});

describe("account.* not registered without a service DID", () => {
  it("404s the methods when appviewDid is unset", async () => {
    await withServer(false);
    expect((await fetch(`${base}/xrpc/${N}.listApiKeys`, authed(ALICE))).status).toBe(404);
  });
});
