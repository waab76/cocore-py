"""Builds the `dev.cocore.compute.provider` record. The console's Machines
view is built from PDS-indexed provider records (one per machine) with live
advisor standing overlaid by machineId == this record's rkey — a machine
that never publishes one is invisible in the console even while it is
successfully registered on the advisor's WebSocket."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

from cocore_provider import pricing
from cocore_provider.pds_client import PdsClient, PdsError, PublishedRecord

logger = logging.getLogger(__name__)

# Owner-written fields on the provider record: set from the console, never
# authored by the agent. Preserved verbatim across every republish. Mirrors
# `provider/src/pds.rs::OWNER_INTENT_KEYS`. provider-py doesn't build any of
# these onto its own record yet (no desiredModels/desiredTier/proBono/
# shareLocation/toolCalls support here today) -- listed anyway so the merge
# is correct the moment any of them lands, instead of needing this file
# touched again at the same time.
OWNER_INTENT_KEYS: frozenset[str] = frozenset(
    {
        "active",
        "payoutsEnabled",
        "desiredModels",
        "desiredTier",
        "proBono",
        "shareLocation",
        "toolCalls",
    }
)

# Agent-authored fields that are present on SOME serves and absent on
# others (a tier the machine earned then lost, a fault that cleared). A key
# here that this serve's `agent_record` does NOT include gets deleted from
# the merged body, so a stale value doesn't linger. Mirrors
# `provider/src/pds.rs::AGENT_OPTIONAL_KEYS`; empty today because
# `build_provider_record` doesn't emit any such field yet.
AGENT_OPTIONAL_KEYS: frozenset[str] = frozenset()


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


def merge_agent_fields(
    base: dict[str, object], agent_record: dict[str, object]
) -> dict[str, object]:
    """Merge this serve's freshly-built `agent_record` onto the LATEST record
    body read from the PDS (`base`), so a republish can never clobber an
    owner-intent field or a field this build doesn't know about. Mirrors
    `provider/src/pds.rs::merge_agent_provider_fields`:

    1. Start from `base` -- every existing key survives by default.
    2. Delete any `AGENT_OPTIONAL_KEYS` entry this serve did NOT emit, so a
       tier/fault/etc. the machine no longer has doesn't linger.
    3. Overlay every key in `agent_record`, except an `OWNER_INTENT_KEYS`
       entry -- the agent must never author those.
    """
    out = dict(base)
    for key in AGENT_OPTIONAL_KEYS:
        if key not in agent_record:
            out.pop(key, None)
    for key, value in agent_record.items():
        if key in OWNER_INTENT_KEYS:
            continue
        out[key] = value
    return out


async def publish_provider_record(
    pds: PdsClient, attestation_pub_key: str, record: dict[str, object]
) -> PublishedRecord:
    """Publish this machine's provider record, reusing the rkey of any
    existing record with the same `attestationPubKey` instead of minting a
    fresh one every serve start -- otherwise the console accumulates one
    duplicate machine row per restart. Any OTHER duplicates found (stale
    reinstalls) are deleted, keeping the newest by `createdAt`. Mirrors
    `provider/src/main.rs::dedup_and_publish_provider`, without its
    compare-and-swap retry loop -- provider-py is a single process, so the
    rare concurrent-write race is accepted rather than built out."""

    def attestation_pub_key_of(r: dict[str, object]) -> object:
        value = r.get("value")
        return value.get("attestationPubKey") if isinstance(value, dict) else None

    listed = await pds.list_records("dev.cocore.compute.provider")
    matching = [r for r in listed if attestation_pub_key_of(r) == attestation_pub_key]
    if not matching:
        return await pds.publish("dev.cocore.compute.provider", record)

    def created_at(r: dict[str, object]) -> str:
        value = r.get("value")
        ts = value.get("createdAt") if isinstance(value, dict) else None
        return ts if isinstance(ts, str) else ""

    matching.sort(key=created_at, reverse=True)
    keeper = matching[0]
    keeper_rkey = str(keeper["uri"]).rsplit("/", 1)[-1]

    for loser in matching[1:]:
        loser_rkey = str(loser["uri"]).rsplit("/", 1)[-1]
        try:
            await pds.delete_record("dev.cocore.compute.provider", loser_rkey)
            logger.info("deleted duplicate provider record rkey=%s", loser_rkey)
        except PdsError:
            logger.warning(
                "failed to delete duplicate provider record rkey=%s", loser_rkey, exc_info=True
            )

    keeper_value = keeper.get("value")
    base = keeper_value if isinstance(keeper_value, dict) else {}
    merged = merge_agent_fields(base, record)
    return await pds.put_record("dev.cocore.compute.provider", keeper_rkey, merged)
