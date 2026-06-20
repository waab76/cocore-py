//! Apple Managed Device Attestation cert-chain verification.
//!
//! The production trust anchor is Apple's Enterprise Attestation Root
//! CA; tests pass a synthetic root so we don't need a real
//! Apple-attested device to exercise the path. The OID set we extract
//! from the leaf is dictated by Apple's MDA spec — see
//! <https://developer.apple.com/documentation/devicemanagement/managed_device_attestation>.
//!
//! What we verify:
//!   1. Every cert in the supplied chain was signed by the next one
//!      up (or by the supplied root for the top-of-chain).
//!   2. The leaf's NotBefore / NotAfter window covers `now`.
//!   3. The Apple-defined OIDs in the leaf parse cleanly.
//!
//! What we do NOT verify (yet, by design):
//!   - Revocation (CRL/OCSP) — Apple's MDA leaf certs have short
//!     lifetimes (~30 days) so the operational risk is bounded.
//!   - X.509 path constraints beyond signature + validity — `webpki`
//!     handles those for TLS; an enterprise-attestation cert is
//!     not a TLS cert and the constraint set is different.

use asn1_rs::{Boolean, FromDer, Utf8String};
use x509_parser::extensions::ParsedExtension;
use x509_parser::prelude::X509Certificate;

/// Apple Enterprise Attestation Root CA, P-384, valid 2022 → 2047.
/// Source: <https://www.apple.com/certificateauthority/>.
pub const APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM: &str = concat!(
    "-----BEGIN CERTIFICATE-----\n",
    "MIICJDCCAamgAwIBAgIUQsDCuyxyfFxeq/bxpm8frF15hzcwCgYIKoZIzj0EAwMw\n",
    "UTEtMCsGA1UEAwwkQXBwbGUgRW50ZXJwcmlzZSBBdHRlc3RhdGlvbiBSb290IENB\n",
    "MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzAeFw0yMjAyMTYxOTAx\n",
    "MjRaFw00NzAyMjAwMDAwMDBaMFExLTArBgNVBAMMJEFwcGxlIEVudGVycHJpc2Ug\n",
    "QXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UE\n",
    "BhMCVVMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT6Jigq+Ps9Q4CoT8t8q+UnOe2p\n",
    "oT9nRaUfGhBTbgvqSGXPjVkbYlIWYO+1zPk2Sz9hQ5ozzmLrPmTBgEWRcHjA2/y7\n",
    "7GEicps9wn2tj+G89l3INNDKETdxSPPIZpPj8VmjQjBAMA8GA1UdEwEB/wQFMAMB\n",
    "Af8wHQYDVR0OBBYEFPNqTQGd8muBpV5du+UIbVbi+d66MA4GA1UdDwEB/wQEAwIB\n",
    "BjAKBggqhkjOPQQDAwNpADBmAjEA1xpWmTLSpr1VH4f8Ypk8f3jMUKYz4QPG8mL5\n",
    "8m9sX/b2+eXpTv2pH4RZgJjucnbcAjEA4ZSB6S45FlPuS/u4pTnzoz632rA+xW/T\n",
    "ZwFEh9bhKjJ+5VQ9/Do1os0u3LEkgN/r\n",
    "-----END CERTIFICATE-----\n"
);

// Apple MDA OIDs — DevicePropertiesAttestation (DeviceInformation)
// + ACME device-attest-01 path. Encoded as their pre-computed DER
// suffixes so we can compare in a single byte-equality check; the
// `oid!` macro from x509-parser produces the same bytes at compile
// time but expanding it here keeps the dependency surface small.
//
// Format: each component variable-length-encoded (top bit set = more
// bytes follow); the first two components are merged as 40·a + b.
const OID_DEVICE_SERIAL_NUMBER: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 9, 1];
const OID_DEVICE_UDID: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 9, 2];
const OID_OS_VERSION: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 10, 1];
const OID_SEP_OS_VERSION: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 10, 2];
const OID_LLB_VERSION: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 10, 3];
const OID_FRESHNESS_CODE: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 11, 1];
const OID_SIP_STATUS: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 13, 1];
const OID_SECURE_BOOT_STATUS: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 13, 2];
const OID_KEXT_STATUS: &[u8] = &[42, 134, 72, 134, 247, 99, 100, 8, 13, 3];

