from __future__ import annotations

from cocore.canonical import canonical_bytes
from cocore.p256 import verify_attestation_signature, verify_p256
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey

from cocore_provider.attestation import build_attestation_record, build_challenge_response
from cocore_provider.identity import Identity
from cocore_provider.protocol import AttestationChallenge


def _identity() -> Identity:
    return Identity(
        signing_key=ec.generate_private_key(ec.SECP256R1()),
        encryption_key=PrivateKey.generate(),
    )


def test_attestation_record_required_fields_present_and_signed() -> None:
    identity = _identity()
    record = build_attestation_record(identity, provider_did="did:plc:abc")

    for field in (
        "publicKey",
        "encryptionPubKey",
        "chipName",
        "hardwareModel",
        "serialNumberHash",
        "osVersion",
        "binaryHash",
        "sipEnabled",
        "secureBootEnabled",
        "secureEnclaveAvailable",
        "authenticatedRootEnabled",
        "selfSignature",
        "attestedAt",
        "expiresAt",
    ):
        assert field in record, f"missing required field {field}"

    assert record["publicKey"] == identity.signing_public_b64
    assert record["encryptionPubKey"] == identity.encryption_public_b64
    assert record["secureEnclaveAvailable"] is False
    assert verify_attestation_signature(record, identity.signing_public_b64)


def test_challenge_response_signature_covers_echoed_timestamp() -> None:
    identity = _identity()
    challenge = AttestationChallenge(nonce="n1", timestamp="2026-01-01T00:00:00Z")
    response = build_challenge_response(identity, challenge)

    assert response["nonce"] == "n1"
    assert response["sip_enabled"] is False
    message = canonical_bytes(
        {"nonce": "n1", "sipEnabled": False, "timestamp": "2026-01-01T00:00:00Z"}
    )
    assert verify_p256(identity.signing_public_b64, response["signature"], message)
