import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { AccountStore } from "../operational/account-store.ts";
import type { AppviewOAuthClient } from "../auth/oauth-client.ts";
import { pdsRoutes } from "./write.ts";

const ALICE = "did:plc:alice";

/** A fake OAuth client whose restored session echoes the repo call it
 *  received, so tests can assert what would have hit the PDS. `restore`
 *  returns null for `nullFor` DIDs (simulates an expired session). */
function fakeOauth(
  opts: {
    reply?: (path: string, payload: unknown) => { status: number; body: unknown };
    nullFor?: Set<string>;
  } = {},
): AppviewOAuthClient {
  const reply =
    opts.reply ??
    ((path, payload) => {
      const p = payload as { collection?: string; rkey?: string };
      if (path.endsWith("createRecord")) {
        return {
          status: 200,
          body: {
            uri: `at://${ALICE}/${p.collection}/rk`,
            cid: "bafycid",
            commit: { cid: "c", rev: "r" },
          },
        };
      }
      if (path.endsWith("putRecord")) {
        return {
          status: 200,
          body: { uri: `at://${ALICE}/${p.collection}/${p.rkey}`, cid: "bafycid" },
        };
      }
      return { status: 200, body: {} };
    });
  return {
    restore: async (did: string) => {
      if (opts.nullFor?.has(did)) throw new Error("no session");
      return {
        handle: async (path: string, init: { body?: string }) => {
          const payload = init.body ? JSON.parse(init.body) : {};
          const { status, body } = reply(path, payload);
          return new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      };
    },
  } as unknown as AppviewOAuthClient;
}

function mount(
  accounts: AccountStore,
  oauth: AppviewOAuthClient,
): Promise<{ base: string; server: Server }> {
  const routes = pdsRoutes({ accounts, oauth });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const h = routes[url.pathname];
    if (!h) {
      res.writeHead(404).end("{}");
      return;
    }
    void h(req, res, url);
  });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || !addr) throw new Error("no addr");
      resolve({ base: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

async function setup(oauth?: AppviewOAuthClient): Promise<{ base: string; secret: string }> {
  const accounts = new AccountStore(":memory:");
  const { secret } = accounts.createKey({ did: ALICE, name: "agent" });
  const m = await mount(accounts, oauth ?? fakeOauth());
  server = m.server;
  return { base: m.base, secret };
}

function post(base: string, path: string, secret: string | null, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("/pds/* write endpoints", () => {
  it("createRecord writes via the session and returns uri/cid/commit", async () => {
    const { base, secret } = await setup();
    const r = await post(base, "/pds/createRecord", secret, {
      collection: "dev.cocore.compute.receipt",
      record: { foo: 1 },
    });
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toMatchObject({ cid: "bafycid", commit: { rev: "r" } });
  });

  it("putRecord requires an rkey and echoes it back", async () => {
    const { base, secret } = await setup();
    const ok = await post(base, "/pds/putRecord", secret, {
      collection: "dev.cocore.compute.provider",
      rkey: "self",
      record: { a: 1 },
    });
    expect(((await ok.json()) as { uri: string }).uri).toContain("/self");

    const noRkey = await post(base, "/pds/putRecord", secret, {
      collection: "dev.cocore.compute.provider",
      record: {},
    });
    expect(noRkey.status).toBe(400);
  });

  it("deleteRecord returns the uri", async () => {
    const { base, secret } = await setup();
    const r = await post(base, "/pds/deleteRecord", secret, {
      collection: "dev.cocore.account.profile",
      rkey: "self",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { uri: string }).uri).toBe(
      `at://${ALICE}/dev.cocore.account.profile/self`,
    );
  });

  it("401s without a valid bearer key", async () => {
    const { base } = await setup();
    expect((await post(base, "/pds/createRecord", null, {})).status).toBe(401);
    expect((await post(base, "/pds/createRecord", "cocore-bogus", {})).status).toBe(401);
  });

  it("401s when the OAuth session can't be restored", async () => {
    const { base, secret } = await setup(fakeOauth({ nullFor: new Set([ALICE]) }));
    const r = await post(base, "/pds/createRecord", secret, {
      collection: "dev.cocore.compute.job",
      record: {},
    });
    expect(r.status).toBe(401);
  });

  it("400s a collection outside dev.cocore.*", async () => {
    const { base, secret } = await setup();
    const r = await post(base, "/pds/createRecord", secret, {
      collection: "app.bsky.feed.post",
      record: {},
    });
    expect(r.status).toBe(400);
  });

  it("405s on the wrong method", async () => {
    const { base } = await setup();
    expect((await fetch(`${base}/pds/createRecord`)).status).toBe(405);
  });
});
