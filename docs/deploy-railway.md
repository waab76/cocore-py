# Deploying cocore to Railway

This is the production deployment recipe for the three services that
make `cocore` usable end-to-end:

- **services** — the Node bridge + AppView indexer + AppView read API +
  exchange (all in one process; see [infra/services](../infra/services)).
- **console** — the TanStack Start UI + ATProto OAuth pair endpoints
  (see [packages/console](../packages/console)).
- **advisor** — the WebSocket matchmaker the provider's `serve`
  connects to (see [infra/advisor](../infra/advisor)). v0 accepts
  registrations, runs attestation challenges, and tracks heartbeats;
  inference dispatch is Phase 2.5.

## Prereqs

- Railway account with a payment method on file.
- A project. Either create one in the Railway dashboard or take an
  existing one. This recipe is project-token-friendly — no full
  account access required.
- `railway` CLI installed locally (`brew install railway`).
- A project-scoped Railway token (Project → Settings → Tokens).

## One-time project setup

```bash
export RAILWAY_TOKEN=<project-scoped-token>

# Two empty services. Keep the names short — they show up in the
# Railway-internal hostname (services.railway.internal,
# console.railway.internal).
railway add --service services
railway add --service console
```

## Configure the services service

Build args + runtime env. SQLite lives on a Railway volume so
restarts don't lose AppView state.

```bash
railway variables --service services \
  --set "RAILWAY_DOCKERFILE_PATH=infra/Dockerfile.node" \
  --set "COCORE_DB=/data/appview.db" \
  --set "COCORE_AUTORESPOND=1" \
  --set "COCORE_BRIDGE_PORT=8080" \
  --set "COCORE_APPVIEW_PORT=8081" \
  --set "COCORE_EXCHANGE_DID=did:web:exchange.cocore.dev"
```

Volume — Railway CLI's `volume add` doesn't take `--service`, so use
the GraphQL API. Replace the IDs with values from
`railway status` / `railway service list --json`.

```bash
curl -sS -X POST https://backboard.railway.com/graphql/v2 \
  -H "Project-Access-Token: $RAILWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"mutation { volumeCreate(input: { projectId: \"<PROJECT_ID>\", environmentId: \"<ENVIRONMENT_ID>\", serviceId: \"<SERVICES_SERVICE_ID>\", mountPath: \"/data\" }) { id name } }"}'
```

## Configure the console service

```bash
railway variables --service console \
  --set "RAILWAY_DOCKERFILE_PATH=packages/console/Dockerfile" \
  --set "CONSOLE_PUBLIC_URL=https://console.cocore.dev" \
  --set "COCORE_BRIDGE_URL=http://services.railway.internal:8080" \
  --set "COCORE_APPVIEW_URL=http://services.railway.internal:8081" \
  --set "COCORE_EXCHANGE_DID=did:web:exchange.cocore.dev" \
  --set "PORT=3000"

# ATProto OAuth client signing key (DPoP). Required for any non-localhost
# CONSOLE_PUBLIC_URL — without it `/login` returns
# "ATPROTO_PRIVATE_KEY_JWK environment variable is required for non-local
# OAuth clients." The matching public JWK is auto-derived and served at
# /api/auth/atproto/metadata.json; you do NOT publish the public half
# manually.
railway variables --service console \
  --set "ATPROTO_PRIVATE_KEY_JWK=$(./scripts/generate-atproto-jwk.sh)"

# Token used by the `/agent/version` and `/agent/dl` proxy routes
# (packages/console/src/lib/github-releases.server.ts) to read
# release metadata + stream the prebuilt tarball from a private
# GitHub repo. A fine-grained PAT scoped to `Contents: Read` on
# the cocore repo is the right shape; a classic `repo`-scoped PAT
# also works. Without it, `curl https://console.cocore.dev/agent | sh`
# fails at the version lookup with a clear 503.
railway variables --service console \
  --set "GITHUB_TOKEN=$(gh auth token)"   # or paste a dedicated PAT
