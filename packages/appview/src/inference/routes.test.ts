import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { Store } from "../store.ts";
import type { AppviewOAuthClient } from "../auth/oauth-client.ts";
import { inferenceRoutes } from "./routes.ts";

// dispatch authenticates BEFORE touching the store/oauth, so the 401 and
// 405 gates can be exercised with a stub OAuth client.
function mount(): Promise<{ base: string; server: Server }> {
  const routes = inferenceRoutes({
    store: new Store(":memory:"),
    oauth: {} as unknown as AppviewOAuthClient,
    appviewDid: "did:web:appview.test",
    advisorUrl: "http://127.0.0.1:1",
    exchangeDid: "did:web:exchange.test",
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const h = routes[url.pathname];
    if (!h) return void res.writeHead(404).end("{}");
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

describe("inference.dispatch route", () => {
  it("requires service auth (401 without a token)", async () => {
    const m = await mount();
    server = m.server;
    const r = await fetch(`${m.base}/xrpc/dev.cocore.inference.dispatch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "llama",
        prompt: "hi",
        maxTokensOut: 16,
        priceCeiling: { amount: 0, currency: "USD" },
      }),
    });
    expect(r.status).toBe(401);
  });

  it("405s on the wrong method", async () => {
    const m = await mount();
    server = m.server;
    expect((await fetch(`${m.base}/xrpc/dev.cocore.inference.dispatch`)).status).toBe(405); // GET
  });
});
