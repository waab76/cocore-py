# Production cutover runbook — XRPC-on-AppView + per-PR stacks

What to do once the `appview` branch (PR #26) merges to `main`. The change is
**additive and backward-compatible**: merging + deploying the new code changes
nothing until you set the cutover env vars. Each stage is independently
reversible (unset the vars → the console falls back to its legacy in-process
paths).

Production facts (confirmed):

| service  | public domain         | identity |
|----------|-----------------------|----------|
| console  | `console.cocore.dev` (apex `cocore.dev`) | OAuth client `https://console.cocore.dev/api/auth/atproto/metadata.json` |
| services | `appview.cocore.dev`  | `did:web:appview.cocore.dev` |
| advisor  | `advisor.cocore.dev`  | — |

Internal (per-env Railway DNS, already correct): `services.railway.internal:8081`
(AppView), `:8080` (bridge), `console.railway.internal:3000`.

> ⚠️ **Railway gotcha (hit repeatedly during dev):** changing a variable
> redeploys the service from its **Git source**. After merge that's `main`, so
> it's fine — but never set a prod var while a hand-uploaded (`railway up`)
> deploy is the active one, or it reverts to stale code. Use `--skip-deploys`
> to batch var sets, then `railway redeploy` once.

---

## Stage 0 — Merge + deploy (no behavior change)

1. Confirm CI green on the PR (it is: lex, rust fmt/clippy/test, typecheck,
   oxlint/oxfmt, build, knip, all TS tests, playwright e2e).
2. Merge to `main`. Railway deploys `console`, `services`, `advisor` from `main`.
3. **Verify nothing changed.** The AppView's account/devicePair/inference/pds
   routes only register with the cutover vars set (still unset), and the
   console forwarders only activate when configured — so prod runs exactly as
   before. The only visible change: the OAuth metadata now advertises the
   `rpc` scope (harmless; existing tokens keep their old scope, new logins gain
   `rpc`). Spot-check:
   ```sh
   curl -s https://appview.cocore.dev/healthz                                   # {"ok":true}
   curl -s https://appview.cocore.dev/xrpc/dev.cocore.compute.listProviders -o /dev/null -w '%{http_code}\n'  # 200
   curl -s https://console.cocore.dev/api/auth/atproto/metadata.json | grep -o 'rpc?[^"]*'  # rpc scope present
   ```

---

## Stage A — Forward writes to the AppView + migrate sessions

This makes paired machines write through the AppView (single-writer session
ownership) **without** touching device pairing or dispatch yet, so **no `rpc`
scope is required**. Best run in a low-traffic window — there's a short gap
between enabling the forward and finishing the session migration where an
existing user's PDS write can 401.

1. **Pick a shared internal secret** (used by console↔services trust boundary):
   ```sh
   SECRET=$(openssl rand -hex 32)
   ```
2. **services** — give the AppView its OAuth client + account store + handoff
   endpoint (copy the OAuth key from the prod console so they're the same
   client; `--skip-deploys` then redeploy once):
   ```sh
   KEY=$(railway variables --project <PROJECT> -s console -e production --json | jq -r .ATPROTO_PRIVATE_KEY_JWK)
   railway variables --project <PROJECT> -s services -e production --skip-deploys \
     --set "COCORE_APPVIEW_DID=did:web:appview.cocore.dev" \
     --set "COCORE_ADVISOR_URL=https://advisor.cocore.dev" \
     --set "ATPROTO_BASE_URL=https://console.cocore.dev" \
     --set "ATPROTO_PRIVATE_KEY_JWK=$KEY" \
     --set "COCORE_ACCOUNT_DB=/data/account.db" \
     --set "COCORE_INTERNAL_SECRET=$SECRET"
   railway redeploy --project <PROJECT> -s services -e production --yes
   ```
   (Setting `COCORE_APPVIEW_DID` here registers the AppView's account / devicePair /
   `/pds` / inference routes + serves `/.well-known/did.json` — server-side only;
   nothing calls them until the console forwards.)
3. **console** — turn on the write forward (NOT `COCORE_APPVIEW_DID` yet, so
   devicePair/dispatch stay legacy and need no `rpc`):
   ```sh
   railway variables --project <PROJECT> -s console -e production --skip-deploys \
     --set "COCORE_APPVIEW_INTERNAL_URL=http://services.railway.internal:8081" \
     --set "COCORE_INTERNAL_SECRET=$SECRET"
   railway redeploy --project <PROJECT> -s console -e production --yes
   ```
4. **Migrate existing sessions** to the AppView so forwarded writes (and
   already-paired machines) have a session to write under. Run once, right
   after step 3 (needs `COCORE_INTERNAL_API_KEY` set on the console):
   ```sh
   curl -fsS -X POST https://console.cocore.dev/api/internal/migrate-sessions-to-appview \
     -H "Authorization: Bearer $COCORE_INTERNAL_API_KEY"
   ```
5. **Verify** an existing paired machine still publishes (its `cocore-…` key
   resolves on the console → forwards to the AppView → writes under the migrated
   session). Watch `appview.cocore.dev` logs for `appview: stored OAuth session
   handoff` and a 200 on `/internal/pds/createRecord`.

**Continuity guarantee:** customer API keys are unchanged (console stays the key
store and forwards by SHA-256 lookup) and machines are not re-paired. New logins
hand off their session automatically; the migration covers users who don't log
in again.

---

## Stage B — Cut device pairing + dispatch over to the AppView

This activates the service-auth methods (`devicePair.confirm`,
`inference.dispatch`) on the AppView path, which mint a service-auth JWT and
therefore **require the `rpc` scope**.

1. **Re-auth prerequisite.** Tokens issued before Stage 0 lack `rpc`, so the
   user *approving a pairing* or *dispatching* must have logged in since the
   deploy. Options: prompt re-auth in the UI, or simply accept that the first
   pairing/dispatch after this flip sends the user through a fresh login. Note:
   already-paired machines keep serving regardless (Stage A covers their writes).
2. **console** — flip the service-auth methods on:
   ```sh
   railway variables --project <PROJECT> -s console -e production --skip-deploys \
     --set "COCORE_APPVIEW_DID=did:web:appview.cocore.dev"
   # COCORE_ADVISOR_URL on the console is optional — it already defaults to the
   # prod advisor; set it only if you want it explicit.
   railway redeploy --project <PROJECT> -s console -e production --yes
   ```
3. **Verify** end to end with a real device pairing + a chat dispatch from a
   freshly-logged-in account; confirm the receipt is published and indexed at
   `appview.cocore.dev`.

---

## Publish the lexicons (deferred during the branch)

The branch added ~40 `dev.cocore.*` lexicon JSONs but did not publish them.
Publish them to the lexicon authority with `goat` (per CLAUDE.md / the original
plan) so they're resolvable:

```sh
# for each file under lexicons/dev/cocore/**.json
goat lex publish <file>     # exact invocation per your goat setup
```

The console also serves them at `https://console.cocore.dev/lexicons` and
`/lexicons/<nsid>` for discovery (verified by the smoke test) — goat publishing
is the on-network authority step, independent of that.

---

## Verification checklist (post-cutover)

```sh
A=https://appview.cocore.dev ; C=https://console.cocore.dev
curl -s $A/healthz                                                            # {"ok":true}
curl -s $A/.well-known/did.json | jq .id                                      # "did:web:appview.cocore.dev"
curl -s -o /dev/null -w '%{http_code}\n' $A/xrpc/dev.cocore.compute.listProviders        # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $A/xrpc/dev.cocore.devicePair.start      # 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $A/xrpc/dev.cocore.devicePair.confirm \
  -H content-type:application/json -d '{}'                                                 # 401 (service-auth)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $A/xrpc/dev.cocore.inference.dispatch \
  -H content-type:application/json -d '{}'                                                 # 401 (service-auth)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $A/api/pds/createRecord -d '{}'           # 401 (bearer)
curl -s $C/api/auth/atproto/metadata.json | grep -o 'rpc?[^"]*'                            # rpc scope present
```

---

## Rollback

Each stage is reversible by unsetting its console vars (the forwarders fall back
to the legacy in-process path):

- **Stage B** → unset `COCORE_APPVIEW_DID` on the console (devicePair/dispatch
  revert to legacy local).
- **Stage A** → unset `COCORE_APPVIEW_INTERNAL_URL` + `COCORE_INTERNAL_SECRET`
  on the console (writes go back to the console's own OAuth session).

Leaving the `services` vars set is harmless (the AppView just serves routes
nothing calls). Don't re-run the migration backwards — it's a one-way copy and
the console session store is untouched.

---

## No action needed (already handled)

- **Per-PR stacks.** `pr-env-config.yml` + `scripts/configure-pr-env.sh`
  auto-wire each PR's cloned env to itself (using the `RAILWAY_API_TOKEN`
  secret). PR clones inherit prod's custom-domain values, then the workflow
  rewrites them to the PR's own domains — so no manual per-PR config. The PR app
  build (`provider-pr-build.yml`) bakes the PR URLs into `cocore.app`.
- **CI secrets.** `RAILWAY_API_TOKEN` (account/team scope) is set. If it's ever
  rotated, update the repo secret.
- **Provider agents in the field.** Old agents keep posting to
  `console.cocore.dev/api/pds/...`; the console forwards to the AppView. No
  re-install / re-pair. New installs (app or `curl … | sh`) pick up the AppView
  origin as their `apiBase` from the pairing response.

## Follow-ups (non-blocking)

- **Receipt-validation findings** surfaced during the dev E2E:
  `price.currency` "CC" (2 chars) fails the receipt lexicon's `minLength: 3`, so
  `verifyReceipt` returns `lexicon-invalid` for real CC-priced receipts — decide
  whether to relax the lexicon or move to a ≥3-char currency code. And
  `enclaveSignature` reports `signature-invalid` for `self-attested` providers
  with no TEE — confirm the verifier should skip the enclave-sig check at that
  trust level.
- **Per-PR exchange identity.** PR envs currently share prod's `COCORE_EXCHANGE_DID`
  + signing key; consider a per-env exchange identity if settlement-record
  collisions become an issue.