/// Result of verifying an MDA cert chain. Field set tracks Apple's
/// MDA leaf-cert OIDs (device serial, UDID, OS / SEP / LLB versions,
/// freshness, SIP, secure boot, third-party kexts).
#[derive(Debug, Default, Clone)]
pub struct MdaResult {
    pub valid: bool,
    pub error: Option<String>,
    /// The leaf cert's P-256 public key as the raw 64-byte X‖Y point —
    /// the SAME encoding the signer publishes as `attestation.publicKey`.
    /// Callers BIND the chain to the signer by requiring this equal the
    /// signing key; otherwise a valid Apple chain for one device can be
    /// stapled onto an unrelated signing key.
    pub leaf_public_key: Option<Vec<u8>>,
    pub device_serial: Option<String>,
    pub device_udid: Option<String>,
    pub os_version: Option<String>,
    pub sep_os_version: Option<String>,
    pub llb_version: Option<String>,
    pub freshness_code: Option<Vec<u8>>,
    pub sip_enabled: Option<bool>,
    pub secure_boot_enabled: Option<bool>,
    pub third_party_kexts: Option<bool>,
}

impl MdaResult {
    /// Option-B binding: the Apple freshness OID (1.2.840.113635.100.8.11.1)
    /// commits to the signing key iff `freshness_code == sha256(pubkey_raw)`.
    /// `pubkey_raw` is the raw 64-byte P-256 X‖Y point (the decoded
    /// `attestation.publicKey`). Tolerates the DER OCTET STRING wrapper
    /// (`04 20 ‖ 32`) so it matches the TS/Python verifiers byte-for-byte.
    pub fn freshness_binds(&self, pubkey_raw: &[u8]) -> bool {
        use sha2::{Digest, Sha256};
        let Some(fc) = self.freshness_code.as_deref() else {
            return false;
        };
        if pubkey_raw.is_empty() {
            return false;
        }
        let inner: &[u8] = if fc.len() == 34 && fc[0] == 0x04 && fc[1] == 0x20 {
            &fc[2..]
        } else {
            fc
        };
        let digest = Sha256::digest(pubkey_raw);
        inner.len() == digest.len()
            && inner
                .iter()
                .zip(digest.iter())
                .fold(0u8, |acc, (a, b)| acc | (a ^ b))
                == 0
    }

