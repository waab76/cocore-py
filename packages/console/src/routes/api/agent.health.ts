// GET /api/agent/health
//
// Bearer-key authed cross-system diagnosis for an installed cocore
// agent. The provider's `cocore agent doctor` calls this and prints
// the result; the /machines page can also surface the diagnosis as a
// status badge. Combines three signals about the caller's DID:
//
//   1. AppView's index of the user's PDS — does a fresh
//      `dev.cocore.compute.provider` record exist?
//   2. Advisor's live wire state — is the agent's daemon currently
//      connected and attested?
//   3. Time skew between the two — heartbeats / publishes that are
//      "old" indicate a half-broken state even when both sides
//      report a presence.
//
// Diagnosis values:
//   * `healthy` — advisor sees us, PDS has a fresh provider record.
//   * `publishing-failing` — advisor sees us, but no provider record
//     on PDS (or the latest one predates the most recent attestation).
//     Smoking gun for the API-key-401 case after wipe-my-data drops
//     the agent's key. Hint says "run `cocore agent pair` to mint a
//     fresh key, then `cocore agent doctor --fix`."
//   * `agent-offline` — PDS has a recent provider record but advisor
//     doesn't see us. Daemon stopped or crashed.
//   * `stale` — both present but the latest signal is older than 30
//     min. Could be transient (Wi-Fi flap), could be the start of a
//     real outage. Hint asks the user to check `agent doctor` again
//     in a minute.
//   * `never-paired` — neither advisor nor PDS knows this DID.
//     Either the agent has never run, or the user wiped + never
//     re-paired.
//
// Auth: same Bearer-key flow as the proxy. The DID we report on is
// the DID owning the key — the agent has no way to ask about
// somebody else's machine.

import { createFileRoute } from "@tanstack/react-router";

import { resolveBearerKey } from "@/lib/api-keys.server.ts";
import { cocoreConfig } from "@/lib/cocore-config.ts";

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

interface AdvisorProvider {
  did: string;
  machineLabel?: string;
  lastSeen?: string;
  attestedAt?: string;
}

interface AppViewIndexedRow {
  uri: string;
  cid: string;
  collection: string;
  repo: string;
  rkey: string;
  body: Record<string, unknown>;
}

async function fetchJson<T>(url: string, timeoutMs = 4000): Promise<T | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// "Fresh enough" cutoffs. The advisor's heartbeat timeout default is
// 90s; we treat anything within 5min as live. PDS records ~never
// change (no heartbeat there) so we only flag them when there's no
// record at all, not when they're old.
const ADVISOR_FRESH_MS = 5 * 60 * 1000;

interface HealthResponse {
  did: string;
  advisor: {
    online: boolean;
    lastSeen: string | null;
    attestedAt: string | null;
    machineLabel: string | null;
  };
  pds: {
    providerRecord: { uri: string; createdAt: string; machineLabel: string } | null;
    attestationRecord: { uri: string; createdAt: string } | null;
  };
  diagnosis: "healthy" | "publishing-failing" | "agent-offline" | "stale" | "never-paired";
  hint: string;
  checkedAt: string;
}

function diagnose(input: {
  advisorOnline: boolean;
  advisorLastSeenMs: number | null;
  pdsHasProvider: boolean;
}): { diagnosis: HealthResponse["diagnosis"]; hint: string } {
  const now = Date.now();
  const advisorFresh =
    input.advisorOnline &&
    input.advisorLastSeenMs !== null &&
    now - input.advisorLastSeenMs < ADVISOR_FRESH_MS;

  if (!input.advisorOnline && !input.pdsHasProvider) {
    return {
      diagnosis: "never-paired",
      hint: "No agent has run under this DID. Install with `curl -fsSL console.cocore.dev/agent | sh`, then `cocore agent pair`.",
    };
  }
  if (advisorFresh && input.pdsHasProvider) {
    return {
      diagnosis: "healthy",
      hint: "Agent is connected to advisor and your provider record is published. You're good.",
    };
  }
  if (advisorFresh && !input.pdsHasProvider) {
    return {
      diagnosis: "publishing-failing",
      hint: "Advisor sees your agent, but no provider record on your PDS. Most common cause: your API key was invalidated (wipe-my-data drops it). Run `cocore agent pair` to mint a fresh key — that will also bounce the daemon so the next publish succeeds.",
    };
  }
  if (!input.advisorOnline && input.pdsHasProvider) {
    return {
      diagnosis: "agent-offline",
      hint: "PDS has a provider record but advisor doesn't see you. The serve daemon stopped. On macOS: `launchctl print gui/$(id -u)/dev.cocore.provider` to check, then `launchctl kickstart -k gui/$(id -u)/dev.cocore.provider` to restart.",
    };
  }
  // Both partially present — likely a transient flap.
  return {
    diagnosis: "stale",
    hint: "Mixed signals. Wait 60s and re-run `cocore agent doctor`; if still stale, run `cocore agent pair` and then `cocore agent doctor --fix`.",
  };
}

