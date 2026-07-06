// SecureEnclaveIdentity: persistent P-256 signing identity backed by
// the Apple Secure Enclave.
//
// Threat model: the private key never leaves the Secure Enclave. Even
// the machine owner with root access cannot read it, only ask the
// enclave to sign with it. If the chip is replaced or the keychain
// item is destroyed, the identity is gone — receipts signed by it
// remain verifiable from the published public key, but the agent
// will need to register a fresh `dev.cocore.compute.provider` record.
//
// Storage: we put a "key reference" (not the key bytes — just the
// keychain handle the Secure Enclave uses internally) into the
// generic-keychain item-class, scoped to the cocore-provider bundle
// id so other apps can't enumerate it.
//
// FFI: this file exposes a minimal C-ABI matching include/CoCoreEnclave.h.
// The Rust agent loads the static library via build.rs (M5).

import CryptoKit
import Foundation
import LocalAuthentication
import Security

private let kKeychainTag = "dev.cocore.provider.enclave-identity.v1".data(using: .utf8)!
private let kEncKeychainTag = "dev.cocore.provider.enclave-enc.v1".data(using: .utf8)!
private let kAccessGroup = "dev.cocore.provider"

@_cdecl("cocore_enclave_create_or_load")
public func cocore_enclave_create_or_load(outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32 {
    do {
        let id = try SecureEnclaveIdentity.loadOrCreate()
        let unmanaged = Unmanaged.passRetained(id)
        outHandle.pointee = UnsafeMutableRawPointer(unmanaged.toOpaque())
        return 0
    } catch {
        NSLog("cocore enclave create_or_load failed: \(error)")
        return -1
    }
}

@_cdecl("cocore_enclave_public_key")
public func cocore_enclave_public_key(
    handle: UnsafeMutableRawPointer?,
    out: UnsafeMutablePointer<UInt8>?,
    len: Int
) -> Int32 {
    guard let handle, let out, len >= 64 else { return -1 }
    let id = Unmanaged<SecureEnclaveIdentity>.fromOpaque(handle).takeUnretainedValue()
    let bytes = id.publicKeyRaw64()
    bytes.withUnsafeBytes { src in
        out.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: 64)
    }
    return 0
}

@_cdecl("cocore_enclave_sign")
public func cocore_enclave_sign(
    handle: UnsafeMutableRawPointer?,
    data: UnsafePointer<UInt8>?,
    dataLen: Int,
    outSig: UnsafeMutablePointer<UInt8>?,
    outSigLen: UnsafeMutablePointer<Int>?
) -> Int32 {
    guard let handle, let data, let outSig, let outSigLen else { return -1 }
    let id = Unmanaged<SecureEnclaveIdentity>.fromOpaque(handle).takeUnretainedValue()
    let payload = Data(bytes: data, count: dataLen)
    do {
        let sig = try id.sign(payload)
        let cap = outSigLen.pointee
        guard sig.count <= cap else {
            outSigLen.pointee = sig.count
            return -2
        }
        sig.withUnsafeBytes { src in
            outSig.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: sig.count)
        }
        outSigLen.pointee = sig.count
        return 0
    } catch {
        NSLog("cocore enclave sign failed: \(error)")
        return -3
    }
}

@_cdecl("cocore_enclave_release")
public func cocore_enclave_release(handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    Unmanaged<SecureEnclaveIdentity>.fromOpaque(handle).release()
}

// MARK: - Encryption key (P-256 KeyAgreement / ECDH) FFI

@_cdecl("cocore_enclave_enc_create_or_load")
public func cocore_enclave_enc_create_or_load(outHandle: UnsafeMutablePointer<UnsafeMutableRawPointer?>) -> Int32 {
    do {
        let key = try SecureEnclaveEncKey.loadOrCreate()
        let unmanaged = Unmanaged.passRetained(key)
        outHandle.pointee = UnsafeMutableRawPointer(unmanaged.toOpaque())
        return 0
    } catch {
        NSLog("cocore enclave enc create_or_load failed: \(error)")
        return -1
    }
}

@_cdecl("cocore_enclave_enc_public_key")
public func cocore_enclave_enc_public_key(
    handle: UnsafeMutableRawPointer?,
    out: UnsafeMutablePointer<UInt8>?,
    len: Int
) -> Int32 {
    guard let handle, let out, len >= 64 else { return -1 }
    let key = Unmanaged<SecureEnclaveEncKey>.fromOpaque(handle).takeUnretainedValue()
    let bytes = key.publicKeyRaw64()
    bytes.withUnsafeBytes { src in
        out.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: 64)
    }
    return 0
}

