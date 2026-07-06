from __future__ import annotations

import json

import httpx
import pytest

from cocore_provider.pds_client import PdsClient, PdsError


def _client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler)


@pytest.mark.asyncio
async def test_mint_service_auth_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/pds/getServiceAuth"
        assert request.headers["authorization"] == "Bearer key123"
        body = json.loads(request.content)
        assert body == {
            "aud": "did:web:advisor.cocore.dev",
            "lxm": "dev.cocore.compute.register",
        }
        return httpx.Response(200, json={"token": "jwt.abc"})

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    token = await client.mint_service_auth(
        "did:web:advisor.cocore.dev", "dev.cocore.compute.register"
    )
    assert token == "jwt.abc"


@pytest.mark.asyncio
async def test_mint_service_auth_failure_raises_pds_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    client = PdsClient(
        api_base="https://console.example",
        api_key="bad",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="401"):
        await client.mint_service_auth("aud", "lxm")


@pytest.mark.asyncio
async def test_mint_service_auth_malformed_response_raises_pds_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"notToken": "jwt.abc"})

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="malformed"):
        await client.mint_service_auth("aud", "lxm")


@pytest.mark.asyncio
async def test_publish_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/pds/createRecord"
        body = json.loads(request.content)
        assert body["collection"] == "dev.cocore.compute.receipt"
        assert body["record"] == {"model": "m"}
        return httpx.Response(
            200,
            json={
                "uri": "at://did:plc:p/dev.cocore.compute.receipt/1",
                "cid": "bafyrec",
                "commit": {"cid": "bafycommit", "rev": "rev1"},
            },
        )

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    published = await client.publish("dev.cocore.compute.receipt", {"model": "m"})
    assert published.uri == "at://did:plc:p/dev.cocore.compute.receipt/1"
    assert published.cid == "bafyrec"


@pytest.mark.asyncio
async def test_publish_failure_raises_pds_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="500"):
        await client.publish("dev.cocore.compute.receipt", {})


@pytest.mark.asyncio
async def test_publish_malformed_response_raises_pds_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"uri": "at://did:plc:p/dev.cocore.compute.receipt/1"})

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="malformed"):
        await client.publish("dev.cocore.compute.receipt", {})


@pytest.mark.asyncio
async def test_resolve_pds_endpoint_did_plc_success() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "plc.directory"
        assert request.url.path == "/did:plc:abc"
        return httpx.Response(
            200,
            json={
                "service": [
                    {
                        "id": "#atproto_pds",
                        "type": "AtprotoPersonalDataServer",
                        "serviceEndpoint": "https://pds.example",
                    }
                ]
            },
        )

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    assert await client.resolve_pds_endpoint() == "https://pds.example"


@pytest.mark.asyncio
async def test_resolve_pds_endpoint_did_web() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(lambda r: httpx.Response(500))),
        did="did:web:provider.example.com",
    )
    assert await client.resolve_pds_endpoint() == "https://provider.example.com"


@pytest.mark.asyncio
async def test_resolve_pds_endpoint_unsupported_did_method() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(lambda r: httpx.Response(500))),
        did="did:key:zabc",
    )
    with pytest.raises(PdsError, match="unsupported DID method"):
        await client.resolve_pds_endpoint()


@pytest.mark.asyncio
async def test_resolve_pds_endpoint_plc_non_200_raises() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(lambda r: httpx.Response(404))),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="404"):
        await client.resolve_pds_endpoint()


@pytest.mark.asyncio
async def test_resolve_pds_endpoint_plc_doc_missing_service_raises() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(lambda r: httpx.Response(200, json={"service": []}))),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="no atproto_pds service"):
        await client.resolve_pds_endpoint()


@pytest.mark.asyncio
async def test_list_records_single_page() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        assert request.url.host == "pds.example"
        assert request.url.path == "/xrpc/com.atproto.repo.listRecords"
        assert request.url.params["repo"] == "did:plc:abc"
        assert request.url.params["collection"] == "dev.cocore.compute.provider"
        return httpx.Response(
            200,
            json={
                "records": [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                        "cid": "c1",
                        "value": {},
                    }
                ]
            },
        )

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    records = await client.list_records("dev.cocore.compute.provider")
    assert len(records) == 1
    assert records[0]["uri"] == "at://did:plc:abc/dev.cocore.compute.provider/r1"


@pytest.mark.asyncio
async def test_list_records_paginates_via_cursor() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        calls += 1
        if calls == 1:
            assert "cursor" not in request.url.params
            return httpx.Response(
                200, json={"records": [{"uri": "r1", "cid": "c1", "value": {}}], "cursor": "next"}
            )
        assert request.url.params["cursor"] == "next"
        return httpx.Response(200, json={"records": [{"uri": "r2", "cid": "c2", "value": {}}]})

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    records = await client.list_records("dev.cocore.compute.provider")
    assert [r["uri"] for r in records] == ["r1", "r2"]


@pytest.mark.asyncio
async def test_list_records_non_200_raises_pds_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        return httpx.Response(500, text="boom")

    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    with pytest.raises(PdsError, match="500"):
        await client.list_records("dev.cocore.compute.provider")


def _plc_and_records_handler(records: list[dict[str, object]]) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        return httpx.Response(200, json={"records": records})

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_get_provider_active_true() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(
            _plc_and_records_handler(
                [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                        "cid": "c1",
                        "value": {"active": True},
                    }
                ]
            )
        ),
        did="did:plc:abc",
    )
    assert await client.get_provider_active("r1") is True


@pytest.mark.asyncio
async def test_get_provider_active_false() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(
            _plc_and_records_handler(
                [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                        "cid": "c1",
                        "value": {"active": False},
                    }
                ]
            )
        ),
        did="did:plc:abc",
    )
    assert await client.get_provider_active("r1") is False


@pytest.mark.asyncio
async def test_get_provider_active_absent_field_returns_none() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(
            _plc_and_records_handler(
                [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/r1",
                        "cid": "c1",
                        "value": {},
                    }
                ]
            )
        ),
        did="did:plc:abc",
    )
    assert await client.get_provider_active("r1") is None


@pytest.mark.asyncio
async def test_get_provider_active_rkey_not_found_returns_none() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler([])),
        did="did:plc:abc",
    )
    assert await client.get_provider_active("missing") is None


@pytest.mark.asyncio
async def test_get_provider_active_read_error_returns_none() -> None:
    client = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(lambda r: httpx.Response(500))),
        did="did:plc:abc",
    )
    assert await client.get_provider_active("r1") is None