async function loadAdvisorState(did: string): Promise<{
  online: boolean;
  lastSeen: string | null;
  attestedAt: string | null;
  machineLabel: string | null;
}> {
  const advisorBase = cocoreConfig().advisorUrl?.replace(/\/$/, "");
  if (!advisorBase) return { online: false, lastSeen: null, attestedAt: null, machineLabel: null };
  const list = await fetchJson<AdvisorProvider[]>(`${advisorBase}/providers`);
  if (!list) return { online: false, lastSeen: null, attestedAt: null, machineLabel: null };
  const me = list.find((p) => p.did === did);
  if (!me) return { online: false, lastSeen: null, attestedAt: null, machineLabel: null };
  return {
    online: true,
    lastSeen: me.lastSeen ?? null,
    attestedAt: me.attestedAt ?? null,
    machineLabel: me.machineLabel ?? null,
  };
}

async function loadPdsState(did: string): Promise<{
  providerRecord: HealthResponse["pds"]["providerRecord"];
  attestationRecord: HealthResponse["pds"]["attestationRecord"];
}> {
  const appviewBase = cocoreConfig().appviewUrl?.replace(/\/$/, "");
  if (!appviewBase) return { providerRecord: null, attestationRecord: null };
  const providers = await fetchJson<{ providers: AppViewIndexedRow[] }>(
    `${appviewBase}/xrpc/dev.cocore.compute.listProviders`,
  );
  let providerRecord: HealthResponse["pds"]["providerRecord"] = null;
  if (providers?.providers) {
    const mine = providers.providers
      .filter((r) => r.repo === did)
      .sort((a, b) => {
        const ac = String(a.body?.["createdAt"] ?? "");
        const bc = String(b.body?.["createdAt"] ?? "");
        return bc.localeCompare(ac);
      });
    const top = mine[0];
    if (top) {
      providerRecord = {
        uri: top.uri,
        createdAt: String(top.body?.["createdAt"] ?? ""),
        machineLabel: String(top.body?.["machineLabel"] ?? ""),
      };
    }
  }
  // Attestation listing isn't on the AppView's existing public surface;
  // a missing provider record is the dominant signal we care about, so
  // attestationRecord stays null for now. A follow-up can add a
  // dev.cocore.appview.listAttestations route if useful.
  return { providerRecord, attestationRecord: null };
}

export const Route = createFileRoute("/api/agent/health")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const bearer = readBearer(request);
        if (!bearer) return jsonError(401, "missing Authorization: Bearer header");
        const resolved = resolveBearerKey(bearer);
        if (!resolved) return jsonError(401, "invalid API key");

        const [advisor, pds] = await Promise.all([
          loadAdvisorState(resolved.did),
          loadPdsState(resolved.did),
        ]);

        const advisorLastSeenMs = advisor.lastSeen ? Date.parse(advisor.lastSeen) : null;
        const { diagnosis, hint } = diagnose({
          advisorOnline: advisor.online,
          advisorLastSeenMs: Number.isFinite(advisorLastSeenMs) ? advisorLastSeenMs : null,
          pdsHasProvider: pds.providerRecord !== null,
        });

        const body: HealthResponse = {
          did: resolved.did,
          advisor,
          pds,
          diagnosis,
          hint,
          checkedAt: new Date().toISOString(),
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  },
});
