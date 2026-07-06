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
        if let blob = try? loadDataRepresentation() {
            let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob)
            return SecureEnclaveIdentity(key)
        }
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            nil
        )!
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try saveDataRepresentation(key.dataRepresentation)
        return SecureEnclaveIdentity(key)
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
        if let blob = try? loadDataRepresentation(service: kEncService, tag: kEncKeychainTag) {
            let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(dataRepresentation: blob)
            return SecureEnclaveEncKey(key)
        }
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            [.privateKeyUsage],
            nil
        )!
        let key = try SecureEnclave.P256.KeyAgreement.PrivateKey(accessControl: access)
        try saveDataRepresentation(key.dataRepresentation, service: kEncService, tag: kEncKeychainTag)
        return SecureEnclaveEncKey(key)
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

private func saveDataRepresentation(
    _ data: Data,
    service: String = kSigningService,
    tag: Data = kKeychainTag
) throws {
    let attrs: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: "default",
        kSecAttrGeneric as String: tag,
        kSecValueData as String: data,
    ]
    SecItemDelete(attrs as CFDictionary) // ignore error
    let status = SecItemAdd(attrs as CFDictionary, nil)
    if status != errSecSuccess {
        throw EnclaveError.keychainStore(status)
    }
}

private func loadDataRepresentation(
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
