from __future__ import annotations

import base64

from cryptography.hazmat.primitives.asymmetric import ec

from cocore.canonical import canonical_bytes
from cocore.p256 import sign_p256, verify_p256


def _pub_b64(private_key: ec.EllipticCurvePrivateKey) -> str:
    numbers = private_key.public_key().public_numbers()
    raw = numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")
    return base64.b64encode(raw).decode("ascii")


def test_sign_then_verify_round_trip() -> None:
    priv = ec.generate_private_key(ec.SECP256R1())
    message = canonical_bytes({"nonce": "abc", "timestamp": "2026-01-01T00:00:00Z"})
    sig = sign_p256(priv, message)
    assert verify_p256(_pub_b64(priv), sig, message)


def test_tampered_message_fails_verification() -> None:
    priv = ec.generate_private_key(ec.SECP256R1())
    message = canonical_bytes({"nonce": "abc"})
    sig = sign_p256(priv, message)
    tampered = canonical_bytes({"nonce": "xyz"})
    assert not verify_p256(_pub_b64(priv), sig, tampered)
