from __future__ import annotations

import httpx
import pytest

from cocore_provider.pds_client import PdsClient
from cocore_provider.provider_record import (
    build_advisor_fault,
    build_attestation_fault,
    build_engine_fault,
    build_provider_record,
    find_my_provider_record,
    merge_agent_fields,
    models_changed,
    patch_provider_fault,
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


def test_build_provider_record_includes_faults_only_when_given() -> None:
    record_without = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert "engineFault" not in record_without
    assert "attestationFault" not in record_without

    record_with = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=[],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        engine_fault=build_engine_fault(code="model-load-failed", message="no models", models=[]),
        attestation_fault=build_attestation_fault(
            code="attestation-publish-failed", message="boom"
        ),
    )
    assert record_with["engineFault"]["code"] == "model-load-failed"  # type: ignore[index]
    assert record_with["attestationFault"]["code"] == "attestation-publish-failed"  # type: ignore[index]


def test_build_engine_fault_shape() -> None:
    fault = build_engine_fault(code="model-load-failed", message="x" * 700, models=["m1"])
    assert fault["code"] == "model-load-failed"
    assert fault["models"] == ["m1"]
    assert len(fault["message"]) == 600  # lexicon cap
    assert isinstance(fault["at"], str)


def test_build_attestation_fault_shape() -> None:
    fault = build_attestation_fault(code="attestation-publish-failed", message="boom")
    assert fault == {
        "code": "attestation-publish-failed",
        "message": "boom",
        "at": fault["at"],
    }


def test_build_advisor_fault_shape() -> None:
    fault = build_advisor_fault(code="dns-failure", message="boom")
    assert fault["code"] == "dns-failure"
    assert fault["message"] == "boom"
    assert "observedAt" in fault
    assert "at" not in fault


def _plc_and_listrecords_handler(records: list[dict[str, object]]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(200, json={"records": records})
        raise AssertionError(f"unexpected call: {request.url}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_patch_provider_fault_sets_field() -> None:
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
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                            "cid": "c1",
                            "value": {"attestationPubKey": "apk==", "machineLabel": "m"},
                        }
                    ]
                },
            )
        if request.url.path == "/api/pds/putRecord":
            import json

            put_calls.append(json.loads(request.content))
            return httpx.Response(
                200, json={"uri": "at://did:plc:abc/dev.cocore.compute.provider/r1", "cid": "c2"}
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    fault = build_advisor_fault(code="dns-failure", message="boom")
    ok = await patch_provider_fault(pds, "apk==", "advisorFault", fault)
    assert ok is True
    assert len(put_calls) == 1
    assert put_calls[0]["rkey"] == "r1"
    assert put_calls[0]["record"]["advisorFault"] == fault
    # Everything else on the record survives untouched.
    assert put_calls[0]["record"]["machineLabel"] == "m"


@pytest.mark.asyncio
async def test_patch_provider_fault_clears_field() -> None:
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
                            "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                            "cid": "c1",
                            "value": {
                                "attestationPubKey": "apk==",
                                "advisorFault": {"code": "dns-failure"},
                            },
                        }
                    ]
                },
            )
        if request.url.path == "/api/pds/putRecord":
            import json

            put_calls.append(json.loads(request.content))
            return httpx.Response(
                200, json={"uri": "at://did:plc:abc/dev.cocore.compute.provider/r1", "cid": "c2"}
            )
        raise AssertionError(f"unexpected call: {request.url}")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    ok = await patch_provider_fault(pds, "apk==", "advisorFault", None)
    assert ok is True
    assert "advisorFault" not in put_calls[0]["record"]


@pytest.mark.asyncio
async def test_patch_provider_fault_no_matching_record_returns_false() -> None:
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=_plc_and_listrecords_handler([])),
        did="did:plc:abc",
    )
    ok = await patch_provider_fault(pds, "apk==", "advisorFault", {"code": "dns-failure"})
    assert ok is False


def test_build_provider_record_omits_cpu_os_region_by_default() -> None:
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
    )
    assert "cpuCores" not in record
    assert "os" not in record
    assert "region" not in record
    assert "regionSource" not in record
    assert "regionObservedAt" not in record


def test_build_provider_record_includes_cpu_cores_and_os() -> None:
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        cpu_cores=16,
        os_name="Linux-6.1.0-x86_64",
    )
    assert record["cpuCores"] == 16
    assert record["os"] == "Linux-6.1.0-x86_64"


def test_build_provider_record_omits_cpu_cores_when_none_or_zero() -> None:
    record_none = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        cpu_cores=None,
    )
    assert "cpuCores" not in record_none

    record_zero = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        cpu_cores=0,
    )
    assert "cpuCores" not in record_zero


def test_build_provider_record_truncates_long_os_name() -> None:
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        os_name="x" * 100,
    )
    assert len(record["os"]) == 64  # type: ignore[arg-type]


def test_build_provider_record_stamps_region_atomically() -> None:
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        region="US",
        region_source="ip-geo",
    )
    assert record["region"] == "US"
    assert record["regionSource"] == "ip-geo"
    assert isinstance(record["regionObservedAt"], str)


def test_build_provider_record_region_without_source_is_omitted() -> None:
    # Only region set, no source -- shouldn't happen from cli.py's wiring,
    # but the atomic all-or-nothing guard must not half-publish.
    record = build_provider_record(
        machine_label="m",
        chip="lmstudio:linux",
        ram_gb=8,
        supported_models=["m1"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        binary_version="0.1.0",
        region="US",
    )
    assert "region" not in record
    assert "regionSource" not in record
    assert "regionObservedAt" not in record


@pytest.mark.asyncio
async def test_find_my_provider_record_returns_matching_value() -> None:
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(
            transport=_plc_and_listrecords_handler(
                [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                        "cid": "c1",
                        "value": {"attestationPubKey": "apk==", "shareLocation": True},
                    }
                ]
            )
        ),
        did="did:plc:abc",
    )
    value = await find_my_provider_record(pds, "apk==")
    assert value is not None
    assert value["shareLocation"] is True


@pytest.mark.asyncio
async def test_find_my_provider_record_no_match_returns_none() -> None:
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=_plc_and_listrecords_handler([])),
        did="did:plc:abc",
    )
    assert await find_my_provider_record(pds, "apk==") is None


@pytest.mark.asyncio
async def test_find_my_provider_record_read_error_returns_none() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return _plc_handler()
        return httpx.Response(500, text="boom")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    assert await find_my_provider_record(pds, "apk==") is None


def test_models_changed_ignores_order_and_dupes_but_catches_edits() -> None:
    assert not models_changed(["x", "y"], ["y", "x"])
    assert not models_changed(["x", "x", "y"], ["y", "x"])
    assert not models_changed([], [])
    assert models_changed(["x"], ["x", "y"])  # added
    assert models_changed(["x", "y"], ["x"])  # removed
    assert models_changed(["x"], [])  # cleared
    assert models_changed([], ["x"])  # newly pinned
