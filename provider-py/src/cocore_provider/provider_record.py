"""Builds the `dev.cocore.compute.provider` record. The console's Machines
view is built from PDS-indexed provider records (one per machine) with live
advisor standing overlaid by machineId == this record's rkey — a machine
that never publishes one is invisible in the console even while it is
successfully registered on the advisor's WebSocket."""

from __future__ import annotations

from datetime import UTC, datetime

from cocore_provider import pricing


def _rfc3339(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_provider_record(
    *,
    machine_label: str,
    chip: str,
    ram_gb: int,
    supported_models: list[str],
    encryption_pub_key: str,
    attestation_pub_key: str,
    binary_version: str,
) -> dict[str, object]:
    now = datetime.now(UTC)
    return {
        "machineLabel": machine_label,
        "chip": chip,
        # `max(ram_gb, 1)`: the lexicon requires ramGB >= 1; an unreadable /
        # zero reading from psutil must not fail the whole publish over a
        # cosmetic field.
        "ramGB": max(ram_gb, 1),
        "supportedModels": supported_models,
        "priceList": [
            {
                "modelId": model,
                "inputPricePerMTok": pricing.UNIFORM_INPUT_PER_MTOK,
                "outputPricePerMTok": pricing.UNIFORM_OUTPUT_PER_MTOK,
                "currency": pricing.UNIFORM_CURRENCY,
            }
            for model in supported_models
        ],
        "encryptionPubKey": encryption_pub_key,
        "attestationPubKey": attestation_pub_key,
        # No hardware attestation chain off Apple silicon (mirrors
        # attestation.py's honestly-self-attested posture).
        "trustLevel": "self-attested",
        "binaryVersion": binary_version,
        "serving": True,
        "createdAt": _rfc3339(now),
    }