    /// True iff the chain is bound to `pubkey_raw` by EITHER the leaf key being
    /// the signing key (option A) OR the freshness-code commitment (option B).
    pub fn binds_key(&self, pubkey_raw: &[u8]) -> bool {
        self.leaf_public_key.as_deref() == Some(pubkey_raw) || self.freshness_binds(pubkey_raw)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MdaError {
    #[error("empty certificate chain")]
    EmptyChain,
    #[error("parse cert {index}: {message}")]
    Parse { index: usize, message: String },
    #[error("parse trust anchor: {0}")]
    BadTrustAnchor(String),
    #[error("signature verification failed for cert {index}: {message}")]
    BadSignature { index: usize, message: String },
    #[error("cert {index} is not valid at {at}")]
    NotValid { index: usize, at: String },
    #[error("CA constraint violation for cert {index}: {message}")]
    CaConstraint { index: usize, message: String },
}

/// Verify a DER-encoded MDA chain against the embedded Apple Root CA.
pub fn verify_chain(chain_der: &[Vec<u8>]) -> Result<MdaResult, MdaError> {
    let root_der =
        pem_to_der(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM).map_err(MdaError::BadTrustAnchor)?;
    verify_chain_against(chain_der, &root_der, &chrono::Utc::now())
}

/// Verify a DER-encoded MDA chain against a caller-supplied trust
/// anchor. The test path uses this with a synthetic root.
pub fn verify_chain_against(
    chain_der: &[Vec<u8>],
    root_ca_der: &[u8],
    now: &chrono::DateTime<chrono::Utc>,
) -> Result<MdaResult, MdaError> {
    if chain_der.is_empty() {
        return Err(MdaError::EmptyChain);
    }

    // Parse all certs into x509_parser representations. We hold the
    // parsed Vec<u8>s by reference, so the X509Certificates borrow
    // from chain_der + root_ca_der and live as long as those.
    let mut parsed: Vec<X509Certificate> = Vec::with_capacity(chain_der.len());
    for (i, der) in chain_der.iter().enumerate() {
        let (_, cert) = X509Certificate::from_der(der).map_err(|e| MdaError::Parse {
            index: i,
            message: format!("{e}"),
        })?;
        parsed.push(cert);
    }

    let (_, root) = X509Certificate::from_der(root_ca_der)
        .map_err(|e| MdaError::BadTrustAnchor(format!("{e}")))?;

    // Validity window for every cert in the chain (and the root).
    // Root validity is always checked; if the operator's clock skews
    // outside the 25-year Apple Root window something has gone very
    // wrong on their host.
    let now_unix = now.timestamp();
    let valid_at = |cert: &X509Certificate, idx: usize| -> Result<(), MdaError> {
        let nb = cert.validity().not_before.timestamp();
        let na = cert.validity().not_after.timestamp();
        if now_unix < nb || now_unix > na {
            return Err(MdaError::NotValid {
                index: idx,
                at: now.to_rfc3339(),
            });
        }
        Ok(())
    };
    for (i, cert) in parsed.iter().enumerate() {
        valid_at(cert, i)?;
    }
    valid_at(&root, usize::MAX)?;

    // Walk the chain: certs[i] must be signed by certs[i+1].
    for i in 0..(parsed.len().saturating_sub(1)) {
        parsed[i]
            .verify_signature(Some(parsed[i + 1].public_key()))
            .map_err(|e| MdaError::BadSignature {
                index: i,
                message: format!("{e:?}"),
            })?;
    }
    // Top of chain must be signed by the trust anchor.
    let top = &parsed[parsed.len() - 1];
    top.verify_signature(Some(root.public_key()))
        .map_err(|e| MdaError::BadSignature {
            index: parsed.len() - 1,
            message: format!("{e:?}"),
        })?;

    // CA constraints. Every non-leaf cert in the chain must be a CA
    // (BasicConstraints cA=true) and the leaf (index 0) must be an
    // end-entity. Without this a single Apple-signed leaf can be
    // presented as a forging intermediate ("leaf-as-issuer"): mint a
    // sub-cert under it and walk a 2-cert chain cleanly to the Apple
    // root. The trust anchor itself is supplied out-of-band and trusted,
    // so it isn't in `parsed` and isn't checked here.
    for (i, cert) in parsed.iter().enumerate() {
        let is_ca = cert.extensions().iter().any(
            |ext| matches!(ext.parsed_extension(), ParsedExtension::BasicConstraints(bc) if bc.ca),
        );
        if i == 0 && is_ca {
            return Err(MdaError::CaConstraint {
                index: 0,
                message: "leaf must be an end-entity, not a CA".into(),
            });
        }
        if i > 0 && !is_ca {
            return Err(MdaError::CaConstraint {
                index: i,
                message: format!("chain cert {i} is not a CA but signs cert {}", i - 1),
            });
        }
    }

    // Extract OIDs from the leaf.
    let leaf = &parsed[0];
    let mut result = MdaResult {
        valid: true,
        ..MdaResult::default()
    };

    // Leaf P-256 public key as raw X‖Y (64 bytes) for the caller's
    // binding check against the signer's `publicKey`. SPKI carries the
    // uncompressed EC point 0x04‖X‖Y (65 bytes); strip the prefix to
    // match the 64-byte encoding the signer publishes.
    {
        let raw = leaf.public_key().subject_public_key.data.as_ref();
        if raw.len() == 65 && raw[0] == 0x04 {
            result.leaf_public_key = Some(raw[1..].to_vec());
        }
    }

    // Subject's serialNumber RDN as the fallback for device serial.
    // x509-parser exposes RDNs through `iter_attributes`; we look for
    // the OID 2.5.4.5 (id-at-serialNumber).
    const OID_SUBJECT_SERIAL: &[u8] = &[85, 4, 5];
    for attr in leaf.subject().iter_attributes() {
        if attr.attr_type().as_bytes() == OID_SUBJECT_SERIAL {
            if let Ok(s) = std::str::from_utf8(attr.attr_value().data) {
                result.device_serial = Some(s.trim().to_string());
            }
        }
    }

    for ext in leaf.extensions() {
        let oid_bytes = ext.oid.as_bytes();
        let v = ext.value;
        match oid_bytes {
            b if b == OID_DEVICE_SERIAL_NUMBER => {
                if let Some(s) = parse_string(v) {
                    result.device_serial = Some(s);
                }
            }
            b if b == OID_DEVICE_UDID => {
                if let Some(s) = parse_string(v) {
                    result.device_udid = Some(s);
                }
            }
            b if b == OID_OS_VERSION => {
                if let Some(s) = parse_string(v) {
                    result.os_version = Some(s);
                }
            }
            b if b == OID_SEP_OS_VERSION => {
                if let Some(s) = parse_string(v) {
                    result.sep_os_version = Some(s);
                }
            }
            b if b == OID_LLB_VERSION => {
                if let Some(s) = parse_string(v) {
                    result.llb_version = Some(s);
                }
            }
            b if b == OID_FRESHNESS_CODE => {
                result.freshness_code = Some(v.to_vec());
            }
            b if b == OID_SIP_STATUS => {
                result.sip_enabled = parse_bool(v);
            }
            b if b == OID_SECURE_BOOT_STATUS => {
                result.secure_boot_enabled = parse_bool(v);
            }
            b if b == OID_KEXT_STATUS => {
                result.third_party_kexts = parse_bool(v);
            }
            _ => {}
        }
    }

    Ok(result)
}

fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    let mut acc = String::new();
    let mut in_block = false;
    for line in pem.lines() {
        if line.starts_with("-----BEGIN") {
            in_block = true;
            continue;
        }
        if line.starts_with("-----END") {
            break;
        }
        if in_block {
            acc.push_str(line.trim());
        }
    }
    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    B64.decode(acc).map_err(|e| format!("base64: {e}"))
}

fn parse_string(value: &[u8]) -> Option<String> {
    // The value is the OCTET STRING contents of an X.509 extension.
    // For Apple OIDs the inner value is a UTF8String; some leaf
    // certs encode it as plain bytes, so fall back accordingly.
    if let Ok((_, s)) = Utf8String::from_der(value) {
        return Some(s.string().to_string());
    }
    String::from_utf8(value.to_vec()).ok()
}

fn parse_bool(value: &[u8]) -> Option<bool> {
    // Fail CLOSED. These extensions carry security posture (SIP /
    // Secure Boot / third-party kexts) and the leaf is
    // attacker-controlled, so a value that doesn't strictly parse as an
    // ASN.1 BOOLEAN must yield `None` ("unknown" → treated as NOT
    // enabled), never `true`. The previous "any non-zero trailing byte
    // == true" fallback let a hand-crafted, non-conforming extension
    // assert SIP/Secure-Boot enabled to a strict verifier that would
    // otherwise have rejected it.
    Boolean::from_der(value).ok().map(|(_, b)| b.bool())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, CustomExtension, DistinguishedName, DnType, IsCa,
        KeyPair, PKCS_ECDSA_P256_SHA256,
    };

