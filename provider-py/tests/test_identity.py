from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519

from cocore_provider.identity import IdentityError, load_or_create


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


def test_corrupted_json_raises_identity_error(tmp_path: Path) -> None:
    """Truncated/corrupted JSON file should raise IdentityError naming the file."""
    path = tmp_path / "identity.json"
    path.write_text("{truncated")  # Invalid JSON

    with pytest.raises(IdentityError) as exc_info:
        load_or_create(path)

    error_msg = str(exc_info.value)
    assert str(path) in error_msg
    assert "JSONDecodeError" in error_msg


def test_missing_encryption_key_raises_identity_error(tmp_path: Path) -> None:
    """JSON file with missing required key should raise IdentityError."""
    path = tmp_path / "identity.json"
    path.write_text(json.dumps({"signing_priv_pem": "some_value"}))

    with pytest.raises(IdentityError) as exc_info:
        load_or_create(path)

    error_msg = str(exc_info.value)
    assert str(path) in error_msg
    assert "KeyError" in error_msg or "Error" in error_msg


def test_malformed_pem_key_raises_identity_error(tmp_path: Path) -> None:
    """JSON file with malformed PEM key should raise IdentityError."""
    path = tmp_path / "identity.json"
    path.write_text(
        json.dumps(
            {
                "signing_priv_pem": "not-a-valid-pem",
                "encryption_priv_b64": base64.b64encode(b"tooshort").decode("ascii"),
            }
        )
    )

    with pytest.raises(IdentityError) as exc_info:
        load_or_create(path)

    error_msg = str(exc_info.value)
    assert str(path) in error_msg


def test_malformed_encryption_key_raises_identity_error(tmp_path: Path) -> None:
    """JSON file with malformed encryption key should raise IdentityError."""
    path = tmp_path / "identity.json"
    # Create a valid PEM key first, then modify the encryption key to be invalid
    test_key = ec.generate_private_key(ec.SECP256R1())
    priv_pem = test_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    path.write_text(
        json.dumps(
            {
                "signing_priv_pem": priv_pem,
                "encryption_priv_b64": base64.b64encode(b"tooshort").decode("ascii"),
            }
        )
    )

    with pytest.raises(IdentityError) as exc_info:
        load_or_create(path)

    error_msg = str(exc_info.value)
    assert str(path) in error_msg


def test_non_ec_signing_key_raises_identity_error(tmp_path: Path) -> None:
    """JSON file with a non-EC signing key (e.g. Ed25519) should raise IdentityError."""
    path = tmp_path / "identity.json"
    # Create a valid Ed25519 key (non-EC)
    ed_key = ed25519.Ed25519PrivateKey.generate()
    ed_pem = ed_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    ).decode("ascii")

    path.write_text(
        json.dumps(
            {
                "signing_priv_pem": ed_pem,
                "encryption_priv_b64": base64.b64encode(b"\x00" * 32).decode("ascii"),
            }
        )
    )

    with pytest.raises(IdentityError) as exc_info:
        load_or_create(path)

    error_msg = str(exc_info.value)
    assert str(path) in error_msg
    assert "non-EC" in error_msg or "non-EC signing key" in error_msg


def test_no_temp_file_left_after_successful_create(tmp_path: Path) -> None:
    """Successful load_or_create should leave no .tmp files behind."""
    path = tmp_path / "identity.json"
    load_or_create(path)

    # Check for any .tmp files in the parent directory
    tmp_files = list(path.parent.glob("*.tmp"))
    assert len(tmp_files) == 0, f"Temp files left behind: {tmp_files}"
