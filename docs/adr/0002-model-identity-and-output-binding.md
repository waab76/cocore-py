# ADR-0002: Model-identity binding and output-verification for receipts

Status: proposed
Date: 2026-07-01

## Context

A public exploit thread (Astra, 2026-07-01) demonstrated that co/core's
trust boundaries were self-asserted by the provider and taken at face value
by the backend. Four distinct issues were shown against a live
`/verified/chat/completions` endpoint:

1. **Attestation not bound to the serving machine.** An attested Mac and an
   unattested Linux box registered under one DID; confidential/attested
   requests routed to the unattested node ~80% of the time, which then read
   the plaintext prompt and served whatever it liked.
2. **Confidential prompts exfiltrated** to a public Bluesky account.
3. **Model impersonation** — the provider self-asserts `model` in the
   response/receipt; nothing binds returned tokens to the model that ran.
4. **Junk-drain + self-credit** — the provider self-reports `tokens`,
   derives `price` from them, and is both billed-against and credited on
   that number, so it can charge the requester up to the authorized ceiling
   for near-zero real work.

Issues (1) and (2)'s live vector are fixed in the same change set as this
ADR (machine-scoped verified allow-set; see
`packages/console/src/lib/verified-standing.server.ts::resolveVerifiedProviderKeys`).
Issue (4) is **partially** fixed there too: the receipt-vs-job validator now
rejects `receipt.tokens.out > job.maxTokensOut`
(`packages/sdk/src/validate.ts`, finding `tokens-over-job-ceiling`), bounding
the token record to what the requester authorized.

This ADR covers the two remaining problems that need a *design* change, not a
one-line gate: **binding the returned output to the model that actually ran
(issue 3)** and **the residual junk-for-authorized-amount half of issue 4**.
Both are noted as gaps in ADR-0001 (Apple MDA / in-process inference
milestones) and in the 2026-06 audit.

## Problem statement

The receipt commits to `model`, `inputCommitment`, `outputCommitment`,
`tokens`, and an `enclaveSignature`. What it does **not** prove:

- **Which model produced the output.** `model` is an opaque string the
  provider writes. A provider can label a Gemma-4-26B response as any model
  id, or return output from no model at all.
- **That the output bytes are genuine model work.** `outputCommitment` is a
  hash of whatever bytes the provider chose to return. A requester can
  recompute it to detect *tampering in transit*, but nothing forces those
  bytes to be real inference over the committed input under the committed
  model.

The economic consequence (issue 4 residual): under pre-authorization, the
exchange settles any valid receipt against the requester's payment
authorization up to `priceCeiling`. A provider that returns
`maxTokensOut` worth of junk publishes a perfectly valid receipt and is
credited for it. The token-ceiling gate stops *over-claiming*; it does not
make junk detectable.

## Options considered

### A. Model-weights fingerprint in the attestation, strong-ref'd from the receipt
The measured binary computes a fingerprint of the loaded model (e.g. a hash
over the weights / manifest) and includes it in the signed attestation. The
receipt already strong-refs an attestation; add a `modelFingerprint` (or
reuse the attestation ref + a `model` allow-list the attestation carries) so
`(model id -> fingerprint)` is attested, not self-asserted. A requester/AppView
verifies the receipt's `model` maps to a fingerprint the attestation vouches
for.

- Pro: keeps the "receipt + lexicon + DID doc verifies offline" invariant.
  No coordinator.
- Con: only as strong as the attestation's measured-boundary. A provider
  that runs the real weights but swaps the sampling/output still passes.
  Requires the in-process (native) engine to be load-bearing (ADR-0001 M2).

### B. Output-verification / dispute record
Mint a `dev.cocore.compute.dispute` (or extend settlement) so a requester who
decrypts the output and finds it inconsistent (empty, wrong language, doesn't
follow the committed input) can publish a signed dispute that the exchange and
future requesters weigh into provider standing. Settlement optionally holds a
challenge window before crediting.

- Pro: catches the junk case A can't (real weights, junk output). Federable.
- Con: subjective ("is this output good?") unless paired with a
  deterministic re-execution oracle; adds a settlement-latency window.

### C. Deterministic re-execution oracle
A verifier re-runs the inference (fixed seed, greedy decode) and checks the
output matches. Strongest, but expensive, requires reproducible decoding
across hardware, and reintroduces a privileged verifier — smells like a
coordinator. Rejected as the default; may fit as an opt-in audit.

## Recommendation (to ratify)

- **Adopt A as the model-identity primitive** (lexicon-additive:
  `modelFingerprint` on the attestation, verified in `validate.ts` /
  `verify-provider.ts`), gated on the native in-process engine being the only
  path that can reach the confidential tier — which the issue-1 fix already
  enforces.
- **Adopt B for the economic residual**, minimally: a challenge window +
  signed dispute record feeding provider standing, so junk-for-authorized is
  detectable and costly rather than free. Keep it federable (no privileged
  verifier).
- Defer C to an opt-in audit tool.

Per CLAUDE.md, this is lexicon-first: land the `modelFingerprint` /
`dispute` lexicon changes (with version bumps) in their own PR before any
provider/consumer code assumes them. This ADR is the rationale that PR
references.

## Consequences

- Requesters gain a cryptographic answer to "did the model I asked for
  actually run?", not just "were the bytes tampered with in transit?".
- The confidential tier's guarantee tightens from "verified hardware +
  hardened runtime" to also "attested model identity".
- Nothing here introduces a coordinator; all new state is
  provider/requester-signed records under `dev.cocore.*`.

## Status of the sibling fixes (this change set, not this ADR)

- Machine-scoped verified allow-set — DONE
  (`resolveVerifiedProviderKeys`, regression test in
  `packages/console/src/lib/inference-dispatch.test.ts`).
- `tokens.out <= job.maxTokensOut` enforcement — DONE
  (`packages/sdk/src/validate.ts`, `tokens-over-job-ceiling`).
- Confidential-tier badge/doc wording softened to a hardened-runtime posture
  — DONE (`packages/console/src/components/TrustTierBadge.tsx`).
