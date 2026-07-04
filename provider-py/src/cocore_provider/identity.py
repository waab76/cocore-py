"""Persisted provider identity: a P-256 signing key (mirrors the Rust
provider's Secure-Enclave-bound key, software-backed here since there is no
Secure Enclave off Apple silicon — this is exactly the `best-effort` fallback
`provider/src/secure_enclave.rs` uses on non-macOS today) plus an X25519
encryption key for sealing/opening job payloads."""

from __future__ import annotations

import base64
import json
import os
import stat
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey


@dataclass
class Identity:
    signing_key: ec.EllipticCurvePrivateKey
    encryption_key: PrivateKey

    @property
    def signing_public_b64(self) -> str:
        numbers = self.signing_key.public_key().public_numbers()
        raw = numbers.x.to_bytes(32, "big") + numbers.y.to_bytes(32, "big")
        return base64.b64encode(raw).decode("ascii")

    @property
    def encryption_public_b64(self) -> str:
        return base64.b64encode(bytes(self.encryption_key.public_key)).decode("ascii")


def load_or_create(path: Path) -> Identity:
    if path.exists():
        data = json.loads(path.read_text())
        signing_key = serialization.load_pem_private_key(
            data["signing_priv_pem"].encode("ascii"), password=None
        )
        assert isinstance(signing_key, ec.EllipticCurvePrivateKey)
        encryption_key = PrivateKey(base64.b64decode(data["encryption_priv_b64"]))
        return Identity(signing_key=signing_key, encryption_key=encryption_key)

    signing_key = ec.generate_private_key(ec.SECP256R1())
    encryption_key = PrivateKey.generate()
    identity = Identity(signing_key=signing_key, encryption_key=encryption_key)

    path.parent.mkdir(parents=True, exist_ok=True)
    priv_pem = signing_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")
    payload = {
        "signing_priv_pem": priv_pem,
        "encryption_priv_b64": base64.b64encode(bytes(encryption_key)).decode("ascii"),
    }
    path.write_text(json.dumps(payload))
    os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)
    return identity
