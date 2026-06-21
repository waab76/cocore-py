// Advisor — WebSocket matchmaker + minimal job dispatch.
//
// Surfaces in this build:
//   * `WS  /v1/agent`  — providers Register, Heartbeat, answer
//                        AttestationChallenges, and forward
//                        InferenceChunk / InferenceComplete back to
//                        whichever requester opened the dispatch.
//   * `GET /healthz`   — Railway healthcheck.
//   * `GET /providers` — debug list of who's online.
//   * `POST /jobs`     — Phase 2.5: requester submits a sealed
//                        prompt, advisor picks an attested provider,
//                        forwards `inference_request`, and streams
//                        chunks back as text/event-stream.
//
// State stays in-memory: ProviderRegistry tracks who's connected
// and live; SessionManager tracks who's awaiting an SSE relay.
// Both are lost on restart — providers reconnect automatically;
// in-flight requesters retry.

import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";

import { loadApnsConfig } from "./apns.ts";
import { handleConnection } from "./connection.ts";
import { handleJobsRequest } from "./jobs.ts";
import { KnownGoodSet } from "./known-good.ts";
import { ProviderRegistry } from "./registry.ts";
import { SessionManager } from "./sessions.ts";
import { TtftWindow } from "./ttft.ts";

const PORT = Number(process.env["PORT"] ?? process.env["COCORE_ADVISOR_PORT"] ?? 8082);
const HEARTBEAT_TIMEOUT_MS = Number(process.env["COCORE_ADVISOR_HEARTBEAT_TIMEOUT_MS"] ?? 90_000);
const SWEEP_INTERVAL_MS = Number(process.env["COCORE_ADVISOR_SWEEP_INTERVAL_MS"] ?? 30_000);
const RECHALLENGE_INTERVAL_MS = Number(
  process.env["COCORE_ADVISOR_RECHALLENGE_INTERVAL_MS"] ?? 5 * 60_000,
);
/** How long the advisor waits for the provider to answer a
 *  re-challenge before assuming the provider is wedged / offline /
 *  rooted-and-pretending-to-be-alive. On expiry the socket is
 *  closed with 1008 ("policy-violation") and the registry entry is
 *  marked unattested so any in-flight `pickFor` stops routing to
 *  them. The agent's `cocore agent serve` auto-reconnect will
 *  re-register and re-attest within seconds when this happens. */
const CHALLENGE_RESPONSE_TIMEOUT_MS = Number(
  process.env["COCORE_ADVISOR_CHALLENGE_RESPONSE_TIMEOUT_MS"] ?? 60_000,
);
/** Staleness floor passed to `pickFor` so a one-time-attested
 *  provider whose subsequent challenge responses get lost can't
 *  stay routable indefinitely if the socket-close hook somehow
 *  fails (e.g. the WS library swallowed an error). One full
 *  rechallenge round plus a generous buffer. */
const ATTESTATION_MAX_AGE_MS = RECHALLENGE_INTERVAL_MS + CHALLENGE_RESPONSE_TIMEOUT_MS + 30_000;
/** How long a dispatched job may go without ANY frame from the provider
 *  before the advisor gives up, returns a clean error to the requester,
 *  and flags the provider. Shorter than the old 60s: the chosen provider
 *  just answered a preflight ping, so a healthy one starts streaming
 *  within seconds — a 30s silence means it wedged after accepting, and we
 *  shouldn't make the requester wait a full minute to find out. */
const SESSION_IDLE_TIMEOUT_MS = Number(
  process.env["COCORE_ADVISOR_SESSION_IDLE_TIMEOUT_MS"] ?? 30_000,
);
/** Per-job preflight budget: how long to wait for the chosen provider to
 *  answer an app-level `ping` before failing over to the next candidate.
 *  A healthy serve loop answers in a few ms; this only needs to clear
 *  network RTT to the provider. */
const PREFLIGHT_TIMEOUT_MS = Number(process.env["COCORE_ADVISOR_PREFLIGHT_TIMEOUT_MS"] ?? 1500);
/** WS protocol-level ping cadence (see ConnectionConfig in
 *  connection.ts). Set UNDER Railway's edge idle cutoff (~45–60s of
 *  one-directional silence → the proxy reaps the socket with a `1006`,
 *  the dominant connection churn we measured: a 30–90s median lifetime).
 *  The advisor→provider direction otherwise carries only this ping, so a
 *  60s cadence left it idle long enough to be cut; 25s keeps both
 *  directions active (ping out + pong back) comfortably under the
 *  threshold. The old 60s value was chosen when a provider mid-inference
 *  couldn't pong — no longer true (it answers from its read half while
 *  inference runs on a blocking thread), and `WS_KEEPALIVE_MAX_MISSED`
 *  tolerance covers any brief stall. Set to 0 to disable. */
