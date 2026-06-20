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

## The binding decision (resolve HERE, on the first device)

`provider/src/mda.rs` currently binds **leaf-key == the agent's SE signing key**.
The ACME `HardwareBound` flow attests a *new* SEP key (the ACME key), not the
agent's existing signing key. So on the first real chain we decide:

- **(a)** make the agent's signing key the ACME-attested key (then today's
  leaf==key check works unchanged), or
- **(b)** bind via the **freshness-code OID** (`mda.rs` already extracts it):
  the step-ca nonce commits to `sha256(SE pubkey)`, and the verifier checks the
  freshness code instead of leaf==key (darkbloom's approach, less invasive).

**A wrong choice silently caps the tier at best-effort with no error** — so verify
the bound chain end-to-end on the first enrolled Mac before rolling out.

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

## Files

- `profiles/cocore-attestation.mobileconfig` — the ACME attestation profile
  (validated; set `DirectoryURL` to your step-ca before pushing).
- `step-ca/provisioner.json` — the step-ca ACME-with-Apple-attestation provisioner.
