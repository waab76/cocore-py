from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey as BoxPrivateKey

from cocore_provider.config import AgentConfig
from cocore_provider.diagnostics import (
    check_attestation_status,
    check_health,
    check_lmstudio,
    check_whoami,
    run_doctor,
)
from cocore_provider.identity import Identity
from cocore_provider.pds_client import PdsClient


def _client(handler: httpx.MockTransport) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=handler)


def _identity() -> Identity:
    return Identity(
        signing_key=ec.generate_private_key(ec.SECP256R1()),
        encryption_key=BoxPrivateKey.generate(),
    )


@pytest.mark.asyncio
async def test_check_lmstudio_ok_with_models() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/models"
        return httpx.Response(200, json={"data": [{"id": "llama-3.1-8b"}]})

    check = await check_lmstudio("http://localhost:1234", _client(httpx.MockTransport(handler)))
    assert check.ok is True
    assert "llama-3.1-8b" in check.note


@pytest.mark.asyncio
async def test_check_lmstudio_unreachable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    check = await check_lmstudio("http://localhost:1234", _client(httpx.MockTransport(handler)))
    assert check.ok is False
    assert "unreachable" in check.note


@pytest.mark.asyncio
async def test_check_lmstudio_no_models_loaded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": []})

    check = await check_lmstudio("http://localhost:1234", _client(httpx.MockTransport(handler)))
    assert check.ok is False
    assert "no models loaded" in check.note


@pytest.mark.asyncio
async def test_check_whoami_valid() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/agent/whoami"
        assert request.headers["authorization"] == "Bearer key123"
        return httpx.Response(200, json={"did": "did:plc:abc", "valid": True})

    check = await check_whoami(
        "https://console.example", "key123", _client(httpx.MockTransport(handler))
    )
    assert check.ok is True
    assert "did:plc:abc" in check.note


@pytest.mark.asyncio
async def test_check_whoami_401() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="unauthorized")

    check = await check_whoami(
        "https://console.example", "bad", _client(httpx.MockTransport(handler))
    )
    assert check.ok is False
    assert "401" in check.note


@pytest.mark.asyncio
async def test_check_whoami_valid_false() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"did": "did:plc:abc", "valid": False})

    check = await check_whoami(
        "https://console.example", "key123", _client(httpx.MockTransport(handler))
    )
    assert check.ok is False
    assert "valid=false" in check.note


@pytest.mark.asyncio
async def test_check_health_healthy() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/agent/health"
        return httpx.Response(
            200,
            json={
                "diagnosis": "healthy",
                "hint": "you're good",
                "advisor": {"online": True},
                "pds": {"providerRecord": {"uri": "at://did:plc:p/dev.cocore.compute.provider/1"}},
            },
        )

    check = await check_health(
        "https://console.example", "key123", _client(httpx.MockTransport(handler))
    )
    assert check.ok is True
    assert "healthy" in check.note


@pytest.mark.asyncio
async def test_check_health_publishing_failing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "diagnosis": "publishing-failing",
                "hint": "re-pair",
                "advisor": {"online": True},
                "pds": {"providerRecord": None},
            },
        )

    check = await check_health(
        "https://console.example", "key123", _client(httpx.MockTransport(handler))
    )
    assert check.ok is False
    assert "no provider record on PDS" in check.note


@pytest.mark.asyncio
async def test_run_doctor_skips_health_when_whoami_fails() -> None:
    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "m"}]})

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/whoami":
            return httpx.Response(401, text="unauthorized")
        raise AssertionError(f"unexpected call: {request.url.path}")

    config = AgentConfig(
        advisor_url="wss://advisor.cocore.dev/v1/agent",
        advisor_did="did:web:advisor.cocore.dev",
        api_base="https://console.example",
        api_key="key123",
        lmstudio_url="http://localhost:1234",
        identity_path=Path("/tmp/unused-identity.json"),
        machine_label="test-machine",
    )
    checks = await run_doctor(
        config,
        lmstudio_http=_client(httpx.MockTransport(lmstudio_handler)),
        console_http=_client(httpx.MockTransport(console_handler)),
    )
    names_and_ok = {c.name: c.ok for c in checks}
    assert names_and_ok["LMStudio"] is True
    assert names_and_ok["API key"] is False
    assert names_and_ok["cross-system health"] is False
    health_check = next(c for c in checks if c.name == "cross-system health")
    assert "skipped" in health_check.note


