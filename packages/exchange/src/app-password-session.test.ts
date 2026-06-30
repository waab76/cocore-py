// Tests for the exchange's app-password session manager.
//
// Pins the contract that makes the exchange's PDS writes self-healing (no
// human re-auth ever again): mint on first use, refresh proactively before
// expiry, refresh + retry once on a 401, and re-create straight from the app
// password when a refresh fails.

import { describe, expect, it } from "vitest";

import {
  AppPasswordSession,
  createRecordViaSession,
  type SessionEvent,
} from "./app-password-session.ts";

/** A fake JWT whose payload carries `exp` (seconds). Only the payload is read. */
function jwt(expSec: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSec }), "utf8").toString("base64url");
  return `h.${payload}.s`;
}

const PDS = "https://pds.test";
const DID = "did:plc:exchange";

function sessionResponse(accessExpSec: number, refresh = "r-new") {
  return new Response(
    JSON.stringify({ accessJwt: jwt(accessExpSec), refreshJwt: refresh, did: DID }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function setup(
  routes: Record<string, () => Response>,
  startMs = 1_000_000,
): {
  session: AppPasswordSession;
  events: SessionEvent[];
  calls: string[];
  setClock: (ms: number) => void;
} {
  const events: SessionEvent[] = [];
  const calls: string[] = [];
  let clock = startMs;
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    for (const key of Object.keys(routes)) {
      if (String(url).includes(key)) return routes[key]!();
    }
    return new Response("no route", { status: 404 });
  }) as unknown as typeof fetch;
  const session = new AppPasswordSession({
    identifier: "cocore.dev",
    appPassword: "app-pw-secret",
    did: DID,
    pdsEndpoint: PDS,
    fetchImpl,
    onEvent: (e) => events.push(e),
    log: () => {},
    now: () => clock,
  });
  return { session, events, calls, setClock: (ms) => (clock = ms) };
}

describe("AppPasswordSession", () => {
  it("mints a session from the app password on first use", async () => {
    const { session, events, calls } = setup({
      createSession: () => sessionResponse(1_000_000 / 1000 + 3600),
    });
    const token = await session.accessToken();
    expect(token).toBe(jwt(1_000_000 / 1000 + 3600));
    expect(events).toEqual(["created"]);
    expect(calls.some((c) => c.includes("createSession"))).toBe(true);
    expect(session.did()).toBe(DID);
  });

  it("reuses a healthy token, then refreshes proactively near expiry", async () => {
    const expSec = 1_000 + 3600; // base 1_000_000ms = 1_000s
    const { session, events, setClock } = setup(
      {
        createSession: () => sessionResponse(expSec),
        refreshSession: () => sessionResponse(expSec + 3600),
      },
      1_000_000,
    );

    const a = await session.accessToken();
    const b = await session.accessToken(); // still healthy → same token, no refresh
    expect(a).toBe(b);
    expect(events).toEqual(["created"]);

    // Move to 60s before expiry (inside the 120s skew) → must refresh.
    setClock((expSec - 60) * 1000);
    const c = await session.accessToken();
    expect(c).toBe(jwt(expSec + 3600));
    expect(events).toEqual(["created", "refreshed"]);
  });

  it("refreshes + retries once on a 401, then succeeds", async () => {
    let createRecordCalls = 0;
    const { session, events } = setup({
      createSession: () => sessionResponse(1_000 + 3600),
      refreshSession: () => sessionResponse(1_000 + 7200),
      "com.atproto.repo.createRecord": () => {
        createRecordCalls += 1;
        return createRecordCalls === 1
          ? new Response(JSON.stringify({ error: "ExpiredToken" }), { status: 401 })
          : new Response(JSON.stringify({ uri: "at://did:plc:exchange/c/r", cid: "bafy" }), {
              status: 200,
            });
      },
    });

    const out = await createRecordViaSession(session, {
      collection: "dev.cocore.compute.settlement",
      record: { hello: "world" },
    });
    expect(out).toEqual({ uri: "at://did:plc:exchange/c/r", cid: "bafy" });
    expect(createRecordCalls).toBe(2); // 401 then retry
    expect(events).toEqual(["created", "refreshed"]); // refreshed on the 401
  });

  it("re-creates from the app password when a refresh fails", async () => {
    const expSec = 1_000 + 3600;
    const { session, events, setClock } = setup({
      createSession: () => sessionResponse(expSec),
      refreshSession: () =>
        new Response(JSON.stringify({ error: "ExpiredToken" }), { status: 400 }),
    });

    await session.accessToken(); // initial create
    setClock((expSec - 60) * 1000); // force a refresh attempt
    const token = await session.accessToken();
    expect(token).toBe(jwt(expSec)); // re-created session
    expect(events).toEqual(["created", "refresh_failed", "created"]);
  });

  it("createRecordViaSession throws on a non-401 error", async () => {
    const { session } = setup({
      createSession: () => sessionResponse(1_000 + 3600),
      "com.atproto.repo.createRecord": () =>
        new Response(JSON.stringify({ error: "InvalidRecord" }), { status: 400 }),
    });
    await expect(
      createRecordViaSession(session, { collection: "dev.cocore.compute.settlement", record: {} }),
    ).rejects.toThrow(/createRecord .* returned 400/);
  });

  it("emits create_failed when the app password itself is rejected", async () => {
    const { session, events } = setup({
      createSession: () =>
        new Response(JSON.stringify({ error: "AuthFactorTokenRequired" }), { status: 401 }),
    });
    await expect(session.accessToken()).rejects.toThrow(/createSession 401/);
    expect(events).toEqual(["create_failed"]);
  });
});
