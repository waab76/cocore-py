// Native in-process MLX inference engine. The prompt is decrypted by the Rust
// agent and handed here; generation runs entirely inside this statically-linked
// code (no subprocess, no IPC), so the measured `cocore` binary covers it.
//
// Built on the upstream Apache-2.0 MLX-Swift stack (MLXLLM / MLXLMCommon) — the
// same libraries darkbloom's provider-swift uses, NOT their proprietary code.

import Foundation
import MLXLLM
import MLXLMCommon
import CryptoKit

public final class MLXEngine {
    private let container: ModelContainer
    public let metallibHash: String?

    private init(container: ModelContainer, metallibHash: String?) {
        self.container = container
        self.metallibHash = metallibHash
    }

    /// Load an MLX model (safetensors weights + tokenizer) from a local
    /// directory into this process. No network — the directory is the
    /// already-downloaded HF snapshot.
    public static func load(modelDir: String) async throws -> MLXEngine {
        let config = ModelConfiguration(directory: URL(fileURLWithPath: modelDir))
        let container = try await LLMModelFactory.shared.loadContainer(configuration: config)
        return MLXEngine(container: container, metallibHash: locateMetallibHash())
    }

    /// Stream a completion token-by-token through `onDelta`, in-process.
    /// Returns (promptTokenCount, generationTokenCount) for the receipt.
    public func generate(
        prompt: String, maxTokens: Int, onDelta: (String) -> Void
    ) async throws -> (Int, Int) {
        let params = GenerateParameters(maxTokens: maxTokens)
        var tokensIn = 0
        var tokensOut = 0
        let stream: AsyncStream<Generation> = try await container.perform {
            (context: ModelContext) in
            let input = try await context.processor.prepare(
                input: UserInput(chat: [.user(prompt)]))
            return try MLXLMCommon.generate(input: input, parameters: params, context: context)
        }
        for await item in stream {
            switch item {
            case .chunk(let text):
                onDelta(text)
            case .info(let info):
                tokensIn = info.promptTokenCount
                tokensOut = info.generationTokenCount
            case .toolCall:
                break
            }
        }
        return (tokensIn, tokensOut)
    }

    /// Locate the precompiled `mlx.metallib` the GPU kernels load and hash it
    /// (SHA-256 hex) so the attestation can pin it. Search order mirrors
    /// darkbloom's: env override, sibling of the executable, then any
    /// `*.metallib` bundled under the executable's directory tree.
    static func locateMetallibHash() -> String? {
        guard let url = locateMetallib() else { return nil }
        guard let data = try? Data(contentsOf: url) else { return nil }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func locateMetallib() -> URL? {
        let fm = FileManager.default
        if let env = ProcessInfo.processInfo.environment["MLX_METALLIB_PATH"],
            !env.isEmpty, fm.fileExists(atPath: env)
        {
            return URL(fileURLWithPath: env)
        }
        let exe = URL(fileURLWithPath: CommandLine.arguments.first ?? "")
            .resolvingSymlinksInPath()
        let dir = exe.deletingLastPathComponent()
        let candidates = [
            dir.appendingPathComponent("mlx.metallib"),
            dir.appendingPathComponent("default.metallib"),
        ]
        for c in candidates where fm.fileExists(atPath: c.path) { return c }
        // Fall back to scanning bundled resources (SwiftPM places Cmlx's
        // metallib under a *.bundle next to the binary during dev builds).
        if let en = fm.enumerator(at: dir, includingPropertiesForKeys: nil) {
            for case let u as URL in en where u.pathExtension == "metallib" {
                return u
            }
        }
        return nil
    }
}
