from __future__ import annotations

from datetime import UTC, datetime

from cocore.p256 import verify_receipt_signature
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey

from cocore_provider.identity import Identity
from cocore_provider.receipt import ReceiptInputs, build_receipt


def _identity() -> Identity:
    return Identity(
        signing_key=ec.generate_private_key(ec.SECP256R1()),
        encryption_key=PrivateKey.generate(),
    )


def _inputs() -> ReceiptInputs:
    now = datetime.now(UTC)
    return ReceiptInputs(
        job_uri="at://did:plc:r/dev.cocore.compute.job/1",
        job_cid="bafyjob",
        requester_did="did:plc:r",
        model="llama-3.1-8b",
        input_commitment="a" * 64,
        output_commitment="b" * 64,
        tokens_in=32,
        tokens_out=128,
        started_at=now,
        completed_at=now,
        price_amount=160,
        price_currency="CC",
        attestation_uri="at://did:plc:p/dev.cocore.compute.attestation/1",
        attestation_cid="bafyatt",
    )


def test_receipt_has_required_fields_and_verifies() -> None:
    identity = _identity()
    record = build_receipt(identity, _inputs())

    assert record["job"] == {"uri": "at://did:plc:r/dev.cocore.compute.job/1", "cid": "bafyjob"}
    assert record["requester"] == "did:plc:r"
    assert record["model"] == "llama-3.1-8b"
    assert record["tokens"] == {"in": 32, "out": 128}
    assert record["price"] == {"amount": 160, "currency": "CC"}
    assert record["attestation"] == {
        "uri": "at://did:plc:p/dev.cocore.compute.attestation/1",
        "cid": "bafyatt",
    }
    assert "enclaveSignature" in record
    assert verify_receipt_signature(record, identity.signing_public_b64)


def test_tampering_invalidates_signature() -> None:
    identity = _identity()
    record = build_receipt(identity, _inputs())
    record["price"]["amount"] = 999999  # type: ignore[index]
    assert not verify_receipt_signature(record, identity.signing_public_b64)
