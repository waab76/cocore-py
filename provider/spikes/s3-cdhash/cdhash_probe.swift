// S3 spike — read the running process's OS-enforced code-signing identity.
//
// Goal: prove we can extract, from the LIVE process (not a file digest), the
// values WS-CDHASH needs for the attestation:
//   * cdHash               — the code-directory hash the OS actually enforces
//   * teamId               — Apple Developer Team Identifier
//   * hardenedRuntime      — CS_RUNTIME
//   * libraryValidation    — CS_REQUIRE_LV
//   * getTaskAllow         — CS_GET_TASK_ALLOW (MUST be false for confidential)
//
// Then we compare cdHash + teamId against `codesign -dvvv` to confirm the
// SecCode path agrees with what the toolchain reports. This is the spike that
// gates the real provider/src/codesign.rs (or the CoCoreEnclave Swift bridge).
//
// APIs: SecCodeCopySelf → SecCodeCopyStaticCode → SecCodeCopySigningInformation
// with kSecCSSigningInformation | kSecCSDynamicInformation, reading
// kSecCodeInfoUnique (cdhash), kSecCodeInfoTeamIdentifier, kSecCodeInfoFlags.

import Foundation
import Security

// Code Signing flags (mach-o cs_blobs.h). We only need these four.
let CS_GET_TASK_ALLOW: UInt32 = 0x0000_0004
let CS_REQUIRE_LV: UInt32 = 0x0000_2000  // library validation
let CS_RUNTIME: UInt32 = 0x0001_0000  // hardened runtime

func hex(_ data: Data) -> String {
    data.map { String(format: "%02x", $0) }.joined()
}

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(Data((msg + "\n").utf8))
    exit(1)
}

// 1. SecCode for the running process.
var code: SecCode?
var status = SecCodeCopySelf(SecCSFlags(rawValue: 0), &code)
guard status == errSecSuccess, let code else { fail("SecCodeCopySelf failed: \(status)") }

// 2. Convert to a static code so we can read full signing information.
var staticCode: SecStaticCode?
status = SecCodeCopyStaticCode(code, SecCSFlags(rawValue: 0), &staticCode)
guard status == errSecSuccess, let staticCode else {
    fail("SecCodeCopyStaticCode failed: \(status)")
}

// 3. Pull signing + dynamic information in one dictionary.
let infoFlags = SecCSFlags(rawValue: kSecCSSigningInformation | kSecCSDynamicInformation)
var infoCF: CFDictionary?
status = SecCodeCopySigningInformation(staticCode, infoFlags, &infoCF)
guard status == errSecSuccess, let info = infoCF as? [String: Any] else {
    fail("SecCodeCopySigningInformation failed: \(status)")
}

// cdHash — kSecCodeInfoUnique is the designated code-directory hash, the same
// value `codesign -dvvv` prints as `CDHash=`.
guard let uniqueData = info[kSecCodeInfoUnique as String] as? Data else {
    fail("no kSecCodeInfoUnique (process is unsigned?)")
}
let cdHash = hex(uniqueData)

// teamId — absent for ad-hoc / unsigned.
let teamId = (info[kSecCodeInfoTeamIdentifier as String] as? String) ?? "(none)"

// CS flags — kSecCodeInfoFlags is the code-directory flags word.
let flags = (info[kSecCodeInfoFlags as String] as? UInt32) ?? 0
let hardenedRuntime = (flags & CS_RUNTIME) != 0
let libraryValidation = (flags & CS_REQUIRE_LV) != 0
let getTaskAllow = (flags & CS_GET_TASK_ALLOW) != 0

// Emit machine-readable so the harness script can diff against codesign.
let out: [String: Any] = [
    "cdHash": cdHash,
    "teamId": teamId,
    "flags": String(format: "0x%x", flags),
    "hardenedRuntime": hardenedRuntime,
    "libraryValidation": libraryValidation,
    "getTaskAllow": getTaskAllow,
]
let json = try! JSONSerialization.data(withJSONObject: out, options: [.sortedKeys, .prettyPrinted])
print(String(data: json, encoding: .utf8)!)