def _plc_and_records_handler(
    attestations: list[dict[str, object]], providers: list[dict[str, object]]
) -> httpx.MockTransport:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        collection = request.url.params.get("collection")
        if collection == "dev.cocore.compute.attestation":
            return httpx.Response(200, json={"records": attestations})
        if collection == "dev.cocore.compute.provider":
            return httpx.Response(200, json={"records": providers})
        raise AssertionError(f"unexpected collection: {collection}")

    return httpx.MockTransport(handler)


@pytest.mark.asyncio
async def test_check_attestation_status_no_record() -> None:
    identity = _identity()
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler([], [])),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert check.ok is False
    assert "no attestation record published yet" in check.note


@pytest.mark.asyncio
async def test_check_attestation_status_valid_unexpired() -> None:
    identity = _identity()
    pub_key = identity.signing_public_b64
    attestations = [
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.attestation/1",
            "cid": "c1",
            "value": {
                "publicKey": pub_key,
                "attestedAt": "2026-07-06T00:00:00Z",
                "expiresAt": "2099-07-06T00:00:00Z",
            },
        }
    ]
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler(attestations, [])),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert check.ok is True
    assert "(valid)" in check.note
    assert "attestationFault" not in check.note


@pytest.mark.asyncio
async def test_check_attestation_status_expired() -> None:
    identity = _identity()
    pub_key = identity.signing_public_b64
    attestations = [
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.attestation/1",
            "cid": "c1",
            "value": {
                "publicKey": pub_key,
                "attestedAt": "2020-01-01T00:00:00Z",
                "expiresAt": "2020-01-02T00:00:00Z",
            },
        }
    ]
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler(attestations, [])),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert check.ok is False
    assert "(expired)" in check.note


@pytest.mark.asyncio
async def test_check_attestation_status_picks_latest_by_attested_at() -> None:
    identity = _identity()
    pub_key = identity.signing_public_b64
    attestations = [
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.attestation/old",
            "cid": "c1",
            "value": {
                "publicKey": pub_key,
                "attestedAt": "2026-01-01T00:00:00Z",
                "expiresAt": "2099-01-02T00:00:00Z",
            },
        },
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.attestation/new",
            "cid": "c2",
            "value": {
                "publicKey": pub_key,
                "attestedAt": "2026-07-06T00:00:00Z",
                "expiresAt": "2099-07-07T00:00:00Z",
            },
        },
    ]
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler(attestations, [])),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert "/new" in check.note
    assert "/old" not in check.note


@pytest.mark.asyncio
async def test_check_attestation_status_surfaces_provider_fault() -> None:
    identity = _identity()
    pub_key = identity.signing_public_b64
    attestations = [
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.attestation/1",
            "cid": "c1",
            "value": {
                "publicKey": pub_key,
                "attestedAt": "2026-07-06T00:00:00Z",
                "expiresAt": "2099-07-06T00:00:00Z",
            },
        }
    ]
    providers = [
        {
            "uri": "at://did:plc:abc/dev.cocore.compute.provider/1",
            "cid": "c2",
            "value": {
                "attestationPubKey": pub_key,
                "attestationFault": {
                    "code": "attestation-publish-failed",
                    "message": "pds unavailable",
                },
            },
        }
    ]
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(_plc_and_records_handler(attestations, providers)),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert check.ok is False
    assert "attestationFault: attestation-publish-failed" in check.note


@pytest.mark.asyncio
async def test_check_attestation_status_read_error() -> None:
    identity = _identity()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        return httpx.Response(500, text="boom")

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=_client(httpx.MockTransport(handler)),
        did="did:plc:abc",
    )
    check = await check_attestation_status(pds, identity)
    assert check.ok is False
    assert "could not read attestation records" in check.note