/// Raw ECDH: scalar-mult our SE-resident private key with `peerPub` (64-byte
/// uncompressed `X || Y`) and write the 32-byte shared X-coordinate into
/// `outShared`. The shared secret is NOT the final key — the Rust caller runs
/// HKDF-SHA256 over it (see `crypto::ecies`) so the construction is reproducible
/// cross-language. The private key never leaves the enclave.
@_cdecl("cocore_enclave_enc_ecdh")
public func cocore_enclave_enc_ecdh(
    handle: UnsafeMutableRawPointer?,
    peerPub64: UnsafePointer<UInt8>?,
    peerLen: Int,
    outShared: UnsafeMutablePointer<UInt8>?,
    outLen: Int
) -> Int32 {
    guard let handle, let peerPub64, let outShared, peerLen == 64, outLen >= 32 else { return -1 }
    let key = Unmanaged<SecureEnclaveEncKey>.fromOpaque(handle).takeUnretainedValue()
    let peer = Data(bytes: peerPub64, count: peerLen)
    do {
        let shared = try key.ecdh(peerRaw64: peer)
        shared.withUnsafeBytes { src in
            outShared.update(from: src.bindMemory(to: UInt8.self).baseAddress!, count: 32)
        }
        return 0
    } catch {
        NSLog("cocore enclave enc ecdh failed: \(error)")
        return -3
    }
}

@_cdecl("cocore_enclave_enc_release")
public func cocore_enclave_enc_release(handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    Unmanaged<SecureEnclaveEncKey>.fromOpaque(handle).release()
}

// MARK: - Identity

public final class SecureEnclaveIdentity {
    private let privateKey: SecureEnclave.P256.Signing.PrivateKey

    private init(_ key: SecureEnclave.P256.Signing.PrivateKey) {
        self.privateKey = key
    }

    /// Try to load a persisted Secure Enclave key handle from the
    /// keychain. If none exists, create one and persist it.
    public static func loadOrCreate() throws -> SecureEnclaveIdentity {
        guard SecureEnclave.isAvailable else {
            throw EnclaveError.unavailable
        }
        // 1. The stable case: load the persisted blob from the data-protection
        //    keychain. Reachable by every process of this signed app.
        if let blob = try? loadDataRepresentation() {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
            return SecureEnclaveIdentity(key)
        }
        // 2. Pick the blob to persist: migrate an existing key from the legacy
        //    file-based login keychain if one is readable (so the machine keeps
        //    its signing key + MDM attestation), else mint a fresh SE key.
        let candidate: Data
        if let legacy = try? loadLegacyDataRepresentation(),
           (try? SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: legacy)) != nil {
            candidate = legacy
        } else {
            let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                [.privateKeyUsage],
                nil
            )!
            candidate = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
                .dataRepresentation
        }
        // 3. Persist — but if a concurrent process stored first, ADOPT the winner
        //    so every process converges on exactly ONE key (never clobber).
        let stored = (try? storeIfAbsent(candidate)) ?? false
        let winner = stored ? candidate : try loadDataRepresentation()
        return SecureEnclaveIdentity(
            try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: winner))
    }

    /// Raw uncompressed P-256 public key bytes: 0x04 || X || Y, sliced
    /// to drop the 0x04 prefix → 64 bytes.
    public func publicKeyRaw64() -> Data {
        let raw = privateKey.publicKey.rawRepresentation
        // CryptoKit's rawRepresentation already excludes the 0x04
        // prefix and returns exactly X || Y (64 bytes).
        precondition(raw.count == 64, "expected 64-byte raw P-256 pubkey, got \(raw.count)")
        return raw
    }

    /// Sign with deterministic ECDSA (CryptoKit defaults to RFC6979
    /// when constructing from the SE key). Returns DER-encoded bytes.
    public func sign(_ payload: Data) throws -> Data {
        let signature = try privateKey.signature(for: payload)
        return signature.derRepresentation
    }
}

// MARK: - Encryption key (P-256 ECDH, Secure Enclave)

/// A separate SE-resident P-256 KeyAgreement key used to seal/open the APNs
/// code-challenge nonce and confidential prompts (`p256-ecies-se`). Distinct
/// keychain slot from the signing identity so key rotation is independent. The
/// private half never leaves the enclave — we only ever ask it to compute an
/// ECDH shared secret with a caller-supplied ephemeral peer key.
public final class SecureEnclaveEncKey {
    private let privateKey: SecureEnclave.P256.KeyAgreement.PrivateKey

    private init(_ key: SecureEnclave.P256.KeyAgreement.PrivateKey) {
        self.privateKey = key
    }

