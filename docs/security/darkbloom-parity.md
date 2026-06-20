# darkbloom parity map

How each darkbloom (d-inference, Eigen Labs — proprietary; studied for architecture
only, never copied) confidential-compute mechanism maps onto cocore. Source of the
analysis: the reference checkout + their docs/papers. cocore keeps its invariants
(provider PDS = source of truth; AppView/advisor are accelerators, not ledgers) so
where darkbloom puts a mechanism in a central coordinator, cocore puts the *evidence*
in provider-signed records and the *check* in a fail-closed client/advisor verifier.

| # | darkbloom mechanism | cocore status | Workstream |
|---|---|---|---|
| 1 | In-process inference (MLX-Swift), no subprocess/IPC; prompt decrypted in-process | **GAP** — today an owner-controlled Python subprocess serves; need a native in-process engine | WS-ENGINE |
| 2 | Precompiled `mlx.metallib`, no runtime JIT; `com.apple.security.hypervisor`, no `get-task-allow` | **GAP** — entitlements + signed metallib | WS-ENGINE / WS-AGENT-SIGNING |
| 3 | `binaryHash` (SHA-256 self-hash) bound in SE-signed attestation | **HAVE** — `attestation.binaryHash` + `selfSignature` | done |
| 4 | metallib + runtime/template hashes attested (`template_hashes`) | **GAP** — add `metallibHash` (+ optional runtime manifest) | WS-CDHASH lexicon + producer |
| 5 | OS-enforced cdhash measurement | **BONUS over darkbloom** — S3 proved live cdhash == codesign; richer than their self-hash | WS-CDHASH |
| 6 | Posture: SIP, SecureBoot, AuthenticatedRoot, SE available, RDMA disabled | **HAVE** in lexicon; **need** producer to read them honestly + hardened-runtime/LV/getTaskAllow | WS-CDHASH |
| 7 | Process hardening as gated capabilities: anti-debug (PT_DENY_ATTACH), core dumps off (RLIMIT_CORE=0), env scrub (DYLD_*), in-process backend, proxy disabled | **GAP** — implement in the Rust agent + expose as posture booleans | WS-HARDENING |
| 8 | Apple MDA cert chain → Apple Enterprise Attestation Root; leaf bound to SE key; SIP/SecureBoot via cert OIDs; serial cross-check; freshness-code = sha256(SE pubkey) | **HAVE** verify (`mda.rs`/`mda.ts` + binding); **GAP** producing a real chain (`cocore-mda-attest`) | WS-VERIFY / S4 |
| 9 | Per-request ephemeral X25519 key, forward secrecy; requester seals to it | **PARTIAL** — seal exists but to long-lived key; need enclave-signed ephemeral session key | WS-EPHEMERAL |
| 10 | 5-min challenge-response; sign nonce+timestamp with SE; re-verify SIP/posture/binaryHash each cycle; fail-closed; freshness window for routing | **PARTIAL** — advisor already does 5-min nonce; **GAP** re-verify posture + known-good + drop confidential eligibility | WS-COORDINATOR |
| 11 | Known-good build set: CI POSTs release hashes; coordinator verifies artifact; `binaryHash ∈ set` enforced on challenge; public `/releases/latest`; revoke via Active flag | **GAP** — advisor/appview known-good set + release feed | WS-COORDINATOR |
| 12 | APNs code-identity attestation (strongest gate): push E_K(nonce); only genuine Developer-ID app can receive+decrypt+SE-sign → proves binary is genuine | **OUT (heavy)** — cocore reaches the same "no modified code" guarantee via measured-identity ∈ known-good + SIP immutability + MDA binding; APNs is optional defense-in-depth | (future) |
| 13 | Fail-closed routing gate: every check must pass or no private-text routing; no degraded fallback | **HAVE (client)** — `verifyProviderForSeal` fails closed; mirror in advisor + python | WS-VERIFY/COORDINATOR |
| 14 | Crypto: NaCl crypto_box (X25519+XSalsa20-Poly1305), P-256 ECDSA SE sigs, sorted-key canonical JSON | **HAVE** — `crypto_box`, `canonical.ts`, p256 | done |
| 15 | Tiers: none / self_signed / hardware (+ code-attested) | **HAVE** `trustLevel` + new `tier` (best-effort / attested-confidential) | WS-TIERS |

## The one structural difference (kept on purpose)

darkbloom's coordinator is **in the plaintext path** (decrypts for routing/billing
inside a CVM, re-encrypts per-request to the provider). cocore's confidential tier
seals at the **client edge** so no cocore service sees plaintext; the advisor only
relays ciphertext + verified metadata and the provider record stays the source of
truth. This is *stronger* than darkbloom on the coordinator-trust axis and keeps
invariant #5.

## What this environment can and cannot finish

- **Can build + test here:** WS-CDHASH (Rust+Swift, no Metal), WS-HARDENING,
  WS-EPHEMERAL, WS-VERIFY (ts done; python), WS-COORDINATOR, WS-TIERS, the signing
  scripts/entitlements (S3-derived).
- **Cannot finish here (needs full Xcode + notarization creds):** WS-ENGINE build +
  GPU run, and the notarization step of WS-AGENT-SIGNING. Code is written
  feature-gated and ready; the metallib/no-JIT design question is answered by the
  reference (S1).