const WS_KEEPALIVE_INTERVAL_MS = Number(process.env["COCORE_ADVISOR_WS_KEEPALIVE_MS"] ?? 25_000);
/** Consecutive missed pongs before a socket is reaped as dead. >1 so the
 *  frequent keepalive ping can't terminate a provider over a momentary
 *  stall — ~2–3× the ping interval of slack (~50–75s at 25s). */
const WS_KEEPALIVE_MAX_MISSED = Number(process.env["COCORE_ADVISOR_WS_KEEPALIVE_MAX_MISSED"] ?? 2);
/** Proactively recycle a connection this long after it opens, with a
 *  clean close. Railway hard-caps connection duration at ~15 min and cuts
 *  with an abrupt `1006`; closing cleanly a bit under that lets the
 *  provider reconnect on its graceful, backoff-resetting path instead.
 *  Set to 0 to disable (rely on the edge cap). */
const WS_MAX_CONNECTION_MS = Number(process.env["COCORE_ADVISOR_WS_MAX_CONNECTION_MS"] ?? 840_000);
/** How often to re-probe machines currently in bad standing, to detect that
 *  one has self-righted and restore it to routing. Short so a recovered
 *  machine — especially the only one serving a model — rejoins within
 *  seconds, but not so tight that we hammer a wedged box. */
const REPROBE_INTERVAL_MS = Number(process.env["COCORE_ADVISOR_REPROBE_INTERVAL_MS"] ?? 5_000);
/** Per-machine budget for a recovery re-probe ping. Same shape as the job
 *  preflight: a healthy serve loop answers in a few ms; this only needs to
 *  clear network RTT. */
const REPROBE_TIMEOUT_MS = Number(process.env["COCORE_ADVISOR_REPROBE_TIMEOUT_MS"] ?? 1500);
/** How many recent jobs the time-to-first-token window keeps. Matches the
 *  "last 100 jobs" the console headline advertises. */
const TTFT_WINDOW_SAMPLES = Number(process.env["COCORE_ADVISOR_TTFT_SAMPLES"] ?? 100);

