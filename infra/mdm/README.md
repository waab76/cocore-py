# cocore MDM + attestation infra (Track B)

Stands up the two services that produce the Apple **hardware-attested** tier:
**NanoMDM** (enrolls provider Macs + pushes profiles) and **step-ca** (the ACME
server that runs Apple `device-attest-01` and captures the Apple attestation
chain). The provider Mac's chain is then handed to the cocore agent, which embeds
it in its `dev.cocore.compute.attestation` PDS record; the verifier flips the
provider to `trustLevel: hardware-attested`.

```
provider Mac ──enroll──▶ NanoMDM ──push profile──▶ provider Mac
     │                                                  │
     └──ACME device-attest-01 (Apple attestation)──▶ step-ca ──chain──▶ cocore agent ──▶ PDS
```

ACME Managed Device Attestation needs **macOS 14+, Apple silicon, and NO
supervision / ABM** (Apple spec: `supervised=false`).

## Prerequisites (DONE)

- ✅ APNs MDM push certificate — `~/cocore-mdm/push.p12` (+ password file).
- Push **Topic**: `com.apple.mgmt.External.7e4125e2-8e2b-4a0d-a148-23c33073bc61`
  (the cert's UID; NanoMDM is configured with this).

## 1. step-ca (ACME server with Apple device attestation)

Use the official `smallstep/step-ca` image. Add an ACME provisioner that accepts
the Apple `device-attest-01` challenge — `infra/mdm/step-ca/provisioner.json`:

```json
{
  "type": "ACME",
  "name": "cocore-attest",
  "challenges": ["device-attest-01"],
  "attestationFormats": ["apple"]
}
```

step-ca validates the device's attestation against Apple's attestation CA
(built-in) and issues a cert; we read the **attestation object's x5c chain**
(rooted in the Apple Enterprise/Device Attestation Root our verifier embeds) from
the order. The ACME directory URL becomes the profile's `DirectoryURL`
(`https://<step-ca-host>/acme/cocore-attest/directory`).

## 2. NanoMDM (enrollment + push)

Official image `ghcr.io/micromdm/nanomdm`. It needs: the APNs push cert/key (from
`push.p12`), an API key, and a storage DSN (Postgres on Railway). Mount the push
cert and pass the topic. Verify exact flags against the current NanoMDM docs at
deploy time (`-api`, `-storage`, push cert path).

The enrollment profile NanoMDM serves makes the Mac user-approve MDM; then we push
`infra/mdm/profiles/cocore-attestation.mobileconfig` (the ACME attestation
payload) — set its `DirectoryURL` to the step-ca host first.

## 3. Railway

Two services in the existing `co/core` project: `step-ca` and `nanomdm` (+ a
Postgres plugin for NanoMDM storage). Both need public HTTPS hostnames + the
provider Macs must reach them. Put `push.p12` in a Railway secret/volume — never
in the repo.

## 4. Enroll the test Mac → capture the chain → wire the agent

1. Install NanoMDM's enrollment profile on the test Mac (user-approves).
2. Push `cocore-attestation.mobileconfig`.
3. The Mac runs ACME device-attest-01 against step-ca → step-ca logs/stores the
   Apple attestation chain. Verify it with `mda::verify_chain` (root + posture
   OIDs) — this is the moment to confirm the **binding** (see below).
4. The coordinator stores the chain by serial and hands it to the agent, which
   embeds it; the provider flips to hardware-attested.

## The binding decision — RESOLVED: option (b), freshness-code binding

The ACME `HardwareBound` flow attests a *new* SEP key (the ACME/profile key), not
the agent's existing receipt-signing key. We bind via the **freshness-code OID**
(`1.2.840.113635.100.8.11.1`) so the agent keeps its own stable signing identity,
decoupled from the MDM/ACME key lifecycle (darkbloom's approach).

**The commitment:** the attestation flow sets the Apple freshness value to
`sha256(signing pubkey)` — the raw 64-byte P-256 X‖Y point that the agent
publishes as `attestation.publicKey`. The verifier (TS/Python/Rust, all three) then
recomputes `sha256(publicKey)` and checks it equals the leaf's freshness OID —
offline, from `publicKey` alone (invariant #2). Implemented + cross-language tested:
`MdaResult::freshness_binds` (Rust), `freshnessBindsKey` (TS), `_freshness_binds_key`
(Python), all keyed off the same vector. The verifier accepts **either** binding —
freshness-code (b) OR the legacy leaf==key (a) — and fail-closes if neither holds.

**What this proves (and the platform ceiling):** binding ties the genuine-hardware
attestation to *this* signer + device, defeating "staple someone else's Apple chain
onto my key." It does NOT by itself prove the signing key is enclave-resident or
that the measured binary is honest — the `cdHash`/posture gates carry that, and on
Apple silicon the cdHash is necessarily self-measured (no Apple API attests a
running process's cdHash to a third party). That self-measurement ceiling is
inherent to the platform and is the same for our reference.

**Producer TODO(ops):** making Apple actually emit `freshness == sha256(signing
pubkey)` is the enrollment-side wiring — either a custom step-ca `device-attest-01`
nonce, or the App Attest companion (`COCORE_MDA_ATTEST_BINARY`) where the agent
controls `clientDataHash = sha256(signing pubkey)` directly. The verifier is done;
this is the live step to confirm on the first enrolled Mac before rollout.

## Deployment gotchas discovered (2026-06-20, partial deploy)

Confirmed Railway access + created `cocore-step-ca` (smallstep/step-ca image,
service id `4de1dff8-3abb-4427-a117-1696a67e2719`, in the **production** env —
the CLI link didn't hold across shells so the first `railway add` defaulted
there), added a volume (`/home/step`) + domain
(`https://cocore-step-ca-production.up.railway.app`, target port 9000). Then hit
real blockers — resolve these on the next dedicated deploy pass:

1. **step-ca volume permissions (crash-loop).** `/entrypoint.sh: /home/step/password:
   Permission denied` — step-ca runs as a non-root user but the Railway volume
   mounts root-owned. Fix: run an init that `chown`s `/home/step`, set the volume
   ownership, or run step-ca as the matching uid. (For an initial attestation
   PROOF, persistence isn't required — dropping the volume lets step-ca init in
   ephemeral storage and boot.)
2. **TLS termination — the architectural decision.** step-ca serves its OWN HTTPS
   (its CA-issued cert) on 9000; Railway's HTTP proxy expects an HTTP upstream, so
   an HTTP domain → 9000 mismatches. The clean fix: a Railway **TCP proxy** (raw
   TCP) to 9000 so step-ca terminates its own TLS, AND **push step-ca's root CA to
   the provider Mac via an MDM cert profile** so the Mac trusts that TLS for the
   ACME `DirectoryURL`. (Avoids needing a publicly-trusted cert on step-ca.)
   step-ca `DNS_NAMES` must then include the TCP proxy hostname.
3. **Railway MCP needs auth.** `railway setup agent` installed the MCP, but the
   MCP server process doesn't inherit `RAILWAY_API_TOKEN`, so it returns
   "Unauthorized." Either `railway login` (OAuth, then restart so the MCP reads
   the stored creds) or add the token to the MCP server's env in `~/.claude.json`.
   Until then, drive the CLI with `railway link --project <id> --environment <env>
   --service <name>` (all three) in a single shell, then bare subcommands.

## ✅ PROVEN END-TO-END (2026-06-20) — real Apple hardware attestation

The full chain ran successfully on a real Apple-silicon Mac (M1, macOS 26.4.1,
serial `H2WHW38LQ6NV`):

1. **Enroll** — installed `enroll.mobileconfig`; NanoMDM logged `Authenticate
   serial_number=H2WHW38LQ6NV` + `cert associated` + `TokenUpdate`.
2. **Push** — `InstallProfile` (the attestation profile) enqueued + APNs-pushed.
3. **Attest** — the Mac generated a hardware-bound SEP key + Apple attestation and
   ran ACME `device-attest-01`; step-ca validated it against Apple's attestation CA
   → **`challenge device-attest-01 status=valid`** (the attestation statement carried
   the real hardware ids `["00008103-001869192E20801E" (UDID), "H2WHW38LQ6NV"
   (serial)]`).
4. **Issue** — finalize succeeded, step-ca issued the attestation cert; the device
   reported `status=Acknowledged`; the profile shows installed under "Device
   (Managed)".

**Gotchas that each cost a full attempt (fix ALL of them):**
- **PKCS12 identity MUST be `openssl pkcs12 -legacy`.** OpenSSL 3's default p12
  uses a SHA-256 MAC that Apple's keychain can't parse → the install fails with the
  misleading *"The certificate could not be verified (authentication error)"*
  (NanoMDM never even gets contacted). Verify with `security import test.p12` →
  "1 identity imported" before pushing to a device.
- **The attestation profile is PER-DEVICE.** `ClientIdentifier` (ACME
  permanent-identifier) **and** the `Subject` CN must BOTH equal the device's
  hardware **serial** (or UDID). A literal id fails the challenge
  (`badAttestationStatement … doesn't match any of the attested hardware
  identifiers`); a mismatched CN fails finalize (`badCSR … CSR Subject Common Name
  does not match identifiers`). Template `__DEVICE_SERIAL__` in
  `profiles/cocore-attestation.mobileconfig` per enrollment (serial comes from the
  NanoMDM `Authenticate` check-in).
- **Least-privilege `AccessRights`.** Use `3` (install + inspect configuration
  profiles) — NOT the all-rights `8191`. With `8191` the install dialog scares the
  user with "Erase all data / Lock screen / Change settings / App management"; with
  `3` it shows only the two config-profile rights we actually use to push the
  attestation profile.
- **NanoMDM push cert is ephemeral** (file storage in the container) — it vanishes
  on every restart (`getting …pem: key not found`). Re-upload before pushing:
  `cat apns_push.pem push.key | curl -T - -u nanomdm:<key> https://<host>/v1/pushcert`.
- **Recover a wedged install UI:** if System Settings hangs on "Installing
  profile…", the system itself is usually fine (`profiles list` shows nothing) —
  it's the settings extension; `kill <ProfilesSettingsExt pid>` and reopen.

Enrollment ID for this Mac: `376AF848-8EC9-5336-AB51-0801857F726D`.

Remaining for full cocore integration: have step-ca export the Apple attestation
**x5c chain** to the agent (mda::verify_chain), embed it in the
`dev.cocore.compute.attestation` record, and resolve the leaf-key==signing-key vs
freshness-code binding (see "The binding decision" above). The attestation itself
is now proven; this is wiring.

## LIVE DEPLOYMENT STATE (2026-06-20) — step-ca is UP

`cocore-step-ca` is deployed + serving in co/core **production**. The hard part
(step-ca's TLS architecture on Railway) is SOLVED and verified:

- **Image:** smallstep/step-ca, service id `4de1dff8-3abb-4427-a117-1696a67e2719`.
- **Volume-perm crash → fixed** with `RAILWAY_RUN_UID=0` (run container as root so
  step-ca can write the volume). Without this it crash-loops on `/home/step/password`.
- **TLS termination → fixed** with a **Railway TCP proxy**:
  `reseau.proxy.rlwy.net:43462` → step-ca:9000. (An HTTP domain 502s — Railway's
  HTTP edge can't talk to step-ca's HTTPS upstream.) step-ca generates ACME URLs
  from the request **Host header**, so the proxy-port mapping is a non-issue — the
  directory at `https://reseau.proxy.rlwy.net:43462/acme/acme/directory` returns
  correct URLs.
- **Cert SAN → fixed.** The serving cert must cover the proxy host. Set
  `DOCKER_STEPCA_INIT_DNS_NAMES=reseau.proxy.rlwy.net,...` and force a re-init.
  Re-init gotcha: the API `volumeDelete` did NOT empty it; what worked is
  `railway volume detach --volume <name> -y` then `railway redeploy -y` → step-ca
  re-inits (ephemeral) with the new dnsNames. Cert SAN now includes
  `reseau.proxy.rlwy.net`. (NOTE: it's now EPHEMERAL — volume detached — so a
  redeploy re-inits + changes the root. Re-attach persistence carefully before
  enrolling anything for real, or bake config via a custom image.)
- **Root CA:** fingerprint `6d7bcfec517aab89e3e14ec8f60a43529c9c40c2c2e963e982040e9aa77dffe7`,
  saved to `~/cocore-mdm/stepca-root.pem`. **Push this to the provider Mac via an
  MDM root-cert profile** so the Mac trusts step-ca's TLS for ACME.
- **CA admin:** user `step`, password in `~/cocore-mdm/stepca-password.txt`;
  `DOCKER_STEPCA_INIT_REMOTE_MANAGEMENT=true` (admin the CA remotely with the
  `step` CLI).

### step-ca provisioners — CONFIGURED (via `step` CLI + remote admin)
`brew install step`; `STEPPATH=~/cocore-mdm/stepca-client step ca bootstrap --ca-url
https://reseau.proxy.rlwy.net:43462 --fingerprint 6d7bcfec...`. Remote admin is on
(super-admin subject `step`, JWK provisioner `admin`, password
`~/cocore-mdm/stepca-password.txt`). Added two provisioners with
`step ca provisioner add ... --admin-provisioner admin --admin-subject step
--password-file ~/cocore-mdm/stepca-password.txt`:
- **`cocore-attest`** (ACME, `--challenge device-attest-01 --attestation-format apple`)
  → directory `https://reseau.proxy.rlwy.net:43462/acme/cocore-attest/directory`
  (the attestation profile's `DirectoryURL`). VERIFIED serving correct URLs.
- **`cocore-scep`** (SCEP, `--challenge <secret>` in `~/cocore-mdm/scep-challenge.txt`,
  `--encryption-algorithm-identifier 2`) → device-identity enrollment for MDM.
  SCEP URL `https://reseau.proxy.rlwy.net:43462/scep/cocore-scep`.

### NanoMDM — DEPLOYED + push cert loaded
Service `cocore-nanomdm` (id `277e36ce-8d93-4266-8960-ac0a83079b85`), domain
`https://cocore-nanomdm-production.up.railway.app` (Railway-terminated TLS =
publicly trusted — what MDM enrollment needs). Distroless image has no shell, so a
tiny custom Dockerfile (`~/cocore-mdm/nanomdm-deploy/`, template in
`infra/mdm/nanomdm-deploy/Dockerfile`) bakes the step-ca root as `-ca` and runs
`/app/nanomdm -ca /app/ca.pem -api <key> -listen [::]:9000 -debug`. Deployed with
`railway up`. Push cert uploaded: `cat apns_push.pem push.key | curl -T - -u
nanomdm:<key> https://.../v1/pushcert` → 200, topic confirmed. API key in
`~/cocore-mdm/nanomdm-api-key.txt`.

**Railway gotchas for HTTP services (BOTH bit us — fix BOTH or you get edge 502s
with zero request logs in the container):**
1. **Bind `[::]` not `0.0.0.0`.** Railway's edge proxies over its internal IPv6
   network; an IPv4-only listener is unreachable → 502. (`0.0.0.0:9000` failed,
   `[::]:9000` works; Go `[::]` is dual-stack.)
2. **`railway domain --port 9000` does NOT set the domain target port** — it stayed
   `null`, so Railway auto-detected the wrong port → 502. Set it explicitly via the
   GraphQL `serviceDomainUpdate(input:{serviceDomainId, domain, environmentId,
   serviceId, targetPort:9000})` mutation (the token works for GraphQL even though
   the Railway MCP returns Unauthorized). Verify with the `domains(...){
   serviceDomains{ targetPort } }` query.
- `RAILWAY_RUN_UID=0` so file-storage `./db` is writable (same as step-ca).

### Enrollment profile — BUILT (`~/cocore-mdm/enroll.mobileconfig`)
**GOTCHA: step-ca only mounts the `/scep` HTTP route for SCEP provisioners that
exist AT BOOT** — a runtime-added one 404s, and restarting re-inits our ephemeral
CA. So the proof uses an **embedded PKCS12 device identity** instead of SCEP:
issue a leaf with `STEPPATH=~/cocore-mdm/stepca-client step ca certificate
cocore-provider-mdm mdm-id.crt mdm-id.key --provisioner admin
--provisioner-password-file ~/cocore-mdm/stepca-password.txt -f` (CA caps duration
at **24h** — reissue same-day or raise the provisioner's `x509-max-dur`), pack it
PKCS12, and embed it as a `com.apple.security.pkcs12` payload referenced by the MDM
payload's `IdentityCertificateUUID`. NanoMDM's `-ca` is the step-ca **root +
intermediate** bundle (the leaf is issued by the intermediate; root-only fails to
verify). The profile also installs the step-ca root (`com.apple.security.root`) and
sets `SignMessage=true` (device signs check-ins via the `Mdm-Signature` header —
required since we don't pass client certs through the TLS-terminating proxy and
didn't set `-cert-header`). For production, switch back to SCEP by stabilizing
step-ca persistence and booting it WITH the SCEP provisioner.

### Remaining (needs the user present — GUI approval + Touch ID, do today)
1. **Enroll this Mac:** install `~/cocore-mdm/enroll.mobileconfig` → approve the MDM
   enrollment in System Settings ▸ General ▸ Device Management (authenticate). Confirm
   check-in in NanoMDM logs.
2. **Push the attestation profile** `profiles/cocore-attestation.mobileconfig` via the
   NanoMDM API (InstallProfile command) → the Mac runs ACME `device-attest-01` against
   `cocore-attest` → step-ca captures the Apple attestation chain.
3. **Capture + verify** the Apple chain off step-ca → `mda::verify_chain` → resolve the
   binding (leaf==signing-key vs freshness-code) → flip the provider to hardware-attested.
- **EPHEMERAL warning:** step-ca + NanoMDM lose all state on redeploy (step-ca
  re-inits its root → breaks NanoMDM's baked `-ca` AND the device's trust + identity).
  Don't redeploy either between now and capturing the chain; stabilize persistence
  before any real rollout.

## Productionization — from the one-shot proof to a fleet (WS-B)

The proof above ran EPHEMERAL on purpose. A real Secure Mode rollout (the tray
wizard → coordinator endpoints → captured chain) needs these turned durable. The
coordinator HTTP surface that the wizard calls lives in the console
(`/agent/mdm/enroll-profile`, `/agent/mdm/push-attestation`,
`/agent/mdm/attestation-chain`); this section is the infra it sits on.

1. **Persist step-ca.** Re-attach a volume at `/home/step` and let step-ca init
   ONCE into it (with `DOCKER_STEPCA_INIT_DNS_NAMES` = the TCP-proxy host and
   `DOCKER_STEPCA_INIT_REMOTE_MANAGEMENT=true`), then never re-init. The root +
   provisioners (`cocore-attest` ACME-with-apple, `cocore-scep`) then survive
   restarts, so the **root fingerprint is stable** and the SCEP `/scep` route is
   mounted at boot (the runtime-add limitation goes away once it's persisted). Bake
   the CA password as a Railway secret, not a file the volume can clobber.

2. **Persist NanoMDM.** Move off the ephemeral file store onto a database
   (`-storage mysql|pgsql -dsn …` against a Railway Postgres/MySQL plugin) so the
   **APNs push cert + enrollments survive restarts** (we watched the push cert get
   wiped on every redeploy). Upload the push cert once after the DB is attached.
   Keep `-ca` = step-ca root+intermediate bundle; refresh it if the CA root ever
   rotates.

3. **Per-device enrollment minting** (`POST /agent/mdm/enroll-profile`). The
   wizard sends `{serial, udid}`; the coordinator mints a `.mobileconfig` templated
   to that serial: root+intermediate trust + a device identity (prefer **SCEP** now
   that the CA is persistent — each device gets its own key — over the embedded
   legacy-PKCS12 we used in the proof) + the MDM payload (`SignMessage=true`,
   `AccessRights=3`). Required env on the coordinator: `COCORE_MDM_SERVER_URL`,
   `COCORE_MDM_TOPIC`, `COCORE_STEPCA_*` (CA URL + roots + SCEP challenge or the
   admin creds to issue an identity).

4. **Attestation push + capture** (`POST /agent/mdm/push-attestation`,
   `GET /agent/mdm/attestation-chain`). Push enqueues the ACME attestation profile
   (ClientIdentifier + Subject CN = the device **serial** — the per-device
   requirement we learned) to NanoMDM (`/v1/enqueue` + `/v1/push`, env
   `COCORE_NANOMDM_URL` + `COCORE_NANOMDM_API_KEY`). step-ca runs
   `device-attest-01` and issues the cert; the coordinator must then **read the
   Apple x5c chain out of step-ca and store it by serial** so the chain endpoint can
   return it. (step-ca exposes the validated attestation on the order/challenge; the
   clean path is a small step-ca webhook or an admin-API poll keyed by the order's
   permanent-identifier = serial. Marked TODO in the endpoint until the persistent
   CA is up.)

5. **Agent pickup.** The wizard writes `COCORE_MDA_CHAIN_URL` =
   `…/agent/mdm/attestation-chain?serial=<serial>` into the LaunchAgent plist. The
   Rust agent (`mda_loader`) curls it each attestation refresh and embeds the chain
   in its `dev.cocore.compute.attestation` record; the verifier then binds it and
   the provider flips to `attested-confidential`. A `null` chain (not captured yet)
   keeps it self-attested — no outage.

6. **Binding decision** stays as in "The binding decision" above: the ACME-attested
   SEP key must equal the agent's receipt-signing key (submit the signing key's
   pubkey as the attested key) OR bind via the freshness-code OID. Resolve on the
   first fleet device before rollout.

**Net:** items 1–2 are Railway/persistence ops; 3–5 are the coordinator endpoints
(scaffolded in the console with env + TODOs for the live CA calls) plus the agent's
already-shipped `COCORE_MDA_CHAIN_URL` fetch; 6 is a one-time verification.

## Files

- `profiles/cocore-attestation.mobileconfig` — the ACME attestation profile
  (validated; set `DirectoryURL` to your step-ca before pushing).
- `step-ca/provisioner.json` — the step-ca ACME-with-Apple-attestation provisioner.