```

API key storage. The console keeps user-issued API keys in a SQLite
DB so the OpenAI-compat endpoint at `/api/v1/chat/completions` can
authenticate Bearer tokens. Mount a Railway volume on the console
service and point `COCORE_CONSOLE_DB` at a path on it — without a
volume the DB lives on the ephemeral container filesystem and every
deploy invalidates every issued key.

```bash
railway variables --service console \
  --set "COCORE_CONSOLE_DB=/data/console.db"
# Mount a volume at /data on the console service (same GraphQL
# pattern as the services volume above, with a different serviceId).
# Alternatively, attach any Railway volume and the path resolver
# auto-detects it via $RAILWAY_VOLUME_MOUNT_PATH (no env var needed).
```

The console reaches the services container over Railway's private
network (`*.railway.internal`); we don't expose `services` publicly.

### Internal API key (exchange ↔ console)

cocore is a closed-loop credit system — there is no payments provider to
configure (the Stripe integration was removed in the closed-loop pivot).

The exchange ↔ console internal endpoints (e.g.
`/api/internal/disputes/resolve`, `/api/internal/wipe`) are guarded by a
shared secret. Generate one and set it on BOTH services:

```bash
KEY=$(openssl rand -hex 32)
railway variables --service console  --set "COCORE_INTERNAL_API_KEY=$KEY"
railway variables --service services --set "COCORE_INTERNAL_API_KEY=$KEY"
```

## Configure the advisor service

```bash
railway variables --service advisor \
  --set "RAILWAY_DOCKERFILE_PATH=infra/Dockerfile.node" \
  --set "WORKSPACE=infra/advisor" \
  --set "PORT=8082" \
  --set "COCORE_ADVISOR_HEARTBEAT_TIMEOUT_MS=90000" \
  --set "COCORE_ADVISOR_RECHALLENGE_INTERVAL_MS=300000"
```

The advisor reuses [infra/Dockerfile.node](../infra/Dockerfile.node) —
the `WORKSPACE` env var is picked up as a Docker build ARG and
selects the workspace to run. Registry/session state stays in-memory
(providers reconnect after restart) — but the rolling **latency
windows** (`/ack`, `/ttft`) are otherwise lost on restart too, which
leaves the public "time to ack" headline blank ("—") until jobs flow
again.

To keep that headline populated across redeploys, attach a Railway
volume to the advisor (same GraphQL pattern as the `services` volume
above, with the advisor's `serviceId`). The advisor auto-detects it
via `$RAILWAY_VOLUME_MOUNT_PATH` and persists the windows under an
`advisor/` subdir — on the next boot it hydrates them and serves the
last known figures (flagged `cached`) until live traffic refills the
window. Override the location with `COCORE_ADVISOR_DATA_DIR=/some/path`
and the flush cadence with `COCORE_ADVISOR_LATENCY_PERSIST_INTERVAL_MS`
(default 30000). Without a volume the advisor runs exactly as before
(in-memory, blank headline after a restart).

## Deploy

From the repo root, with the working tree clean:

```bash
railway up --service services --ci --json --message "deploy"
railway up --service console  --ci --json --message "deploy"
railway up --service advisor  --ci --json --message "deploy"
```

`railway up` uploads the working directory (respecting `.gitignore`)
and uses Railway's BuildKit with the per-service `RAILWAY_DOCKERFILE_PATH`.
**Important**: run from the repo root, not from the workspace dir
— `railway up` only ships the current dir, so running it from
`infra/advisor/` would skip everything the Dockerfile needs to copy
in (`packages/`, `infra/Dockerfile.node`, lockfile, etc.).

## Custom domains

Add custom domains to the console + advisor services via the Railway
dashboard or GraphQL. Railway returns a CNAME target like
`<random>.up.railway.app` per service; add the matching CNAMEs at
your registrar for `cocore.dev`:

| Subdomain | Service (target port) | Notes |
|---|---|---|
| `console.cocore.dev` | console | the requester UI + OAuth pair endpoints |
| `advisor.cocore.dev` | advisor | `wss://advisor.cocore.dev/v1/agent` is what `cocore agent serve` connects to |
| `services.cocore.dev` | services (bridge `:8080`) | admin/reconcile + bridge xrpc; the launch-runbook `SERVICES` var |
| `appview.cocore.dev` | services (appview `:8081`) | public AppView xrpc for external receipt/attestation verification (`GET /xrpc/dev.cocore.appview.*`) |

