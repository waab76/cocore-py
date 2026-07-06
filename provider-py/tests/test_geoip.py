from __future__ import annotations

import httpx
import pytest

from cocore_provider import geoip


def test_parse_country_bare_code() -> None:
    assert geoip.parse_country("US") == "US"
    assert geoip.parse_country("us\n") == "US"
    assert geoip.parse_country("  de  ") == "DE"


def test_parse_country_json_body() -> None:
    assert geoip.parse_country('{"country_code":"GB"}') == "GB"
    assert geoip.parse_country('{"countryCode":"fr","other":1}') == "FR"
    assert geoip.parse_country('{"country_iso":"jp"}') == "JP"
    assert geoip.parse_country('{"country":"ca"}') == "CA"


def test_parse_country_rejects_garbage() -> None:
    assert geoip.parse_country("not a country") is None
    assert geoip.parse_country("USA") is None
    assert geoip.parse_country("") is None
    assert geoip.parse_country("12") is None
    assert geoip.parse_country('{"foo":"bar"}') is None
    assert geoip.parse_country("[1, 2, 3]") is None


def test_endpoint_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("COCORE_GEOIP_URL", raising=False)
    assert geoip.endpoint() == geoip.DEFAULT_ENDPOINT


def test_endpoint_override(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")
    assert geoip.endpoint() == "https://geo.example/country"


def test_endpoint_blank_env_falls_back_to_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "   ")
    assert geoip.endpoint() == geoip.DEFAULT_ENDPOINT


@pytest.mark.asyncio
async def test_resolve_country_success(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == "https://geo.example/country"
        return httpx.Response(200, text="US")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await geoip.resolve_country(http) == "US"


@pytest.mark.asyncio
async def test_resolve_country_non_200_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="unavailable")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await geoip.resolve_country(http) is None


@pytest.mark.asyncio
async def test_resolve_country_oversized_body_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="x" * (geoip.MAX_BODY_BYTES + 1))

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await geoip.resolve_country(http) is None


@pytest.mark.asyncio
async def test_resolve_country_network_error_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await geoip.resolve_country(http) is None


@pytest.mark.asyncio
async def test_resolve_country_unparseable_body_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("COCORE_GEOIP_URL", "https://geo.example/country")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="not a country code")

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    assert await geoip.resolve_country(http) is None
