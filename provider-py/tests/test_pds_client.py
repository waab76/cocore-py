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
    )
    with pytest.raises(PdsError, match="malformed"):
        await client.publish("dev.cocore.compute.receipt", {})