    #[test]
    fn freshness_binds_option_b() {
        use sha2::{Digest, Sha256};
        let pubkey = vec![7u8; 64]; // raw 64-byte P-256 X‖Y
        let good = Sha256::digest(&pubkey).to_vec();

        // Raw 32-byte freshness == sha256(pubkey) → binds.
        let r = MdaResult {
            freshness_code: Some(good.clone()),
            ..Default::default()
        };
        assert!(r.freshness_binds(&pubkey));
        assert!(r.binds_key(&pubkey));

        // Same value still inside its DER OCTET STRING wrapper (04 20 ‖ 32) → binds.
        let mut wrapped = vec![0x04u8, 0x20];
        wrapped.extend_from_slice(&good);
        let r = MdaResult {
            freshness_code: Some(wrapped),
            ..Default::default()
        };
        assert!(r.freshness_binds(&pubkey));

        // Freshness for a DIFFERENT key → does NOT bind.
        let other = Sha256::digest([9u8; 64]).to_vec();
        let r = MdaResult {
            freshness_code: Some(other),
            ..Default::default()
        };
        assert!(!r.freshness_binds(&pubkey));
        assert!(!r.binds_key(&pubkey));

        // No freshness + no leaf key → no binding material.
        let r = MdaResult::default();
        assert!(!r.binds_key(&pubkey));

        // Option A still works: leaf key == signing key.
        let r = MdaResult {
            leaf_public_key: Some(pubkey.clone()),
            ..Default::default()
        };
        assert!(r.binds_key(&pubkey));
    }

