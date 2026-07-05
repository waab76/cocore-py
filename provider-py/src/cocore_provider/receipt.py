"""Builds and signs `dev.cocore.compute.receipt` records. Mirrors
`provider/src/receipt.rs::build` field-for-field for the required fields;
optional fields (`outputCipherCommitment`, `reasoningCommitment`, `params`,
`outputCipherURL`, `proBono`) are out of scope for v1 (see the plan's Global
Constraints)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

from cocore.canonical import canonical_bytes
from cocore.p256 import sign_p256

from cocore_provider.identity import Identity


@dataclass
class ReceiptInputs:
    job_uri: str
    job_cid: str
    requester_did: str
    model: str
    input_commitment: str
    output_commitment: str
    tokens_in: int
    tokens_out: int
    started_at: datetime
    completed_at: datetime
    price_amount: int
    price_currency: str
    attestation_uri: str
    attestation_cid: str


def _rfc3339(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_receipt(identity: Identity, inputs: ReceiptInputs) -> dict[str, object]:
    body: dict[str, object] = {
        "job": {"uri": inputs.job_uri, "cid": inputs.job_cid},
        "requester": inputs.requester_did,
        "model": inputs.model,
        "inputCommitment": inputs.input_commitment,
        "outputCommitment": inputs.output_commitment,
        "tokens": {"in": inputs.tokens_in, "out": inputs.tokens_out},
        "startedAt": _rfc3339(inputs.started_at),
        "completedAt": _rfc3339(inputs.completed_at),
        "price": {"amount": inputs.price_amount, "currency": inputs.price_currency},
        "attestation": {"uri": inputs.attestation_uri, "cid": inputs.attestation_cid},
    }
    signature = sign_p256(identity.signing_key, canonical_bytes(body))
    return {**body, "enclaveSignature": signature}
