from __future__ import annotations

import httpx
import pytest

from cocore_provider.pds_client import PdsClient
from cocore_provider.provider_record import (
    build_provider_record,
    merge_agent_fields,
    publish_provider_record,
)


def test_build_provider_record_required_fields() -> None:
    record = build_provider_record(
        machine_label="win-box",
        chip="lmstudio:windows",
        ram_gb=32,
        supported_models=["llama-3.1-8b", "qwen2.5-coder"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert record["machineLabel"] == "win-box"
    assert record["chip"] == "lmstudio:windows"
    assert record["ramGB"] == 32
    assert record["supportedModels"] == ["llama-3.1-8b", "qwen2.5-coder"]
    assert record["encryptionPubKey"] == "epk=="
    assert record["attestationPubKey"] == "apk=="
    assert record["trustLevel"] == "self-attested"
    assert record["binaryVersion"] == "0.1.0"
    assert isinstance(record["createdAt"], str)
    price_list = record["priceList"]
    assert isinstance(price_list, list)
    assert [p["modelId"] for p in price_list] == ["llama-3.1-8b", "qwen2.5-coder"]
    assert all(p["currency"] == "CC" for p in price_list)


def test_build_provider_record_ram_floor() -> None:
    # Lexicon requires ramGB >= 1; a 0/unreadable psutil reading must not
    # produce an invalid record.
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=0,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert record["ramGB"] == 1


def test_merge_agent_fields_preserves_owner_intent() -> None:
    base = {
        "machineLabel": "old-label",
        "active": False,
        "desiredModels": ["qwen2.5-coder"],
        "createdAt": "2026-01-01T00:00:00Z",
    }
    agent_record = {"machineLabel": "new-label", "createdAt": "2026-07-06T00:00:00Z"}

    merged = merge_agent_fields(base, agent_record)

    # Agent-authored fields overlay.
    assert merged["machineLabel"] == "new-label"
    assert merged["createdAt"] == "2026-07-06T00:00:00Z"
    # Owner-intent fields survive untouched even though the agent never
    # authors them.
    assert merged["active"] is False
    assert merged["desiredModels"] == ["qwen2.5-coder"]


def test_merge_agent_fields_preserves_unknown_keys() -> None:
    base = {"someFutureField": "kept", "machineLabel": "old"}
    merged = merge_agent_fields(base, {"machineLabel": "new"})
    assert merged["someFutureField"] == "kept"
    assert merged["machineLabel"] == "new"


def _plc_handler() -> httpx.Response:
    return httpx.Response(
        200,
        json={"service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]},
    )


@pytest.mark.asyncio
async def test_publish_provider_record_creates_when_none_exists() -> None:
    created: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(200, json={"records": []})
        if request.url.path == "/api/pds/createRecord":
            body = request.content
            import json as _json

            created.append(_json.loads(body))
            return httpx.Response(
                200,
                json={"uri": "at://did:plc:abc/dev.cocore.compute.provider/new1", "cid": "c1"},
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    published = await publish_provider_record(
        pds, "apk==", {"machineLabel": "m", "attestationPubKey": "apk=="}
    )
    assert published.rkey == "new1"
    assert len(created) == 1


@pytest.mark.asyncio
async def test_publish_provider_record_reuses_existing_rkey() -> None:
    put_calls: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(
                200,
                json={
                    "records": [
                        {
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/existing1",
                            "cid": "oldcid",
                            "value": {
                                "attestationPubKey": "apk==",
                                "active": False,
                                "createdAt": "2026-01-01T00:00:00Z",
                            },
                        }
                    ]
                },
            )
        if request.url.path == "/api/pds/putRecord":
            import json as _json

            body = _json.loads(request.content)
            put_calls.append(body)
            return httpx.Response(
                200,
                json={
                    "uri": "at://did:plc:abc/dev.cocore.compute.provider/existing1",
                    "cid": "newcid",
                },
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    published = await publish_provider_record(
        pds, "apk==", {"machineLabel": "m", "attestationPubKey": "apk=="}
    )
    assert published.rkey == "existing1"
    assert len(put_calls) == 1
    assert put_calls[0]["rkey"] == "existing1"
    # The owner's `active: False` from the existing record must survive the
    # republish -- the agent never authors that field.
    assert put_calls[0]["record"]["active"] is False
    assert put_calls[0]["record"]["machineLabel"] == "m"


@pytest.mark.asyncio
async def test_publish_provider_record_deletes_stale_duplicates() -> None:
    deleted_rkeys: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(
                200,
                json={
                    "records": [
                        {
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/older",
                            "cid": "c-older",
                            "value": {
                                "attestationPubKey": "apk==",
                                "createdAt": "2026-01-01T00:00:00Z",
                            },
                        },
                        {
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/newer",
                            "cid": "c-newer",
                            "value": {
                                "attestationPubKey": "apk==",
                                "createdAt": "2026-06-01T00:00:00Z",
                            },
                        },
                    ]
                },
            )
        if request.url.path == "/api/pds/deleteRecord":
            import json as _json

            body = _json.loads(request.content)
            deleted_rkeys.append(body["rkey"])
            return httpx.Response(200, json={"uri": "at://x", "alreadyGone": False})
        if request.url.path == "/api/pds/putRecord":
            return httpx.Response(
                200,
                json={
                    "uri": "at://did:plc:abc/dev.cocore.compute.provider/newer",
                    "cid": "c-final",
                },
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    published = await publish_provider_record(
        pds, "apk==", {"machineLabel": "m", "attestationPubKey": "apk=="}
    )
    # The NEWER of the two duplicates is kept (by createdAt); the older one
    # is deleted.
    assert published.rkey == "newer"
    assert deleted_rkeys == ["older"]


@pytest.mark.asyncio
async def test_publish_provider_record_ignores_other_machines_pubkey() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(
                200,
                json={
                    "records": [
                        {
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/other-machine",
                            "cid": "c1",
                            "value": {"attestationPubKey": "SOME-OTHER-KEY"},
                        }
                    ]
                },
            )
        if request.url.path == "/api/pds/createRecord":
            return httpx.Response(
                200,
                json={"uri": "at://did:plc:abc/dev.cocore.compute.provider/fresh", "cid": "c2"},
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    published = await publish_provider_record(
        pds, "apk==", {"machineLabel": "m", "attestationPubKey": "apk=="}
    )
    # A record with a DIFFERENT attestationPubKey describes a sibling
    # machine under the same DID -- must be left alone, not reused/deleted.
    assert published.rkey == "fresh"
