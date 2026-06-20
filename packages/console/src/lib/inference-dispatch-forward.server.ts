// Forward an inference dispatch to the AppView's SSE XRPC endpoint.
//
// The dispatch core now lives on the AppView (it owns the requester's
// OAuth session via login handoff and the indexed Store for credit
// lookups). The console keeps only a thin forwarder: it mints a
// service-auth JWT from the signed-in user's OAuth session
// (com.atproto.server.getServiceAuth, bound to this method) so the AppView
// can verify the requester's DID, then proxies the AppView's
// text/event-stream response straight back to the browser.
//
// Gated on configuration: when COCORE_APPVIEW_INTERNAL_URL +
// COCORE_APPVIEW_DID are set, callers forward; otherwise they fall back to
// the console's own in-process runDispatch (legacy). A deploy without the
// env behaves exactly as before.

import type { OAuthSession } from "@atcute/oauth-node-client";

const LXM = "dev.cocore.inference.dispatch";

function appviewBase(): string | null {
  return process.env["COCORE_APPVIEW_INTERNAL_URL"]?.replace(/\/$/, "") || null;
}

/** True when dispatch should be forwarded to the AppView. */
export function isDispatchForwardConfigured(): boolean {
  return Boolean(appviewBase() && process.env["COCORE_APPVIEW_DID"]);
}

function sseError(reason: string, code: string, status: number): Response {
  // The browser consumes SSE; surface failures as an `error` frame (rather
  // than a JSON body) so the client's existing event handling reports them.
  return new Response(`event: error\ndata: ${JSON.stringify({ reason, code })}\n\n`, {
    status,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** Mint a service-auth JWT for the user, POST the dispatch to the AppView,
 *  and return its streamed SSE response verbatim. `body` is the validated
 *  dispatch payload (model/prompt/maxTokensOut/priceCeiling/targetProviderDid). */
export async function forwardDispatch(args: {
  oauthSession: OAuthSession;
  body: Record<string, unknown>;
}): Promise<Response> {
  const base = appviewBase();
  const appviewDid = process.env["COCORE_APPVIEW_DID"];
  if (!base || !appviewDid) throw new Error("dispatch forward not configured");

  let token: string;
  try {
    const r = await args.oauthSession.handle(
      `/xrpc/com.atproto.server.getServiceAuth?aud=${encodeURIComponent(appviewDid)}&lxm=${LXM}`,
      { method: "GET" },
    );
    if (!r.ok) return sseError(`getServiceAuth returned ${r.status}`, "advisor-transport", 502);
    token = ((await r.json()) as { token: string }).token;
  } catch (e) {
    return sseError(`service-auth mint failed: ${(e as Error).message}`, "advisor-transport", 502);
  }

  const upstream = await fetch(`${base}/xrpc/${LXM}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args.body),
  });

  // A non-stream error (auth/validation) comes back as JSON; translate it to
  // an SSE error frame so the browser's stream reader handles it uniformly.
  const ct = upstream.headers.get("content-type") ?? "";
  if (!ct.includes("text/event-stream")) {
    const text = await upstream.text().catch(() => "");
    let reason = text.slice(0, 300) || `appview dispatch returned ${upstream.status}`;
    try {
      const j = JSON.parse(text) as { message?: string; error?: string };
      reason = j.message || j.error || reason;
    } catch {
      /* keep raw text */
    }
    return sseError(reason, "advisor-transport", upstream.status === 401 ? 401 : 502);
  }

  // Pipe the AppView's event-stream straight through to the browser.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