Railway issues a DISTINCT CNAME target per custom domain (e.g.
`9pb4ua6u.up.railway.app` for `services.cocore.dev`, `avjh8yxu.up.railway.app`
for `appview.cocore.dev`) — point each subdomain's CNAME at its own target,
NOT at the generic `*-production-*.up.railway.app` service domain, or cert
issuance won't validate. The services service exposes two ports, so it carries
two custom domains (bridge on `:8080`, AppView on `:8081`).

Each custom domain ALSO needs a TXT ownership record — `_railway-verify.<sub>`
= `railway-verify=<token>` (from "Show DNS records" on the domain in the
Railway dashboard). The edge returns `404 "Application not found"` for a domain
whose CNAME+cert are valid but whose TXT isn't yet verified — add BOTH records.
And note: EDITING an existing CNAME (vs. adding a fresh one) means resolvers
serve the old target until its prior TTL expires, so an edited domain can lag a
brand-new one by hours — keep these records' TTL low (~300s).

NOTE: the public domains are for external/ops access only. Console↔services
traffic stays on Railway PRIVATE networking (`COCORE_BRIDGE_URL` /
`COCORE_APPVIEW_URL` → `services.railway.internal:8080` / `:8081`) — never
route it through the public edge (slower + subject to edge connection churn).

## Verify

- `https://console.cocore.dev/` — TanStack Start app loads.
- `POST https://console.cocore.dev/api/xrpc/dev.cocore.devicePair.start` —
  returns `{deviceId, userCode, verificationUri, ...}`.
- `https://advisor.cocore.dev/healthz` — returns `{"ok":true,"providers":N}`.
- `https://advisor.cocore.dev/providers` — returns the JSON list of
  currently-connected provider DIDs + their declared capabilities and
  last-seen timestamps.
- From a paired Mac:
  `~/.local/bin/cocore agent pair --console https://console.cocore.dev` —
  prints a code, waits for OAuth approval in the browser, persists the
  session.
- `~/.local/bin/cocore agent serve --advisor wss://advisor.cocore.dev/v1/agent`
  on a paired Mac connects, registers, passes an attestation challenge,
  and stays open on heartbeats. After it's running,
  `curl https://advisor.cocore.dev/providers` should show that DID.
- `scripts/dispatch-job.sh "your prompt"` posts a sealed prompt to
  `/jobs` and streams the SSE chunks back, decrypting each one. Any
  paired+attested provider visible in `/providers` will pick it up
  and reply with the Phase 2.5 stub response.

## Notes worth knowing

- **Railway private-networking migrations can strand containers** —
  Railway periodically migrates projects to new private-networking
  stacks (the legacy mesh was IPv6 `fd…`; the newer one hands out
  `100.64.0.0/10` addresses). Containers only join the new mesh when
  they restart, so if Railway restarts one service (you'll see a
  fresh "Mounting volume / Starting Container" in its log) while its
  peers keep running month-old containers, cross-service calls over
  `*.railway.internal` start failing even though both processes are
  healthy. Incident signature:
  - console logs `AppviewFetchError: fetch failed … GET
    http://services.railway.internal:8081/…` (the client now includes
    the target URL + the syscall code, e.g. `ENOTFOUND`/`ETIMEDOUT`),
    while the services log shows the exchange/reconcile loops running
    fine;
  - advisor WS peers churn with `close … code=1006` from rotating
    `100.64.0.x` ingress IPs.

  Remedy: redeploy (or restart) **all** services so they land on the
  same network generation — `railway up --service services|console|advisor`
  from the repo root. Verify by loading `/models` on the console.
