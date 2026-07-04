from __future__ import annotations

import base64
from pathlib import Path

from cocore_provider.identity import load_or_create


def test_creates_and_persists_identity(tmp_path: Path) -> None:
    path = tmp_path / "identity.json"
    assert not path.exists()

    identity = load_or_create(path)
    assert path.exists()

    signing_pub = base64.b64decode(identity.signing_public_b64)
    assert len(signing_pub) == 64  # raw X||Y, no 0x04 prefix

    encryption_pub = base64.b64decode(identity.encryption_public_b64)
    assert len(encryption_pub) == 32  # X25519 public key


def test_reloading_returns_same_keys(tmp_path: Path) -> None:
    path = tmp_path / "identity.json"
    first = load_or_create(path)
    second = load_or_create(path)

    assert first.signing_public_b64 == second.signing_public_b64
    assert first.encryption_public_b64 == second.encryption_public_b64
