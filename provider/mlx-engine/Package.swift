// swift-tools-version:5.9
import PackageDescription

// CoCoreMLX: native in-process MLX inference engine the Rust agent links over a
// C ABI (mirrors provider/enclave). Uses the upstream, Apache-2.0 MLX-Swift
// stack (NOT darkbloom's proprietary code) — the same libraries darkbloom's
// provider-swift builds on. The prompt is decrypted + run entirely inside this
// statically-linked code, so the measured `cocore` binary covers it.
let package = Package(
    name: "CoCoreMLX",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "CoCoreMLX", type: .static, targets: ["CoCoreMLX"]),
        // Standalone harness to prove MLX runs + streams tokens in-process,
        // independent of the Rust link.
        .executable(name: "cocore-mlx-smoke", targets: ["cocore-mlx-smoke"]),
    ],
    dependencies: [
        // High-level LLM API (MLXLLM, MLXLMCommon) — pulls mlx-swift +
        // swift-transformers transitively. Pinned to a release for
        // reproducibility (the known-good set depends on a stable build).
        .package(url: "https://github.com/ml-explore/mlx-swift-examples", from: "2.21.0"),
    ],
    targets: [
        .target(
            name: "CoCoreMLX",
            dependencies: [
                .product(name: "MLXLLM", package: "mlx-swift-examples"),
                .product(name: "MLXLMCommon", package: "mlx-swift-examples"),
            ],
            path: "Sources/CoCoreMLX",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "cocore-mlx-smoke",
            dependencies: ["CoCoreMLX"],
            path: "Sources/cocore-mlx-smoke"
        ),
    ]
)