    public static func loadOrCreate() throws -> SecureEnclaveEncKey {
        guard SecureEnclave.isAvailable else {
            throw EnclaveError.unavailable
        }
        // Same stable-load → migrate → create-and-adopt sequence as the signing
        // key (see SecureEnclaveIdentity.loadOrCreate). A rotating encryption key
        // is less visible than the signing one (confidential re-seals per request
        // against the currently-advertised key), but the fix is identical and
        // keeps the key stable across restarts.
        if let blob = try? loadDataRepresentation(service: kEncService, tag: kEncKeychainTag),
           let key = try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob) {
            return SecureEnclaveEncKey(key)
        }
        let candidate: Data
        if let legacy = try? loadLegacyDataRepresentation(service: kEncService, tag: kEncKeychainTag),
           (try? SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: legacy)) != nil {
            candidate = legacy
        } else {
            let access = SecAccessControlCreateWithFlags(
                nil,
                kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
                [.privateKeyUsage],
                nil
            )!
            candidate = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
                .dataRepresentation
        }
        let stored = (try? storeIfAbsent(candidate, service: kEncService, tag: kEncKeychainTag)) ?? false
        let winner =
            stored ? candidate : try loadDataRepresentation(service: kEncService, tag: kEncKeychainTag)
        return SecureEnclaveEncKey(
            try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: winner))
    }

    /// 64-byte uncompressed public key (X || Y), matching the signing pubkey shape.
    public func publicKeyRaw64() -> Data {
        let raw = privateKey.publicKey.rawRepresentation
        precondition(raw.count == 64, "expected 64-byte raw P-256 pubkey, got \(raw.count)")
        return raw
    }

    /// Compute the ECDH shared secret with an ephemeral peer public key
    /// (64-byte uncompressed `X || Y`). Returns the raw 32-byte X-coordinate.
    public func ecdh(peerRaw64: Data) throws -> Data {
        let peer = try P256.KeyAgreement.PublicKey(rawRepresentation: peerRaw64)
        let shared = try privateKey.sharedSecretFromKeyAgreement(with: peer)
        return shared.withUnsafeBytes { Data($0) }
    }
}

public enum EnclaveError: Error {
    case unavailable
    case keychainStore(OSStatus)
    case keychainLoad(OSStatus)
}

// MARK: - Keychain helpers

private let kSigningService = "cocore.provider.enclave"
private let kEncService = "cocore.provider.enclave.enc"

// SE key BLOBS (the enclave-wrapped `dataRepresentation` — a reference to the
// SEP-resident private key, never the key itself) are persisted in the
// DATA-PROTECTION keychain, keyed by this signed app's keychain-access-group.
// This is load-bearing for a STABLE signing key across processes:
//
//   • The legacy file-based login keychain reads inconsistently across the app's
//     process contexts — a tray-launched `serve`, a one-shot CLI, or a
//     login-item start before GUI unlock can get errSecInteractionNotAllowed on
//     SecItemCopyMatching even though the item exists. Each such miss drove the
//     `loadOrCreate` CREATE branch, which (with the old destructive save) DELETED
//     the shared key and stored a fresh one — rotating the signing key out from
//     under the MDM attestation chain, so Secure Mode could never bind. The
//     data-protection keychain is reachable by every process of the same signed
//     app regardless of login session, so the read no longer flakes.
//   • Writes are ADD-OR-ADOPT, never delete-then-add: a transient reader can
//     never destroy the shared key. First writer wins; everyone else adopts it.
//
// Requires the `keychain-access-groups` entitlement (present on the release
// build). Ad-hoc `swift build` dev binaries lack it, so these calls fail there
// and the caller falls back to a software identity — which is the intended,
// harmless behavior for a dev build (it self-caps at best-effort).

private func dataProtectionQuery(service: String, tag: Data) -> [String: Any] {
    [
        kSecClass as String: kSecClassGenericPassword,
        kSecUseDataProtectionKeychain as String: true,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "default",
        kSecAttrGeneric as String: tag,
    ]
}

/// Store `data` only if no item exists yet. On a pre-existing item (another
/// process won the create race, or we're re-homing a migrated blob) LEAVE it and
/// return `false` so the caller ADOPTS the existing key instead of clobbering it.
/// Never deletes — a destructive save is exactly what rotated the key before.
@discardableResult
private func storeIfAbsent(
    _ data: Data,
    service: String = kSigningService,
    tag: Data = kKeychainTag
) throws -> Bool {
    var attrs = dataProtectionQuery(service: service, tag: tag)
    attrs[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    attrs[kSecValueData as String] = data
    let status = SecItemAdd(attrs as CFDictionary, nil)
    switch status {
    case errSecSuccess: return true
    case errSecDuplicateItem: return false
    default: throw EnclaveError.keychainStore(status)
    }
}

private func loadDataRepresentation(
    service: String = kSigningService,
    tag: Data = kKeychainTag
) throws -> Data {
    var q = dataProtectionQuery(service: service, tag: tag)
    q[kSecReturnData as String] = true
    q[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        throw EnclaveError.keychainLoad(status)
    }
    return data
}

/// Best-effort read from the LEGACY file-based login keychain (pre-data-
/// protection builds). Used once, to migrate an existing key into the
/// data-protection keychain so an upgrading machine keeps its signing key — and
/// its MDM attestation — instead of rotating once more. Absent
/// `kSecUseDataProtectionKeychain`, this searches only the file-based keychains.
private func loadLegacyDataRepresentation(
    service: String = kSigningService,
    tag: Data = kKeychainTag
) throws -> Data {
    let q: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "default",
        kSecAttrGeneric as String: tag,
        kSecReturnData as String: true,
        kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(q as CFDictionary, &result)
    guard status == errSecSuccess, let data = result as? Data else {
        throw EnclaveError.keychainLoad(status)
    }
    return data
}
