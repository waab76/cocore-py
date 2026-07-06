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
# toolCalls support here today) -- listed anyway so the merge is correct the
# moment any of them lands, instead of needing this file touched again at the
# same time. `shareLocation` is the one exception the agent already READS
# (find_my_provider_record, to gate the region/geoip lookup) without ever
# WRITING it -- it stays in this set for the same never-author reason.
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
# `provider/src/pds.rs::AGENT_OPTIONAL_KEYS`.
AGENT_OPTIONAL_KEYS: frozenset[str] = frozenset(
    {
        "engineFault",
        "attestationFault",
        "advisorFault",
        "cpuCores",
        "os",
        "region",
        "regionSource",
        "regionObservedAt",
    }
)


def _rfc3339(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def models_changed(a: list[str], b: list[str]) -> bool:
    """Order/dupe-insensitive model-set comparison. Mirrors
    `provider/src/advisor.rs::models_changed`, used there to decide whether
    an owner's `desiredModels` edit warrants a reload restart; provider-py
    has nothing to reload (see `ws_client.AdvisorConnection._check_desired_models`),
    so this only gates a diagnostic log line."""
    return set(a) != set(b)


def build_provider_record(
    *,
    machine_label: str,
    chip: str,
    ram_gb: int,
    supported_models: list[str],
    encryption_pub_key: str,
    attestation_pub_key: str,
    binary_version: str,
    engine_fault: dict[str, object] | None = None,
    attestation_fault: dict[str, object] | None = None,
    cpu_cores: int | None = None,
    os_name: str | None = None,
    region: str | None = None,
    region_source: str | None = None,
) -> dict[str, object]:
    now = datetime.now(UTC)
    record: dict[str, object] = {
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
    if engine_fault is not None:
        record["engineFault"] = engine_fault
    if attestation_fault is not None:
        record["attestationFault"] = attestation_fault
    # The lexicon requires cpuCores >= 1; an indeterminate psutil read (None)
    # is omitted rather than guessed, same spirit as ramGB's floor above.
    if cpu_cores is not None and cpu_cores >= 1:
        record["cpuCores"] = cpu_cores
    if os_name:
        # Lexicon caps `os` at 64 chars; platform.platform() isn't bounded
        # on every OS (some Linux distros produce long strings).
        record["os"] = os_name[:64]
    # Atomic: only stamped together, and only when the owner opted into
    # location sharing (see find_my_provider_record) AND the geoip lookup
    # actually resolved a country this serve.
    if region is not None and region_source is not None:
        record["region"] = region
        record["regionSource"] = region_source
        record["regionObservedAt"] = _rfc3339(now)
    return record


def build_engine_fault(*, code: str, message: str, models: list[str]) -> dict[str, object]:
    """Present when the agent couldn't bring its inference backend online.
    Mirrors the lexicon's `engineFault` shape. `message` is truncated to the
    lexicon's 600-char cap."""
    return {
        "code": code,
        "message": message[:600],
        "models": models,
        "at": _rfc3339(datetime.now(UTC)),
    }


def build_attestation_fault(*, code: str, message: str) -> dict[str, object]:
    """Present when the agent couldn't build/publish its attestation record.
    Mirrors the lexicon's `attestationFault` shape."""
    return {"code": code, "message": message[:600], "at": _rfc3339(datetime.now(UTC))}


def build_advisor_fault(*, code: str, message: str) -> dict[str, object]:
    """Present when the agent can't establish its WebSocket connection to the
    advisor after repeated consecutive attempts. Mirrors the lexicon's
    `advisorFault` shape (note: `observedAt`, not `at`)."""
    return {"code": code, "message": message[:600], "observedAt": _rfc3339(datetime.now(UTC))}


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


def _attestation_pub_key_of(r: dict[str, object]) -> object:
    value = r.get("value")
    return value.get("attestationPubKey") if isinstance(value, dict) else None


def _created_at_of(r: dict[str, object]) -> str:
    value = r.get("value")
    ts = value.get("createdAt") if isinstance(value, dict) else None
    return ts if isinstance(ts, str) else ""


def _matching_provider_records(
    listed: list[dict[str, object]], attestation_pub_key: str
) -> list[dict[str, object]]:
    """This machine's own provider record(s) -- possibly several if a past
    bug left duplicates -- newest first by `createdAt`. A record with a
    DIFFERENT attestationPubKey describes a sibling machine under the same
    DID and is never touched."""
    matching = [r for r in listed if _attestation_pub_key_of(r) == attestation_pub_key]
    matching.sort(key=_created_at_of, reverse=True)
    return matching


async def find_my_provider_record(
    pds: PdsClient, attestation_pub_key: str
) -> dict[str, object] | None:
    """Read this machine's existing `dev.cocore.compute.provider` record
    body (if any), matched by `attestationPubKey` -- so the caller can
    inspect owner-intent fields (like `shareLocation`) BEFORE deciding this
    serve's behavior. Mirrors `provider/src/main.rs::find_my_provider_record`.
    Returns `None` on first run (no matching record yet) or a read failure --
    callers should treat both the same as "no owner intent known yet"."""
    try:
        listed = await pds.list_records("dev.cocore.compute.provider")
    except PdsError:
        return None
    matching = _matching_provider_records(listed, attestation_pub_key)
    if not matching:
        return None
    value = matching[0].get("value")
    return value if isinstance(value, dict) else None


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
    listed = await pds.list_records("dev.cocore.compute.provider")
    matching = _matching_provider_records(listed, attestation_pub_key)
    if not matching:
        return await pds.publish("dev.cocore.compute.provider", record)

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


async def patch_provider_fault(
    pds: PdsClient, attestation_pub_key: str, field: str, value: dict[str, object] | None
) -> bool:
    """Set (`value` given) or clear (`value=None`) a single agent-diagnostic
    fault field -- `engineFault`, `attestationFault`, or `advisorFault` -- on
    this machine's EXISTING provider record, touching nothing else on it.
    Distinct from the full republish in `publish_provider_record`: this is a
    narrow, best-effort patch for a fault discovered mid-serve (advisorFault
    in particular is only known well after the initial publish). Mirrors
    `provider/src/main.rs::patch_provider_advisor_fault` /
    `republish_attestation_fault`. Returns False (logged, no-op) when no
    matching record exists yet to patch -- the next successful publish will
    include the field if it's still relevant then."""
    listed = await pds.list_records("dev.cocore.compute.provider")
    matching = _matching_provider_records(listed, attestation_pub_key)
    if not matching:
        logger.warning(
            "no provider record found to patch %s onto; skipping (will retry next cycle)", field
        )
        return False

    keeper = matching[0]
    rkey = str(keeper["uri"]).rsplit("/", 1)[-1]
    keeper_value = keeper.get("value")
    base = dict(keeper_value) if isinstance(keeper_value, dict) else {}
    if value is None:
        base.pop(field, None)
    else:
        base[field] = value
    await pds.put_record("dev.cocore.compute.provider", rkey, base)
    return True