    #[test]
    fn parse_bool_fails_closed_on_malformed_input() {
        // A well-formed DER BOOLEAN parses to its value.
        assert_eq!(parse_bool(&[0x01, 0x01, 0xFF]), Some(true)); // TRUE
        assert_eq!(parse_bool(&[0x01, 0x01, 0x00]), Some(false)); // FALSE
                                                                  // Anything that isn't a strict ASN.1 BOOLEAN is UNKNOWN, never
                                                                  // `true` — a hand-crafted extension must not be able to assert
                                                                  // SIP/Secure-Boot enabled to a strict verifier.
        assert_eq!(parse_bool(&[0xFF]), None); // bare non-zero byte (old fail-open path)
        assert_eq!(parse_bool(&[]), None); // empty
        assert_eq!(parse_bool(&[0x04, 0x01, 0xFF]), None); // OCTET STRING, not BOOLEAN
    }

    /// Generate a (root, leaf_chain_der) pair that emulates an MDA
    /// leaf signed by a self-managed root, with the Apple OIDs
    /// embedded as extensions. Used in place of a real Apple chain
    /// for unit tests.
    fn test_chain(sip_enabled: bool, secure_boot_enabled: bool) -> (Vec<u8>, Vec<Vec<u8>>) {
        // Pin both certs to a concrete two-year validity window so
        // tests that probe "outside the window" can land somewhere
        // unambiguously after expiry without depending on rcgen
        // defaults.
        let now = time::OffsetDateTime::now_utc();
        let nb = now - time::Duration::HOUR;
        let na = now + time::Duration::days(365 * 2);

        let mut root_params = CertificateParams::new(vec!["Test MDA Root".into()]).unwrap();
        let mut root_dn = DistinguishedName::new();
        root_dn.push(DnType::CommonName, "Test MDA Root");
        root_params.distinguished_name = root_dn;
        root_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        root_params.not_before = nb;
        root_params.not_after = na;
        let root_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let root_cert = root_params.self_signed(&root_key).unwrap();

        let mut leaf_params = CertificateParams::new(vec!["mda-test-device".into()]).unwrap();
        let mut leaf_dn = DistinguishedName::new();
        leaf_dn.push(DnType::CommonName, "mda-test-device");
        // X.500 serialNumber RDN: OID 2.5.4.5. rcgen 0.13's DnType
        // doesn't expose it as a variant, so we use the catch-all
        // CustomDnType built from the raw component path.
        leaf_dn.push(DnType::CustomDnType(vec![2, 5, 4, 5]), "C02XL3FHJG5J");
        leaf_params.distinguished_name = leaf_dn;
        leaf_params.is_ca = IsCa::NoCa;
        leaf_params.not_before = nb;
        leaf_params.not_after = na;

        // Encode a few OIDs the verifier looks for. rcgen wants the
        // dotted-int form; the byte form lives in the verifier above.
        const SIP: &[u64] = &[1, 2, 840, 113635, 100, 8, 13, 1];
        const SB: &[u64] = &[1, 2, 840, 113635, 100, 8, 13, 2];
        const UDID: &[u64] = &[1, 2, 840, 113635, 100, 8, 9, 2];

        let mut sip = CustomExtension::from_oid_content(SIP, der_bool(sip_enabled));
        sip.set_criticality(false);
        leaf_params.custom_extensions.push(sip);
        let mut sb = CustomExtension::from_oid_content(SB, der_bool(secure_boot_enabled));
        sb.set_criticality(false);
        leaf_params.custom_extensions.push(sb);
        let mut udid = CustomExtension::from_oid_content(UDID, der_utf8("UDID-12345678"));
        udid.set_criticality(false);
        leaf_params.custom_extensions.push(udid);

        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &root_cert, &root_key)
            .unwrap();

