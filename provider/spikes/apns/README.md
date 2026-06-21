# S5 — APNs code-identity round-trip spike

**Phase 0 de-risk for the APNs code-identity fix** (closing the self-reported-cdHash
gap vs darkbloom/d-inference). Question: can a **Developer-ID-signed, non-App-Store,
notarized-distribution** Mac app receive an APNs push — and is a non-genuine binary
**blocked** from doing so? Both must hold for the AMFI-gated code-identity challenge
to be real.

## Result: ✅ PASS (both directions), 2026-06-20

| Test | Outcome |
|---|---|
| Genuine app registers for APNs | ✅ device token issued |
| Advisor (.p8 ES256 JWT) → `api.push.apple.com` | ✅ HTTP 200, push accepted |
| Push delivered to app delegate | ✅ payload intact (`spike: hello-from-advisor`) |
| **Fork** (ad-hoc signed, no profile/entitlement) registers | ✅ **rejected** — `Application not properly entitled for push notifications`, no token |

The custom payload field rode through untouched — that's where the real
`E_K(nonce)` will go. The fork shared the **identical bundle id** `dev.cocore.provider`
and identical code, yet AMFI still refused it because it lacked the Developer ID
signature + embedded provisioning profile. That is the un-forgeable property the
fix depends on: only the genuine, team-signed binary can receive a push for our topic.

## What this proves / doesn't

- **Proves:** the AMFI-gated channel works for our exact distribution model (Developer
  ID, outside the App Store), and a re-signed fork cannot impersonate the topic.
- **Does not prove (by design, same as darkbloom):** exact cdhash/version. That stays
  the job of reproducible builds + a transparency log of blessed cdhashes. APNs only
  bootstraps "this is genuinely our App ID / Team ID binary" so the self-reported hash
  becomes meaningful.
- Notarization was **not** required just to get a token (we ran un-notarized). The real
  agent will still be notarized for Gatekeeper launch.

## Artifacts (in this dir)

- `receiver/` — minimal AppKit app: registers, prints device token, prints any push.
- `sender/send.swift` — advisor stand-in: ES256 JWT from the `.p8` (CryptoKit, raw
  R||S — no pip, no DER fiddling) + HTTP/2 POST to the production gateway.
- `build-receiver.sh` — compiles + Developer-ID-signs the `.app` with the embedded
  profile + `aps-environment=production` entitlements.

## Reproduce

```bash
./build-receiver.sh                       # build + sign the genuine app
./build/APNSReceiver.app/Contents/MacOS/APNSReceiver > receiver.log 2>&1 &   # get a token
swiftc -O sender/send.swift -o build/apns-send
./build/apns-send ~/Downloads/AuthKey_<KEYID>.p8 <KEYID> 4L45P7CP9M dev.cocore.provider "$(cat device-token.txt)"
# watch receiver.log for APNS-SPIKE-PUSH
```

Inputs (Team `4L45P7CP9M`, App ID `dev.cocore.provider`): the `.p8` auth key (Key ID),
and the Developer ID provisioning profile carrying `aps-environment=production`.
**The `.p8` is a secret** — it is gitignored here and belongs in the advisor's Railway
env (`APNS_AUTH_KEY`) for the real implementation, never in the repo.

## Next (real implementation)

1. Agent-side push host (AppKit host inside the measured `cocore` agent — the binary
   that holds `K` + the SE key, **not** the shell) + `aps-environment` entitlement +
   embedded profile.
2. Advisor-side sender + per-connection challenge/verify; gate `confidentialEligible`
   on a live code-attestation **and** a bound MDA chain; drop on disconnect/failure.
