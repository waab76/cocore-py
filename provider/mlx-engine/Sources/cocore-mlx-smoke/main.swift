// Proves the native MLX engine loads a model and streams tokens IN-PROCESS,
// independent of the Rust link. Usage:
//   cocore-mlx-smoke <model-dir> [prompt]
// Exit 0 + streamed tokens = the long-pole confidential property is real.

import CoCoreMLX
import Foundation

let args = CommandLine.arguments
guard args.count >= 2 else {
    FileHandle.standardError.write(Data("usage: cocore-mlx-smoke <model-dir> [prompt]\n".utf8))
    exit(2)
}
let modelDir = args[1]
let prompt = args.count >= 3 ? args[2] : "In one sentence, what is the Apple Secure Enclave?"

let sem = DispatchSemaphore(value: 0)
var failed = false

Task {
    defer { sem.signal() }
    do {
        FileHandle.standardError.write(Data("[smoke] loading \(modelDir)\n".utf8))
        let engine = try await MLXEngine.load(modelDir: modelDir)
        FileHandle.standardError.write(
            Data("[smoke] loaded; metallibHash=\(engine.metallibHash ?? "nil")\n".utf8))
        FileHandle.standardError.write(Data("[smoke] prompt: \(prompt)\n[smoke] output: ".utf8))
        let (tin, tout) = try await engine.generate(prompt: prompt, maxTokens: 64) { delta in
            FileHandle.standardOutput.write(Data(delta.utf8))
        }
        FileHandle.standardError.write(Data("\n[smoke] OK tokensIn=\(tin) tokensOut=\(tout)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("[smoke] ERROR: \(error)\n".utf8))
        failed = true
    }
}
sem.wait()
exit(failed ? 1 : 0)