- **Vite preview's `allowedHosts`** — the console serves through
  `vite preview` in production. We allow `.cocore.dev` and
  `.railway.app` in [packages/console/vite.config.ts](../packages/console/vite.config.ts).
  Add more hosts via the `CONSOLE_ALLOWED_HOSTS` env var
  (comma-separated) without touching the config.
- **Lockfile drift** — the Dockerfiles run `aube install --frozen-lockfile`.
  If `aube install` locally produces a non-trivial diff to
  `pnpm-lock.yaml`, the deploy will fail with `lockfile is out of date
  with package.json`. Commit the regenerated lockfile.
- **SQLite + replicas** — `services` uses SQLite via the volume, which
  caps it to one replica. Switch to Postgres before scaling out.
- **Closed-loop credits** — settlement runs entirely through the
  exchange's token ledger; there is no external payments provider to
  configure. (The Stripe integration was removed in the closed-loop
  pivot.)
- **Pair store is in-memory** — pending device-pair codes live in the
  console's process memory. Any redeploy invalidates outstanding codes
  (the agent will see `unexpected pair status "unknown" (HTTP 404)`).
  Re-run `cocore agent pair` after a redeploy if you were mid-pair.
  This is fine for now (pairing is a rare one-shot) but switch to a
  durable store before scaling.
- **JWK rotation** — to rotate the OAuth signing key, generate a new
  JWK (`scripts/generate-atproto-jwk.sh`), update
  `ATPROTO_PRIVATE_KEY_JWK` on the console service, and redeploy.
  In-flight OAuth flows must be restarted; persisted sessions
  (`~/.cocore/session.json` on already-paired Macs) keep working until
  their refresh token expires.
- **Agent installer + private repo** — the cocore repo is private,
  so `curl https://console.cocore.dev/agent | sh` doesn't read
  GitHub directly. The console proxies the version lookup
  (`/agent/version`) and the asset download (`/agent/dl?tag=…`)
  via `GITHUB_TOKEN`. If installs start returning `503 GITHUB_TOKEN
  env var not set`, that env was wiped — re-set it (see "Configure
  the console service" above). Make the repo public and the
  install path could read GitHub Releases directly without the
  token, but proxying keeps every download flowing through one
  domain and gives us free per-version analytics.
- **Advisor scope (Phase 2.5)** — the advisor accepts `Register`,
  runs attestation challenges (P-256 ECDSA over a sorted-key
  canonical JSON of `{nonce, sipEnabled, timestamp[, hypervisorPresent]}`),
  tracks heartbeats, AND now dispatches `InferenceRequest` end-to-end
  via `POST /jobs`. The advisor never sees plaintext: requesters seal
  to the provider's published `encryption_pub_key`; the provider
  decrypts, generates a reply (M2 swaps in the real engine — today
  it's the deterministic stub in `provider/src/advisor.rs`
  `handle_inference_request`), and re-seals to the requester's
  pubkey. The advisor relays the resulting chunks/complete frames
  as SSE events.
  Still NOT in scope at the advisor:
  - persistent provider/session state across advisor restarts
  - rich matchmaking (today: freshest attested provider that
    accepts the model, with empty `supportedModels` matching anything)
  - rate-limiting / per-requester quotas
  - retry / failover when a chosen provider drops mid-stream
- **Advisor in-memory** — like the console's pair store, advisor
  registry/session state is in-memory. Providers automatically
  reconnect on advisor restart; the only side effect is a brief gap
  where `/providers` shows zero connected DIDs. The one exception is
  the rolling latency windows (`/ack`, `/ttft`): when a volume is
  attached they're persisted to disk and hydrated on boot so the
  public latency headline doesn't blank out across a redeploy (see
  "Configure the advisor service" above).