async function main(): Promise<void> {
  // APNs code-identity sender config (APNS_AUTH_KEY/KEY_ID/TEAM_ID/TOPIC).
  // Null when unset → the code-identity challenge is disabled AND confidential
  // eligibility is NOT gated on it (pre-APNs behavior, no hard cutover at
  // rollout). When present, the registry enforces code-attestation and the
  // connection handler issues challenges.
  const apnsConfig = loadApnsConfig();
  if (apnsConfig) {
    console.error(`[advisor] APNs code-identity enabled topic=${apnsConfig.topic}`);
  } else {
    console.error("[advisor] APNs code-identity disabled (APNS_* env not set)");
  }
  // Known-good build set for confidential-tier routing hints (WS-COORDINATOR).
  // Empty unless COCORE_KNOWN_GOOD_CDHASHES is set → fail-closed (no machine is
  // advertised confidential-eligible until a blessed-build set is configured).
  const registry = new ProviderRegistry(KnownGoodSet.fromEnv(), apnsConfig !== null);
  // Rolling time-to-first-token window (received → first chunk relayed),
  // surfaced at GET /ttft for the console's public latency stat.
  const ttft = new TtftWindow(TTFT_WINDOW_SAMPLES);
  const sessions = new SessionManager({
    idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS,
    onFirstChunk: (ms) => ttft.record(ms),
    // A machine that accepted a job and then went silent is in bad
    // standing: stop routing to it, tell it so (red tray ping), and ask it
    // to self-right now.
    onIdleTimeout: (providerDid, providerMachineId) => {
      registry.markUnhealthy(providerDid, providerMachineId, "job-idle-timeout");
      try {
        const entry = registry.get(providerDid, providerMachineId);
        entry?.send({ type: "health_notice", standing: "bad", reason: "job-idle-timeout" });
        entry?.send({ type: "recover_request", reason: "job-idle-timeout" });
      } catch {
        // socket gone; the sweeper will evict it
      }
      console.error(
        `[sessions] idle-timeout did=${providerDid} machine=${providerMachineId}; marked unhealthy, requested self-right`,
      );
    },
  });

  // --- HTTP face -------------------------------------------------
  const http = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/healthz") {
      return json(res, 200, { ok: true, providers: registry.size(), sessions: sessions.size() });
    }
    if (url.pathname === "/ttft" && req.method === "GET") {
      // Time-to-first-token over the last ~100 jobs (received → first
      // chunk relayed). The honest "latency" headline — distinct from a
      // receipt's completedAt − startedAt (total generation time).
      return json(res, 200, ttft.stats());
    }
    if (url.pathname === "/providers" && req.method === "GET") {
      return json(
        res,
        200,
        registry.list().map((p) => ({
          did: p.did,
          // Per-machine identity (the agent's provider-record rkey). The
          // console joins live standing onto its fleet UI by this. A DID can
          // now appear in multiple rows — one per connected machine.
          machineId: p.machineId,
          machineLabel: p.machineLabel,
          chip: p.chip,
          ramGb: p.ramGb,
          supportedModels: p.supportedModels,
          encryptionPubKey: p.encryptionPubKey,
          attestationUri: p.attestationUri,
          lastSeen: new Date(p.lastSeen).toISOString(),
          attestedAt: p.attestedAt ? new Date(p.attestedAt).toISOString() : null,
          engineFault: p.engineFault,
          // Latest content-free crash signature (null until the machine
          // reports one) — lets an operator spot a flapping machine. A high
          // `count` is what excludes it from routing.
          crash: p.crash,
          // Owner's start/stop switch (from heartbeats) + whether bad
          // standing took it out of routing, and why — handy for debugging
          // "why isn't this machine getting jobs".
          active: p.active,
          unhealthy: p.unhealthyAt !== null,
          unhealthyReason: p.unhealthyReason,
          // Machine has been handed jobs but produced no completions —
          // it's failing silently (vs. openly crash-looping).
          silentFailure: p.silentFailure,
          // Confidential-tier routing hint (WS-COORDINATOR). `trustTier` is what
          // the advisor computed; `cdHash` is the measured identity it checked.
          trustTier: p.confidentialEligible ? "attested-confidential" : "best-effort",
          confidentialEligible: p.confidentialEligible,
          cdHash: p.cdHash,
          challengeVerifiedSip: p.challengeVerifiedSip,
          // APNs code-identity: whether this machine answered a live, AMFI-gated
          // code-identity challenge (the un-forgeable complement to cdHash).
          codeAttested: p.codeAttested,
        })),
      );
    }
    if (url.pathname === "/verified-providers" && req.method === "GET") {
      // Read-only feed of confidential-eligible machines (accelerator over the
      // providers' signed PDS attestations — a requester still re-verifies the
      // attestation at seal time before trusting the tier).
      return json(
        res,
        200,
        registry.listConfidential().map((p) => ({
          did: p.did,
          machineId: p.machineId,
          machineLabel: p.machineLabel,
          chip: p.chip,
          supportedModels: p.supportedModels,
          encryptionPubKey: p.encryptionPubKey,
          attestationUri: p.attestationUri,
          cdHash: p.cdHash,
          trustTier: "attested-confidential",
          attestedAt: p.attestedAt ? new Date(p.attestedAt).toISOString() : null,
        })),
      );
    }
    if (url.pathname === "/control" && req.method === "POST") {
      // The console calls this to relay an unprivileged nudge to an owner's
      // machine(s):
      //   action "re-read-active" (default) — after flipping the `active`
      //     switch on the PDS, so a start/stop takes effect in ~a second
      //     instead of at the next 30s poll.
      //   action "self-right" — the owner clicked "Try to recover" on an
      //     unhealthy machine; ask the agent to run its recovery now.
      // Either carries NO authority — the agent re-reads / re-checks its own
      // authoritative state — so this stays an unprivileged relay. Targets a
      // single machine when `machineId` is given, else every machine under
      // the DID.
      void (async () => {
        let body: unknown;
        try {
          body = await readJson(req);
        } catch {
          return json(res, 400, { error: "invalid JSON body" });
        }
        const b = body as { did?: unknown; machineId?: unknown; action?: unknown };
        const did = b.did;
        if (typeof did !== "string" || did.length === 0) {
          return json(res, 400, { error: "did required" });
        }
        if (b.machineId !== undefined && typeof b.machineId !== "string") {
          return json(res, 400, { error: "machineId must be a string when provided" });
        }
        const action = b.action ?? "re-read-active";
        if (action !== "re-read-active" && action !== "self-right") {
          return json(res, 400, { error: "action must be 're-read-active' or 'self-right'" });
        }
        const targets =
          typeof b.machineId === "string"
            ? [registry.get(did, b.machineId)].filter((e): e is NonNullable<typeof e> => !!e)
            : registry.getMachines(did);
        if (targets.length === 0) return json(res, 404, { error: "provider not connected" });
        let delivered = 0;
        for (const entry of targets) {
          try {
            entry.send(
              action === "self-right"
                ? { type: "recover_request", reason: "console-requested" }
                : { type: "control_changed" },
            );
            delivered += 1;
          } catch {
            // socket already gone; the sweeper will evict it
          }
        }
        return json(res, 200, { ok: true, delivered });
      })();
      return;
    }
    if (url.pathname === "/jobs" && req.method === "POST") {
      void handleJobsRequest(req, res, {
        registry,
        sessions,
        generateId: () => randomUUID(),
        attestationMaxAgeMs: ATTESTATION_MAX_AGE_MS,
        preflightTimeoutMs: PREFLIGHT_TIMEOUT_MS,
      }).catch((e) => {
        console.error(`[jobs] handler error: ${(e as Error).message}`);
        if (!res.headersSent) {
          json(res, 500, { error: "internal error" });
        }
      });
      return;
    }
    json(res, 404, { error: "no such route" });
  });

  // Node defaults `requestTimeout` to 300_000ms (Node 18+): the timer
  // armed on the upgrade GET can fire and destroy an upgraded WebSocket /
  // a long-lived `/jobs` SSE that runs past 5 minutes. Disable it — this
  // is a long-poll/stream-heavy service, not a public form handler, and
  // the WS keepalive + idle handling above is what bounds dead sockets.
  http.requestTimeout = 0;

  // --- WebSocket /v1/agent --------------------------------------
  // `perMessageDeflate: false`: compression is useless on our frames
  // (heartbeats + sealed/random-looking ciphertext don't compress) and
  // its sliding window desyncs through Railway's proxy as `TCP_OVERWIN`,
  // a documented cause of dropped WS connections. Off = one fewer way for
  // the edge to sever us.
  const wss = new WebSocketServer({
    server: http,
    path: "/v1/agent",
    perMessageDeflate: false,
  });
  wss.on("connection", (socket, req) =>
    handleConnection(socket, req, registry, sessions, {
      rechallengeIntervalMs: RECHALLENGE_INTERVAL_MS,
      responseTimeoutMs: CHALLENGE_RESPONSE_TIMEOUT_MS,
      keepaliveIntervalMs: WS_KEEPALIVE_INTERVAL_MS,
      keepaliveMaxMissed: WS_KEEPALIVE_MAX_MISSED,
      maxConnectionMs: WS_MAX_CONNECTION_MS,
      apns: apnsConfig,
    }),
  );

  // --- Janitor: evict machines we haven't heard from ------------
  const sweeper = setInterval(() => {
    const evicted = registry.sweep(HEARTBEAT_TIMEOUT_MS);
    for (const { did, machineId } of evicted) {
      console.error(`[sweeper] evicted stale machine did=${did} machine=${machineId}`);
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  // --- Re-prober: auto-restore machines that have self-righted --
  // An unhealthy machine is EXCLUDED from routing, so it can't earn its
  // standing back through normal job traffic. Ping each excluded machine on
  // a short cadence; a machine whose serve loop is pumping again answers,
  // and we clear its bad standing so it rejoins the pool. (recordCompletion
  // and a fresh register also clear it; this covers the machine that
  // self-righted without re-registering and without a job to complete.)
  const reprober = setInterval(() => {
    for (const m of registry.listUnhealthy()) {
      void m
        .ping(REPROBE_TIMEOUT_MS)
        .then((alive) => {
          if (alive) {
            registry.markHealthy(m.did, m.machineId);
            try {
              m.send({ type: "health_notice", standing: "ok" });
            } catch {
              // socket gone; close hook will clean up
            }
            console.error(
              `[reprober] recovered did=${m.did} machine=${m.machineId}; restored to routing`,
            );
          }
        })
        .catch(() => {
          // still wedged / socket gone — leave it excluded
        });
    }
  }, REPROBE_INTERVAL_MS);
  reprober.unref();

  await new Promise<void>((r) => http.listen(PORT, r));
  console.error(
    `advisor: http+ws on :${PORT} (heartbeat-timeout=${HEARTBEAT_TIMEOUT_MS}ms, rechallenge=${RECHALLENGE_INTERVAL_MS}ms, challenge-response-timeout=${CHALLENGE_RESPONSE_TIMEOUT_MS}ms, attestation-max-age=${ATTESTATION_MAX_AGE_MS}ms, ws-keepalive=${WS_KEEPALIVE_INTERVAL_MS}ms, ws-keepalive-max-missed=${WS_KEEPALIVE_MAX_MISSED}, ws-max-connection=${WS_MAX_CONNECTION_MS}ms, perMessageDeflate=off)`,
  );
  console.error(
    "advisor: WS connection-stability config tuned for Railway's edge (frequent keepalive under the idle cutoff, compression off, proactive recycle under the 15-min cap)",
  );
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** `/control` carries only a DID; 64 KiB is generous. Caps an
 *  unauthenticated endpoint against memory-exhaustion. */
const MAX_CONTROL_BODY_BYTES = 64 * 1024;

async function readJson(req: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > MAX_CONTROL_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_CONTROL_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown;
}

main().catch((e) => {
  console.error("advisor: fatal", e);
  process.exit(1);
});