        (root_cert.der().to_vec(), vec![leaf_cert.der().to_vec()])
    }

    fn der_bool(v: bool) -> Vec<u8> {
        // ASN.1 BOOLEAN: tag 0x01, length 0x01, value 0x00 or 0xff.
        vec![0x01, 0x01, if v { 0xff } else { 0x00 }]
    }
    fn der_utf8(s: &str) -> Vec<u8> {
        let bytes = s.as_bytes();
        let mut out = Vec::with_capacity(bytes.len() + 2);
        out.push(0x0c); // UTF8String
        out.push(bytes.len() as u8);
        out.extend_from_slice(bytes);
        out
    }

    fn now_inside_validity() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    #[test]
    fn embedded_apple_root_parses() {
        let der = pem_to_der(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM).unwrap();
        let (_, cert) = X509Certificate::from_der(&der).unwrap();
        let cn: Vec<&str> = cert
            .subject()
            .iter_common_name()
            .filter_map(|cn| cn.attr_value().as_str().ok())
            .collect();
        assert!(cn
            .iter()
            .any(|s| s.contains("Apple Enterprise Attestation")));
    }

    #[test]
    fn happy_chain_verifies_against_supplied_root() {
        let (root, chain) = test_chain(true, true);
        let now = now_inside_validity();
        let result = verify_chain_against(&chain, &root, &now).unwrap();
        assert!(result.valid);
        assert!(result.error.is_none());
        assert_eq!(result.device_serial.as_deref(), Some("C02XL3FHJG5J"));
        assert_eq!(result.device_udid.as_deref(), Some("UDID-12345678"));
        assert_eq!(result.sip_enabled, Some(true));
        assert_eq!(result.secure_boot_enabled, Some(true));
    }

    #[test]
    fn leaf_marked_as_ca_is_rejected() {
        // A leaf that is itself a CA could be wielded as a forging issuer
        // (leaf-as-issuer): mint a sub-cert under it and walk to the root.
        // Every signature + the anchor check still pass, so the CA-flag
        // check is the only thing that stops it.
        let now = time::OffsetDateTime::now_utc();
        let nb = now - time::Duration::HOUR;
        let na = now + time::Duration::days(365 * 2);

        let mut root_params = CertificateParams::new(vec!["Test MDA Root".into()]).unwrap();
        root_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(1));
        root_params.not_before = nb;
        root_params.not_after = na;
        let root_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let root_cert = root_params.self_signed(&root_key).unwrap();

        let mut leaf_params = CertificateParams::new(vec!["mda-test-device".into()]).unwrap();
        // The forging bit: the leaf is marked as a CA.
        leaf_params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        leaf_params.not_before = nb;
        leaf_params.not_after = na;
        let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let leaf_cert = leaf_params
            .signed_by(&leaf_key, &root_cert, &root_key)
            .unwrap();

        let chain = vec![leaf_cert.der().to_vec()];
        let now_c = now_inside_validity();
        let err = verify_chain_against(&chain, root_cert.der(), &now_c).unwrap_err();
        assert!(
            matches!(err, MdaError::CaConstraint { index: 0, .. }),
            "expected CaConstraint on the leaf, got {err:?}"
        );
    }

    #[test]
    fn boolean_fields_round_trip_false() {
        let (root, chain) = test_chain(false, false);
        let now = now_inside_validity();
        let result = verify_chain_against(&chain, &root, &now).unwrap();
        assert_eq!(result.sip_enabled, Some(false));
        assert_eq!(result.secure_boot_enabled, Some(false));
    }

    #[test]
    fn empty_chain_rejected() {
        let chain: Vec<Vec<u8>> = vec![];
        let now = now_inside_validity();
        let root = pem_to_der(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM).unwrap();
        let err = verify_chain_against(&chain, &root, &now).unwrap_err();
        assert!(matches!(err, MdaError::EmptyChain));
    }

    #[test]
    fn wrong_root_rejects_chain() {
        let (_root_a, chain) = test_chain(true, true);
        // Verify against Apple's actual root — it didn't sign our
        // synthetic chain, so this MUST fail.
        let apple_root = pem_to_der(APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM).unwrap();
        let now = now_inside_validity();
        let err = verify_chain_against(&chain, &apple_root, &now).unwrap_err();
        assert!(matches!(err, MdaError::BadSignature { .. }));
    }

    #[test]
    fn cert_outside_validity_window_rejected() {
        let (root, chain) = test_chain(true, true);
        // 100 years in the future — outside any reasonable cert
        // lifetime.
        let future = chrono::Utc::now() + chrono::Duration::days(365 * 100);
        let err = verify_chain_against(&chain, &root, &future).unwrap_err();
        assert!(matches!(err, MdaError::NotValid { .. }));
    }
}
