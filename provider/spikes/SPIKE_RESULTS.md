# Confidential-compute de-risking spikes — results

Host: Apple Silicon, macOS (Darwin 25.4), Xcode CLT only (no full Xcode),
Developer ID Application identity present (Team `4L45P7CP9M`).

## S3 — live-process cdhash extraction ✅ PASS

`provider/spikes/s3-cdhash/cdhash_probe.swift` reads the running process's
OS-enforced signing identity via
`SecCodeCopySelf → SecCodeCopyStaticCode → SecCodeCopySigningInformation`
(`kSecCSSigningInformation | kSecCSDynamicInformation`) and reads:

| field | source key | result |
|---|---|---|
| `cdHash` | `kSecCodeInfoUnique` | **matches `codesign -dvvv` `CDHash=` byte-for-byte** |
| `teamId` | `kSecCodeInfoTeamIdentifier` | `4L45P7CP9M` ✓ |
| `hardenedRuntime` | `kSecCodeInfoFlags & CS_RUNTIME (0x10000)` | ✓ |
| `getTaskAllow` | `kSecCodeInfoFlags & CS_GET_TASK_ALLOW (0x4)` | `false` ✓ |
| `libraryValidation` | `kSecCodeInfoFlags & CS_REQUIRE_LV (0x2000)` | see finding |

**Finding (updates WS-CDHASH + WS-AGENT-SIGNING):** `codesign --options runtime`
alone does **not** set `CS_REQUIRE_LV` — flags come out `0x10000`, so a
flag-based `libraryValidation` reads `false` even though the hardened runtime
enforces LV at load time. Signing with **`--options runtime,library`** sets the
bit (flags `0x12000`, `library-validation,runtime`) and the probe then reads
`libraryValidation: true`.

Therefore:
- **WS-AGENT-SIGNING** must sign the worker with `--options runtime,library`
  (not just `runtime`) so the posture is measurable and maximally strict.
- **WS-CDHASH** measures `libraryValidation` from the `CS_REQUIRE_LV` flag bit;
  the four CS flag constants used are pinned in `cdhash_probe.swift`.
- The `SecCode` path is the one to port into `provider/src/codesign.rs` (or the
  `CoCoreEnclave` Swift bridge) for WS-CDHASH — it is self-contained, needs no
  Metal toolchain, and agrees with the toolchain ground truth.

Reproduce: `provider/spikes/s3-cdhash/run.sh`.

## S1 — Metal under hardened runtime / `.metallib`  ✅ ANSWERED (by reference) / build-run DEFERRED

**Environment blocker:** this host has Xcode **Command Line Tools only** — no full
Xcode, so `xcrun metal`/`metallib` are absent and `xcodebuild -downloadComponent
MetalToolchain` fails (`requires Xcode`). MLX builds from source compile `.metal`
shaders, so the native engine cannot be **built** here; the "run one GPU matmul
under a notarized hardened-runtime binary" acceptance test is deferred to a host
with full Xcode.

**But the core S1 question is answered by the darkbloom reference**
(`/Users/dgaff/Code/d-inference-ref/provider-swift`):
- They run inference **in-process via MLX-Swift** and ship a **precompiled
  `mlx.metallib`** colocated with the binary, loaded at runtime (the process
  *crashes* if it's missing — "Failed to load the default metallib"). So **standard
  inference needs NO runtime shader JIT** — the precompiled-metallib path works.
- Their entitlement for GPU/DMA isolation is **`com.apple.security.hypervisor`**,
  and they deliberately omit `get-task-allow`. They do **not** rely on `allow-jit`.
- They **measure the metallib hash** and bind it into attestation
  (`template_hashes["mlx_metallib"]`). → cocore parity: attest a `metallibHash`.

**Conclusion for WS-ENGINE:** target a precompiled, signed `mlx.metallib`; do not
set `allow-jit`; measure + attest the metallib hash. The only runtime-JIT path in
MLX is the opt-in `mx.fast.metal_kernel`, which the engine simply must not use.

## S2 — native MLX token streaming  ✅ ANSWERED (by reference) / build-run DEFERRED

Same toolchain blocker (no Metal compiler). The reference proves the design:
darkbloom streams tokens in-process via `mlx-swift` + `mlx-swift-lm` (no subprocess,
no IPC), decrypting the prompt inside the provider process. This validates the
plan's core requirement (prompt lives in the measured binary).

**Course-correction worth noting:** darkbloom uses **MLX-Swift**, not Rust+mlx-rs.
cocore already has a Swift FFI bridge (`provider/enclave`). A Swift in-process
engine (driven from the Rust agent over the existing C-ABI) is the *proven* path and
may be preferable to mlx-rs. Flagged for the engine work; the user previously locked
mlx-rs. Either way the build+GPU run needs a full-Xcode host.
