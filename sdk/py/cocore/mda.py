"""Apple Managed Device Attestation cert-chain verification.

Mirror of packages/sdk/src/mda.ts / provider/src/mda.rs. Verifies a DER chain
(leaf first) to the Apple Enterprise Attestation Root, enforces BasicConstraints
(non-leaf certs are CAs, the leaf is an end-entity), and returns the leaf's
P-256 key (so a caller can BIND the chain to the attestation's publicKey) plus
the SIP / Secure Boot posture OIDs.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric import ec

# Apple Enterprise Attestation Root CA, P-384, valid 2022 -> 2047. Identical
# bytes to the Rust embed in provider/src/mda.rs and the TS embed in mda.ts.
APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM = (
    "-----BEGIN CERTIFICATE-----\n"
    "MIICJDCCAamgAwIBAgIUQsDCuyxyfFxeq/bxpm8frF15hzcwCgYIKoZIzj0EAwMw\n"
    "UTEtMCsGA1UEAwwkQXBwbGUgRW50ZXJwcmlzZSBBdHRlc3RhdGlvbiBSb290IENB\n"
    "MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzAeFw0yMjAyMTYxOTAx\n"
    "MjRaFw00NzAyMjAwMDAwMDBaMFExLTArBgNVBAMMJEFwcGxlIEVudGVycHJpc2Ug\n"
    "QXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UE\n"
    "BhMCVVMwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT6Jigq+Ps9Q4CoT8t8q+UnOe2p\n"
    "oT9nRaUfGhBTbgvqSGXPjVkbYlIWYO+1zPk2Sz9hQ5ozzmLrPmTBgEWRcHjA2/y7\n"
    "7GEicps9wn2tj+G89l3INNDKETdxSPPIZpPj8VmjQjBAMA8GA1UdEwEB/wQFMAMB\n"
    "Af8wHQYDVR0OBBYEFPNqTQGd8muBpV5du+UIbVbi+d66MA4GA1UdDwEB/wQEAwIB\n"
    "BjAKBggqhkjOPQQDAwNpADBmAjEA1xpWmTLSpr1VH4f8Ypk8f3jMUKYz4QPG8mL5\n"
    "8m9sX/b2+eXpTv2pH4RZgJjucnbcAjEA4ZSB6S45FlPuS/u4pTnzoz632rA+xW/T\n"
    "ZwFEh9bhKjJ+5VQ9/Do1os0u3LEkgN/r\n"
    "-----END CERTIFICATE-----\n"
)

OID_SIP_STATUS = "1.2.840.113635.100.8.13.1"
OID_SECURE_BOOT_STATUS = "1.2.840.113635.100.8.13.2"
OID_DEVICE_SERIAL_NUMBER = "1.2.840.113635.100.8.9.1"
OID_FRESHNESS_CODE = "1.2.840.113635.100.8.11.1"


class MdaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass
class MdaResult:
    valid: bool
    leaf_public_key: Optional[str] = None
    device_serial: Optional[str] = None
    sip_enabled: Optional[bool] = None
    secure_boot_enabled: Optional[bool] = None
    #: Raw Apple freshness OID (1.2.840.113635.100.8.11.1) value — a 32-byte
    #: SHA-256, possibly still in its DER OCTET STRING wrapper. The verifier's
    #: freshness-code binding normalizes it.
    freshness_code: Optional[bytes] = None
    error: Optional[str] = None


def verify_chain(chain_der: list[bytes]) -> MdaResult:
    root = x509.load_pem_x509_certificate(
        APPLE_ENTERPRISE_ATTESTATION_ROOT_CA_PEM.encode("ascii")
    )
    return _verify(chain_der, root, datetime.now(timezone.utc))


def verify_chain_against(chain_der: list[bytes], root_ca_der: bytes, now: datetime) -> MdaResult:
    root = x509.load_der_x509_certificate(root_ca_der)
    return _verify(chain_der, root, now)


def _verify(chain_der: list[bytes], root: x509.Certificate, now: datetime) -> MdaResult:
    if not chain_der:
        raise MdaError("empty-chain", "empty certificate chain")
    certs = [x509.load_der_x509_certificate(d) for d in chain_der]

    def in_window(c: x509.Certificate) -> bool:
        nb = c.not_valid_before_utc
        na = c.not_valid_after_utc
        return nb <= now <= na

    for i, c in enumerate(certs):
        if not in_window(c):
            raise MdaError("not-valid", f"cert {i} not valid at {now.isoformat()}")
    if not in_window(root):
        raise MdaError("not-valid", "trust anchor not valid")

    # Each cert signed by the next; top signed by the trust anchor.
    for i in range(len(certs) - 1):
        _verify_sig(certs[i], certs[i + 1], i)
    _verify_sig(certs[-1], root, len(certs) - 1)

    # CA constraints: leaf must be end-entity, every issuer a CA.
    for i, c in enumerate(certs):
        is_ca = _is_ca(c)
        if i == 0 and is_ca:
            raise MdaError("leaf-is-ca", "leaf certificate must be an end-entity, not a CA")
        if i > 0 and not is_ca:
            raise MdaError("non-ca-issuer", f"chain cert {i} is not a CA but signs cert {i - 1}")

    leaf = certs[0]
    result = MdaResult(valid=True)

    pub = leaf.public_key()
    if isinstance(pub, ec.EllipticCurvePublicKey) and isinstance(pub.curve, ec.SECP256R1):
        nums = pub.public_numbers()
        x = nums.x.to_bytes(32, "big")
        y = nums.y.to_bytes(32, "big")
        result.leaf_public_key = base64.b64encode(x + y).decode("ascii")

    result.sip_enabled = _read_bool_oid(leaf, OID_SIP_STATUS)
    result.secure_boot_enabled = _read_bool_oid(leaf, OID_SECURE_BOOT_STATUS)
    result.device_serial = _read_str_oid(leaf, OID_DEVICE_SERIAL_NUMBER)
    result.freshness_code = _ext_value(leaf, OID_FRESHNESS_CODE)
    return result


def _verify_sig(cert: x509.Certificate, issuer: x509.Certificate, idx: int) -> None:
    issuer_pub = issuer.public_key()
    try:
        if isinstance(issuer_pub, ec.EllipticCurvePublicKey):
            issuer_pub.verify(
                cert.signature, cert.tbs_certificate_bytes, ec.ECDSA(cert.signature_hash_algorithm)
            )
        else:
            raise MdaError("bad-signature", f"unsupported issuer key for cert {idx}")
    except InvalidSignature as exc:
        raise MdaError("bad-signature", f"signature on cert {idx} doesn't verify") from exc


def _is_ca(cert: x509.Certificate) -> bool:
    try:
        bc = cert.extensions.get_extension_for_class(x509.BasicConstraints).value
        return bool(bc.ca)
    except x509.ExtensionNotFound:
        return False


def _ext_value(cert: x509.Certificate, oid: str) -> Optional[bytes]:
    try:
        ext = cert.extensions.get_extension_for_oid(x509.ObjectIdentifier(oid))
    except x509.ExtensionNotFound:
        return None
    val = ext.value
    # Apple posture extensions are UnrecognizedExtension → raw DER bytes.
    return getattr(val, "value", None)


def _read_bool_oid(cert: x509.Certificate, oid: str) -> Optional[bool]:
    """Fail-closed ASN.1 BOOLEAN read: only a strict 0x01 0x01 0x00|0xff is
    accepted; anything else is unknown (→ not enabled), never True."""
    value = _ext_value(cert, oid)
    if value is not None and len(value) == 3 and value[0] == 0x01 and value[1] == 0x01:
        return value[2] != 0x00
    return None


def _read_str_oid(cert: x509.Certificate, oid: str) -> Optional[str]:
    value = _ext_value(cert, oid)
    if not value:
        return None
    if len(value) >= 2 and value[0] == 0x0C:  # UTF8String
        n = value[1]
        if 2 + n <= len(value):
            return value[2 : 2 + n].decode("utf-8", "replace")
    try:
        return value.decode("utf-8")
    except UnicodeDecodeError:
        return None
