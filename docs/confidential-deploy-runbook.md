# Confidential tier — field-deployment runbook

**Status:** authoritative deployment plan for getting the `attested-confidential`
tier (APNs code identity + bound MDA chain + client-edge seal) from "code written
and unit-tested" to "a real user's Mac serves a confidential request."

**Scope:** the confidential-compute path only. The best-effort path already ships
and is unaffected by everything here until you explicitly flip enforcement on.

**Companion docs (read alongside, don't duplicate):**
- `docs/confidential-code-identity.md` — the *design* of the APNs mechanism + the two trust carve-outs.
- `infra/mdm/README.md` — the MDM/step-ca/NanoMDM infra (the long pole) + its current live state.
- `docs/secure-release.md` — the native/secure release signing path.
- `provider/spikes/apns/README.md` — the proven S5 push round-trip (the mechanism, validated on real hardware).

---

## 0. Owner legend

Every step is tagged with who must do it. The split is hard: anything touching an
Apple signing identity, an Apple Developer portal artifact, a production secret,
a Railway deploy approval, or physical Touch-ID enrollment is **OPS** (you) and
cannot be automated. Everything else is **DEV** (Claude / code + CI authoring).

- **DEV** — write code, author scripts/CI, set non-secret config, prep PRs.
- **OPS** — Apple portal, signing/notarization secrets, the `.p8`, Railway secret
  placement + deploy approval, physical machine enrollment (Touch ID / GUI).
- **JOINT** — needs both in the loop in one session (e.g. canary on your Mac).

---

## 1. Current-state snapshot (as of this branch)

What is **done and verified in CI / on a test machine**:

- Agent crypto core (decrypt-with-`K` + SE-sign the code-identity nonce):
  `provider/src/advisor.rs` — `recover_code_challenge`, `handle_code_challenge_payload`,
  `build_code_attestation_response`. 5 unit tests, no Cocoa dependency.
- Agent push transport: `provider/src/push_host.rs` + `provider/mlx-engine/Sources/CoCoreMLX/PushHost.swift`,
  cfg `target_os="macos" + feature="apns"`. Compiles + links.
- Advisor sender + gate: `infra/advisor/src/apns.ts`, `attest.ts` (`verifyCodeAttestation`),
  `registry.ts` (`codeAttested` + enforcement-gated `confidentialEligible`),
  `connection.ts` (challenge + verify), `main.ts` (`loadApnsConfig`). 79 advisor tests pass.
- Verifier gate: `verify-provider.ts` + `sdk/py/cocore/verify.py` (`requireCodeAttested`). SDK 94 tests pass.
- The S5 spike proved the APNs round-trip end-to-end on real hardware (genuine binary
  gets a token + push; an ad-hoc fork is rejected by AMFI).
- Apple artifacts exist: Team `4L45P7CP9M`, App ID `dev.cocore.provider`, an APNs
  `.p8` (Key ID `W5R2G26QK7` — **must be rotated, it was exposed in chat**), and a
  Developer ID provisioning profile carrying `aps-environment=production`.
- MDM/MDA: step-ca + NanoMDM deployed; a one-shot hardware attestation was **proven
  end-to-end on one Mac** (`infra/mdm/README.md` §"PROVEN END-TO-END"). Not yet
  productionized for a fleet, not yet wired into the agent's published attestation.

What is **NOT done** (the deployable gap):

1. The agent's **main-thread Cocoa handoff** is not wired — the push host can't run
   live yet (P1's one remaining seam).
2. The release pipeline does **not** build the `apns` feature, does **not** embed the
   provisioning profile, and does **not** package the worker as a push-capable bundle.
3. The advisor has **no `APNS_*` env set** → code-identity enforcement is off and no
   challenges are sent.
4. The **producer-side MDA chain is not published** by the agent (the long pole) and
   no machine has a freshness-bound chain in its live attestation.
5. No shipped cdHash is in `COCORE_KNOWN_GOOD_CDHASHES`.

---

## 2. Two ship-levels (stage them — do not do both at once)

| | Ship-level 1 — hardened best-effort | Ship-level 2 — confidential claim |
|---|---|---|
| **What ships** | 0.9.18 with all machinery present, enforcement OFF | A machine can *earn* `attested-confidential` |
| **Gated by** | Phases 0,1,2 (+optionally 3 with enforcement off) | Phases 3,4,5 (4 = the long pole) |
| **Risk** | ~none (no confidential claim; no gating) | real ops; the MDA long pole |
| **Calendar** | days | weeks (dominated by Phase 4) |

**Recommendation:** ship level 1 first so the hardening + APNs code bake in the
field with zero gating, then take on the MDA long pole for level 2.

---

## 3. Pre-flight inventory (gather before starting)

**OPS confirms each exists / is accessible:**

- Apple Developer Program access (Team `4L45P7CP9M`, individual enrollment).
- A **rotated** APNs `.p8` auth key + its new Key ID (see Phase 3.1).
- The Developer ID provisioning profile (`aps-environment=production`, App ID
  `dev.cocore.provider`). Store it as a CI artifact/secret, not in `~/Downloads`.
- Developer ID Application signing identity in the build machine's keychain
  (`Developer ID Application: DEVIN FRANCIS GAFFNEY (4L45P7CP9M)`).
- A notarytool credential profile (`COCORE_NOTARY_PROFILE`, see `scripts/notarize-mac-app.sh`).
- Apple MDM **push certificate** (already obtained, free path — `infra/mdm/README.md`).
- Railway access (`RAILWAY_API_TOKEN`), project **co/core**, the **advisor** service.
- A Mac you can physically enroll for the canary (Touch ID / GUI session).

---

## 4. Phase 0 — land the PR  ·  owner: DEV → OPS merges  ·  ~hours

**Goal:** PR #31 is green and merged to `main` so the code is on the release line.

1. **DEV:** confirm CI is green on `claude/confidential-lexicon-fields`
   (build-mac-arm64, static-analysis, advisor/SDK tests, Railway preview deploys).
   The `apns` feature is off by default, so default CI is unaffected.
2. **DEV:** confirm the full local sweep one more time:
   ```bash
   (cd provider && cargo test --lib)                 # 99 pass
   (cd provider && cargo check --features apns)        # apns compiles + links
   (cd infra/advisor && npm run typecheck && npx vitest run)   # 79 pass
   (cd packages/sdk && npm run typecheck && npx vitest run)    # 94 pass
   (cd packages/console && npm run typecheck)          # clean
   ```
3. **OPS:** review + **merge** PR #31.

**Verify:** `main` contains `provider/src/push_host.rs`, `infra/advisor/src/apns.ts`,
`docs/confidential-code-identity.md`, and this runbook.

**Rollback:** none needed — nothing is enforced yet.

---

## 5. Phase 1 — agent main-thread Cocoa handoff  ·  owner: DEV writes, JOINT verifies  ·  ~1 day + a hardware cycle

**Goal:** the measured agent actually registers for APNs and answers challenges.

This is the one remaining piece of agent *code*. It is `apns`-feature-gated, so it
cannot affect default builds.

### 5.1 What to write (DEV)

In `provider/src/main.rs`, behind `#[cfg(all(target_os="macos", feature="apns"))]`,
restructure the confidential-serve entry so the **process main thread runs the
Cocoa loop** and the tokio serve loop runs on workers:

- Create a `tokio::sync::mpsc::unbounded_channel::<String>()` for received push
  payloads (`push_tx`/`push_rx`).
- Spawn the serve loop (`AdvisorClient::run`) as a task, handing it `push_rx`, the
  `ProviderKeypair` (`K`), and the `SigningIdentity`.
- In the serve loop, `select!` on `push_rx.recv()` → call
  `advisor::handle_code_challenge_payload(&encryption, &*signer, &payload)` → on
  `Ok(Some(resp))` send `AdvisorMessage::CodeAttestationResponse(resp)` on the existing
  outbound channel.
- Before building the `Register` frame, **await the device token** with a short
  timeout (`push_host::current_device_token()` populated by the token trampoline);
  proceed with `apns_device_token: None` if it doesn't arrive in time (the machine
  just re-registers/answers on the next cycle).
- After spawning the serve task, call `push_host::run_blocking(push_tx)` on the main
  thread (it never returns; AppKit owns the thread; abort-on-exit is built in).

Note the `#[tokio::main]` driver runs the async `main` body on the main OS thread, so
calling `run_blocking` directly in that body keeps Cocoa on the main thread while
spawned tasks run on workers. Verify this empirically on hardware (5.3).

### 5.2 Package the worker as a push-capable bundle (DEV) — **easy to miss**

For AMFI to grant `aps-environment` to the **worker** binary (the one that holds `K`
and receives the push), the worker must run as a bundle with the profile embedded —
exactly like the S5 spike's `.app`. The current build spawns a bare `cocore` binary,
whose embedded-profile context is undefined.

In the `apns`/native build, package the worker as:
```
CoCoreProvider.app/
  Contents/
    Info.plist                 # CFBundleIdentifier = dev.cocore.provider, LSUIElement = true
    MacOS/cocore-provider      # the signed worker binary
    embedded.provisionprofile  # the Developer ID profile (aps-environment=production)
```
Sign with `provider/cocore-provider.entitlements` + the embedded profile. Have the
shell (`AgentSupervisor`) spawn the worker via this `.app`'s inner executable so
`Bundle.main` resolves to the bundle (the spike proved running the inner executable
works). This bundle nests inside / installs alongside the shell `cocore.app`.

### 5.3 Verify (JOINT, on your Mac)

1. Build: `COCORE_BUILD_NATIVE=1 COCORE_BUILD_APNS=1 ./scripts/build-mac-app.sh`
   (add the `apns` feature + profile-embedding to the script in Phase 2; for a quick
   check you can sign the worker bundle by hand as in the spike).
2. Run the worker; confirm it logs an APNs device token (the `push_host` token
   trampoline logs `apns: registered device token`).
3. From a scratch sender (reuse `provider/spikes/apns/sender/send.swift` or the advisor
   path), push a sealed `cc` challenge to that token; confirm the agent emits a
   `code_attestation_response` frame whose nonce matches and whose SE signature
   verifies.

**Rollback:** the whole module is `apns`-gated; ship without the feature to disable.

---

## 6. Phase 2 — release pipeline produces the real bundle  ·  owner: DEV authors, OPS runs signing  ·  ~1 day

**Goal:** a notarized artifact that is native + `apns` + profile-embedded, and we know
its cdHash.

### 6.1 Extend the build (DEV)

- `scripts/build-mac-app.sh`: add a `COCORE_BUILD_APNS=1` path that compiles with
  `--features apns` (implies `native_mlx`) and performs the Phase-5.2 worker-bundle
  packaging (embed `embedded.provisionprofile`, sign worker with
  `provider/cocore-provider.entitlements`). **The profile path must be a build input**
  (env `COCORE_PROVISION_PROFILE=/secure/path/cocore_provisioning_profile.provisionprofile`),
  never committed.
- Confirm the worker's signed entitlements show `aps-environment=production`:
  `codesign -d --entitlements - --xml <worker> | plutil -p -`.

### 6.2 Sign + notarize (OPS runs; DEV authored)

```bash
COCORE_BUILD_NATIVE=1 COCORE_BUILD_APNS=1 \
  COCORE_PROVISION_PROFILE=/secure/cocore_provisioning_profile.provisionprofile \
  ./scripts/build-mac-app.sh                      # Developer-ID signs, native+apns
COCORE_NOTARY_PROFILE=cocore-notary ./scripts/notarize-mac-app.sh
```

### 6.3 Extract the cdHash (OPS/DEV)

```bash
./scripts/extract-cdhash.sh provider-shell/build/cocore.app/Contents/MacOS/cocore-provider
# → JSON with cdHash, teamId, hardenedRuntime, libraryValidation, metallibHash, engineLibHash
```
Capture the `cdHash` value; it changes every release and is the input to Phase 3.3.

**Verify:** `spctl -a -vv` accepts the app; `codesign -dvvv` shows hardened runtime +
library validation + the team id; the entitlements carry `aps-environment`.

**Rollback:** keep the previous best-effort artifact; this build only *adds* capability.

---

## 7. Phase 3 — enable the advisor APNs gate  ·  owner: OPS places secret, DEV sets config + deploys  ·  ~hours

**Goal:** the advisor sends code-identity challenges and gates confidential on them.
Setting `APNS_*` is the single switch that turns enforcement on
(`registry` is constructed with `enforceCodeAttestation = apnsConfig !== null`).

### 7.1 Rotate the exposed `.p8` (OPS) — **do this first**

1. developer.apple.com → Keys → revoke `cocore APNs` (`W5R2G26QK7`).
2. Create a new APNs key (Keys → ＋ → APNs → Configure → Production), download the new
   `.p8`, note the new Key ID.

### 7.2 Set advisor env (OPS places the secret; DEV sets non-secret + deploys)

On the **advisor** Railway service (project co/core), set:

| Var | Value | Secret? |
|---|---|---|
| `APNS_AUTH_KEY` | full PEM contents of the new `.p8` | 🔒 yes — OPS places |
| `APNS_KEY_ID` | new Key ID | no |
| `APNS_TEAM_ID` | `4L45P7CP9M` | no |
| `APNS_TOPIC` | `dev.cocore.provider` | no |

`APNS_AUTH_KEY` carries literal newlines; use Railway's multi-line variable UI.

### 7.3 Seed the known-good cdHash (OPS/DEV)

```bash
./scripts/register-known-good.sh <cdhash-from-Phase-6.3>
# prints the exact COCORE_KNOWN_GOOD_CDHASHES value + the command to set it
```
Set `COCORE_KNOWN_GOOD_CDHASHES` on the advisor to include the shipped cdHash. Without
this, every confidential request silently downgrades to best-effort.

### 7.4 Deploy advisor FIRST

Deploy the advisor before any agent that could claim confidential, so the gate exists
first. On boot it logs `[advisor] APNs code-identity enabled topic=dev.cocore.provider`.

**Verify:** `GET /providers` shows `codeAttested` per machine; a machine that hasn't
answered a challenge has `confidentialEligible:false` even with a good cdHash.

**Rollback (kill-switch):** unset the four `APNS_*` vars and redeploy → enforcement
off, behavior reverts to pre-APNs, existing best-effort routing unaffected.

---

## 8. Phase 4 — productionize the producer-side MDA (THE LONG POLE)  ·  owner: JOINT  ·  ~1–2+ weeks

**Goal:** a fleet machine obtains a real Apple MDA chain with
`freshnessCode == sha256(SE pubkey)` and publishes it in its attestation, so the
verifier's MDA gate passes. Until this exists, **no machine can earn confidential**,
regardless of Phases 1–3.

This is the bulk of remaining effort. The infra is partly stood up and the mechanism
is **proven on one Mac** — see `infra/mdm/README.md` (§"PROVEN END-TO-END",
§"LIVE DEPLOYMENT STATE", §"Productionization — WS-B"). Do not re-derive; extend it.

Sub-steps (each detailed in `infra/mdm/README.md`):

1. **Infra hardening (DEV+OPS):** move step-ca + NanoMDM from the one-shot proof to a
   durable Railway deployment (persistent volumes, the step-ca volume-perms gotcha in
   the runbook, TLS termination, MCP/admin auth). Load the production MDM push cert.
2. **Enrollment flow (JOINT):** the Secure Mode wizard (`provider-shell/.../SecureModeWizard.swift`,
   WS-C) installs the enrollment `.mobileconfig`; the user approves the profile +
   Touch-ID. Confirm this is non-scary and reversible (AccessRights scoped to 3 —
   config-profile install + inspect — per the earlier scope reduction).
3. **Attestation acquisition (DEV):** on enrollment, the coordinator issues a
   `DeviceAttestationNonce = base64(sha256(SE pubkey))`, the device returns the
   Apple-signed MDA cert chain, and the agent **publishes that chain in its
   `dev.cocore.compute.attestation` record** (`mda_loader.rs` consumes
   `COCORE_MDA_CHAIN_URL` today; wire the live acquisition).
4. **Independent OS posture (DEV) — darkbloom-parity item:** also pull MDM
   `SecurityInfo` for an OS-reported SIP/Secure-Boot cross-check independent of the
   provider software, and reconcile it against the self-reported + challenge-signed
   posture. (This is the one place darkbloom is currently ahead; ACME
   `device-attest-01` does not carry the SIP OID, so SecurityInfo is the path.)
5. **Refresh (DEV):** re-acquire on the 23h attestation refresh (`schedule.rs`) and on
   SE-key rotation.

**Verify:** the verifier (`verify-provider.ts`) returns `attested-confidential` for a
real machine's published attestation + chain (not just the synthetic fixture): the MDA
chain verifies to the Apple Enterprise Attestation Root AND `freshnessBindsKey` holds.

**Rollback:** if MDA acquisition fails, the agent publishes no chain → the machine is
best-effort. No confidential claim is ever made on a machine without a verified chain.

---

## 9. Phase 5 — canary end-to-end  ·  owner: JOINT (your Mac)  ·  ~hours once 1–4 done

**Goal:** prove the whole chain on one real machine before the fleet.

Success criteria — observe each gate flip on your enrolled, native+apns Mac:

1. Agent registers with an `apns_device_token` (advisor log: `register … `, then
   `-> code-challenge …`).
2. Agent answers the challenge → advisor log `code-attestation OK` → `GET /providers`
   shows `codeAttested:true`.
3. The machine has a freshness-bound MDA chain in its published attestation.
4. `GET /verified-providers` lists the machine as `attested-confidential`.
5. A confidential request from the console/SDK runs `verifyProviderForSeal`
   (fail-closed) with `requireConfidential:true` + `requireCodeAttested:true`, gets
   `tier:"attested-confidential"`, seals at the client edge to the attested key, the
   advisor forwards ciphertext only, and the receipt verifies as
   `attested-confidential`.
6. **Negative:** point the same request at a best-effort machine (or one that hasn't
   code-attested) → `confidential-unavailable`, prompt is NOT sealed.

---

## 10. Phase 6 — fleet rollout  ·  owner: OPS drives, DEV supports  ·  staged

1. Ship 0.9.18 via the guided-upgrade path (users on 0.9.17 stay until they click
   upgrade; vanilla 0.9.18 is best-effort; confidential is opt-in Secure Mode).
2. Keep `APNS_*` enforcement on (set in Phase 3). Machines that haven't enrolled +
   code-attested simply stay best-effort — no breakage.
3. Broaden from the canary: enroll machines in waves via the Secure Mode wizard.
4. Watch `GET /providers` for `codeAttested` / `confidentialEligible` ratios and the
   advisor logs for `code-challenge push failed` (APNs delivery issues).

---

## 11. Enforcement semantics + fail-safety (read before flipping anything)

- The confidential gate is `selfTier==attested-confidential && cdHash∈knownGood &&
  challengeVerifiedSip && (!enforceCodeAttestation || codeAttested)`.
- `enforceCodeAttestation` is true **iff** the advisor has `APNS_*` set. So the entire
  code-identity requirement is one env switch, and turning it off reverts cleanly.
- A missed/failed code challenge calls `dropCodeAttested` → the machine loses
  confidential standing but **keeps serving best-effort** (the socket is not closed).
- Headless/launchd installs can't get a GUI session → never get an APNs token → stay
  best-effort by construction.
- The client-edge verifier is fail-closed: any unmet confidential gate with
  `requireConfidential` set means the prompt is **not sealed** (no silent downgrade).

---

## 12. Verification matrix (each gate → where to confirm)

| Gate | Confirm via |
|---|---|
| APNs token issued | agent log `apns: registered device token`; `GET /providers` `apnsDeviceToken` (if surfaced) |
| Code-attested | advisor log `code-attestation OK`; `GET /providers` `codeAttested:true` |
| cdHash blessed | `extract-cdhash.sh` value ∈ `COCORE_KNOWN_GOOD_CDHASHES` |
| Posture | attestation `sip/secureBoot/hardenedRuntime/libraryValidation/!getTaskAllow/inProcessBackend` all true |
| MDA bound | `verify-provider` MDA chain verifies + `freshnessBindsKey` true |
| Confidential routable | `GET /verified-providers` lists the machine |
| Client seals confidentially | console/SDK `tier:"attested-confidential"`, `sealToKey` set, receipt verifies |

---

## 13. Risk register / honest unknowns

- **Phase 1 main-thread semantics** — the `#[tokio::main]`-body-on-main-thread
  assumption must be confirmed on hardware; if it doesn't hold, restructure to a
  manual runtime + explicit main-thread handoff. Not CI-verifiable.
- **Phase 4 is the schedule risk** — per-device MDM enrollment + Apple attestation has
  the most moving parts and the only hard external dependency (Apple's MDA service +
  push reliability). Budget accordingly.
- **APNs delivery** — background pushes are best-effort + budget-throttled (~per-device
  cooldown). If delivery is unreliable, switch the sender to alert mode (still no
  user-visible notification, since the agent never requests notification authorization).
- **Signing-key hygiene** — the residual ceiling (shared with darkbloom) is a stolen
  `dev.cocore` team key; keep Developer ID + `.p8` in CI secrets / KMS, not on disk.

---

## 14. Definition of done

- **Ship-level 1 done:** 0.9.18 (native opt-in, apns code present, enforcement off)
  notarized + released via the guided upgrade; no regression to best-effort users.
- **Ship-level 2 done:** at least the canary machine earns `attested-confidential`
  end-to-end (Phase 9 criteria), a confidential request seals at the client edge and
  the receipt verifies, and the negative path returns `confidential-unavailable`. From
  there it is enrollment volume, not new capability.
