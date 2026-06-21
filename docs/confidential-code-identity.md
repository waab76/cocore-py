# Confidential tier: APNs code identity (closing the cdHash gap)

## Why

The confidential tier proved a genuine Apple device (MDA chain bound to the
signing key) running a hardened binary — but the binary's identity (`cdHash`)
was **self-reported via `csops`**. A prompt-logging fork on genuine hardware
could claim a blessed cdHash, sign it with its own SE key, present its own MDA
chain, and pass. The audit against darkbloom/d-inference confirmed they close
exactly this with an **AMFI-gated APNs code-identity challenge**, which we did
not have. This is the work that closes it.

## Mechanism

Only a process signed with our Developer ID + App ID (`dev.cocore.provider`) +
the embedded provisioning profile can register for / receive an APNs push for
our topic — Apple's kernel (AMFI) enforces this at launch. So:

1. The **measured agent** (the binary that holds the X25519 key `K` and the SE
   signing key and runs in-process inference) registers for APNs and reports its
   device token in `Register`.
2. The **advisor** seals a fresh nonce to `K` (`nacl.box`) and pushes it to that
   token (`E_K(nonce)`), on register and on the standing ~5-min re-challenge.
3. The agent receives the push (proof it's the genuine AMFI-gated binary),
   opens it with `K` (proof it holds the attested decryption key), and returns
   the recovered nonce + an SE signature over `{nonce}` (`CodeAttestationResponse`).
4. The advisor verifies and sets `codeAttested`; `confidentialEligible` now
   requires it (when APNs enforcement is on).

A re-signed fork **cannot receive the push at all** — proven both directions by
the S5 spike (`provider/spikes/apns`), on real hardware: genuine binary →
token + push delivered; ad-hoc-signed fork with the identical bundle id →
*"Application not properly entitled for push notifications"*, no token.

## What changed (all behind additive/off-by-default switches)

- **Agent (Rust + Swift):** `protocol.rs` (+`apns_device_token`,
  `CodeAttestationResponse`); `advisor.rs` (`recover_code_challenge`,
  `handle_code_challenge_payload`, `build_code_attestation_response` — unit-tested,
  no Cocoa); `push_host.rs` + `CoCoreMLX/PushHost.swift` (the AppKit receiver,
  cfg `target_os="macos" + feature="apns"`); `cocore-provider.entitlements`
  (+`aps-environment=production`).
- **Advisor (TS):** `apns.ts` (ES256 `.p8` JWT + seal + sender), `attest.ts`
  (`verifyCodeAttestation`), `registry.ts` (`codeAttested` field +
  `markCodeAttested`/`dropCodeAttested` + enforcement-gated `confidentialEligible`),
  `connection.ts` (issue challenge on register + each re-challenge; verify
  response), `main.ts` (`loadApnsConfig`, enforcement flag, `/providers` exposes
  `codeAttested`).
- **Verifier (SDK + py):** `verify-provider.ts` / `verify.py` add
  `codeAttested` / `requireCodeAttested` (the `code-not-attested` gate).
- **Surface:** the console + tray `confidential` flag already derives from the
  advisor's `confidentialEligible`, so the existing 🔒 badge tightens
  automatically once enforcement is on — no redundant UI.

## Two honest carve-outs

1. **Coordinator trust (invariant #2).** The code-identity proof is interactive
   (advisor↔agent over APNs), so it is **advisor-asserted, not offline-verifiable
   from a receipt**. There is no macOS API that attests running-code identity
   offline for a Developer-ID app (App Attest doesn't cover non-App-Store macOS
   distribution — likely why darkbloom also chose APNs). This is a second
   carve-out on top of the invariant-#5 one the confidential tier already took.
2. **The shared ceiling.** This does NOT raise the ultimate ceiling: a binary
   signed with a *stolen* `dev.cocore` team key could still pass. That residual
   is identical to darkbloom's own stated limit; mitigation is the same
   (reproducible builds + transparency log + signing-key hygiene).

## Rollout safety

`confidentialEligible` is gated on `codeAttested` **only when the advisor has
APNs configured** (`enforceCodeAttestation`), mirroring darkbloom's
live-configurable rollout — existing confidential machines don't break the
moment this ships. Headless/launchd installs can't get a GUI session → can't
receive APNs → stay best-effort (a documented limitation darkbloom shares).

## Remaining seams (not in this change)

- **Agent main-thread Cocoa handoff (live-only).** `push_host::run_blocking`
  must run on the process main thread (`NSApplication.run`) with the tokio serve
  loop on workers, and the serve loop must route `push_rx` →
  `handle_code_challenge_payload` → send the frame, and await the device token
  before `Register`. The crypto + transport are done and tested/compiled; this
  wiring is exercised only on a notarized agent in a GUI session (the same
  environment the S5 spike validated). Gated by the `apns` feature so default/CI
  builds are unaffected.
- **Ops (human).** Rotate the `.p8` (it was exposed in chat); set
  `APNS_AUTH_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` on the advisor
  (Railway); embed the `dev.cocore.provider` provisioning profile in the
  notarized agent bundle at release; register the shipped cdHash in the
  known-good set. Apple artifacts already created (Team `4L45P7CP9M`).
- **Gap #2 (parallel).** Wire the producer-side MDA freshness binding live
  (`infra/mdm` runbook `TODO(ops)`), required before the tier can be *earned* at
  all on a live machine.
