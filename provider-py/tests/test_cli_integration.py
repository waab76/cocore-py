# provider-py/tests/test_cli_integration.py
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

import httpx
import pytest
import websockets
from nacl.public import Box, PrivateKey, PublicKey
from nacl.utils import random as nacl_random

from cocore_provider import __version__
from cocore_provider.cli import serve
from cocore_provider.config import AgentConfig


@pytest.mark.asyncio
async def test_serve_registers_and_serves_one_job(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    requester_priv = PrivateKey.generate()
    dispatched = asyncio.Event()
    hold_connection_open = asyncio.Event()
    seen_chunks: list[dict[str, object]] = []

    async def fake_advisor(ws: websockets.WebSocketServerProtocol) -> None:
        register = json.loads(await ws.recv())
        assert register["type"] == "register"
        assert register["supported_models"] == ["llama-3.1-8b"]
        assert register["attestation_uri"] == "at://did:plc:p/dev.cocore.compute.attestation/1"
        assert register["machine_id"] == "prov1"
        assert register["binary_version"] == __version__
        provider_encryption_pub_b64 = register["encryption_pub_key"]

        box = Box(requester_priv, PublicKey(base64.b64decode(provider_encryption_pub_b64)))
        nonce = nacl_random(Box.NONCE_SIZE)
        ciphertext = nonce + box.encrypt(b"hi", nonce).ciphertext

        await ws.send(
            json.dumps(
                {
                    "type": "inference_request",
                    "job_uri": "at://did:plc:r/dev.cocore.compute.job/1",
                    "job_cid": "bafyjob",
                    "requester_did": "did:plc:r",
                    "requester_pub_key": base64.b64encode(bytes(requester_priv.public_key)).decode(
                        "ascii"
                    ),
                    "model": "llama-3.1-8b",
                    "max_tokens_out": 32,
                    "ciphertext": base64.b64encode(ciphertext).decode("ascii"),
                    "session_id": "s1",
                }
            )
        )
        while not dispatched.is_set():
            frame = json.loads(await ws.recv())
            if frame["type"] == "inference_chunk":
                seen_chunks.append(frame)
            elif frame["type"] == "inference_complete":
                dispatched.set()
        # Keep the connection open until the test has finished cancelling
        # serve_task. Returning here (closing the connection) races
        # AdvisorConnection.run()'s reconnect-with-backoff loop: if a natural
        # ConnectionClosedOK from this handler returning lands in the same
        # tick as the test's serve_task.cancel(), asyncio.TaskGroup's
        # cancellation bookkeeping can absorb the external cancel request,
        # leaving the reconnect loop running forever instead of stopping.
        await hold_connection_open.wait()

    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "llama-3.1-8b"}]})
        sse_body = (
            'data: {"choices":[{"delta":{"content":"hi!"},"finish_reason":"stop"}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(200, content=sse_body, headers={"content-type": "text/event-stream"})

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [
                        {"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"},
                    ]
                },
            )
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            # No existing provider record for this DID -- get_provider_active
            # falls back to "active" (matches a fresh machine with nothing
            # published yet).
            return httpx.Response(200, json={"records": []})
        if request.url.path == "/api/pds/getServiceAuth":
            return httpx.Response(200, json={"token": "jwt.abc"})
        if request.url.path == "/api/pds/createRecord":
            body = json.loads(request.content)
            if body["collection"] == "dev.cocore.compute.attestation":
                return httpx.Response(
                    200,
                    json={
                        "uri": "at://did:plc:p/dev.cocore.compute.attestation/1",
                        "cid": "bafyattest",
                    },
                )
            if body["collection"] == "dev.cocore.compute.provider":
                assert body["record"]["supportedModels"] == ["llama-3.1-8b"]
                assert body["record"]["priceList"][0]["modelId"] == "llama-3.1-8b"
                return httpx.Response(
                    200,
                    json={
                        "uri": "at://did:plc:p/dev.cocore.compute.provider/prov1",
                        "cid": "bafyprov",
                    },
                )
            return httpx.Response(
                200, json={"uri": "at://did:plc:p/dev.cocore.compute.receipt/1", "cid": "bafyrec"}
            )
        raise AssertionError(f"unexpected console call: {request.url.path}")

    monkeypatch.setattr(
        "cocore_provider.cli._build_lmstudio_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = AgentConfig(
            advisor_url=f"ws://localhost:{port}/v1/agent",
            advisor_did="did:web:advisor.cocore.dev",
            api_base="https://console.example",
            api_key="key123",
            lmstudio_url="http://localhost:1234",
            identity_path=tmp_path / "identity.json",
            machine_label="test-machine",
        )
        serve_task = asyncio.create_task(serve(config, provider_did="did:plc:abc"))
        await asyncio.wait_for(dispatched.wait(), timeout=10)
        serve_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await serve_task
        hold_connection_open.set()

    assert len(seen_chunks) == 1


@pytest.mark.asyncio
async def test_serve_survives_lmstudio_down_with_engine_fault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LMStudio unreachable at boot must not crash the whole agent -- it
    should register with an empty supportedModels (excluded from routing)
    and surface `engineFault` on the provider record, matching the Rust
    agent's "stays visible but degraded" behavior."""
    registered = asyncio.Event()
    seen_register: dict[str, object] = {}
    provider_record_bodies: list[dict[str, object]] = []

    async def fake_advisor(ws: websockets.WebSocketServerProtocol) -> None:
        register = json.loads(await ws.recv())
        seen_register.update(register)
        registered.set()
        await ws.wait_closed()

    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="connection refused")

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(200, json={"records": []})
        if request.url.path == "/api/pds/getServiceAuth":
            return httpx.Response(200, json={"token": "jwt.abc"})
        if request.url.path == "/api/pds/createRecord":
            body = json.loads(request.content)
            if body["collection"] == "dev.cocore.compute.attestation":
                return httpx.Response(
                    200,
                    json={
                        "uri": "at://did:plc:p/dev.cocore.compute.attestation/1",
                        "cid": "bafyattest",
                    },
                )
            if body["collection"] == "dev.cocore.compute.provider":
                provider_record_bodies.append(body["record"])
                return httpx.Response(
                    200,
                    json={
                        "uri": "at://did:plc:p/dev.cocore.compute.provider/prov1",
                        "cid": "bafyprov",
                    },
                )
            raise AssertionError(f"unexpected collection: {body['collection']}")
        raise AssertionError(f"unexpected console call: {request.url.path}")

    monkeypatch.setattr(
        "cocore_provider.cli._build_lmstudio_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = AgentConfig(
            advisor_url=f"ws://localhost:{port}/v1/agent",
            advisor_did="did:web:advisor.cocore.dev",
            api_base="https://console.example",
            api_key="key123",
            lmstudio_url="http://localhost:1234",
            identity_path=tmp_path / "identity.json",
            machine_label="test-machine",
        )
        serve_task = asyncio.create_task(serve(config, provider_did="did:plc:abc"))
        await asyncio.wait_for(registered.wait(), timeout=10)
        serve_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await serve_task

    assert seen_register["supported_models"] == []
    assert provider_record_bodies[0]["supportedModels"] == []
    assert provider_record_bodies[0]["engineFault"]["code"] == "model-load-failed"


@pytest.mark.asyncio
async def test_serve_survives_attestation_publish_failure_with_attestation_fault(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A failed attestation publish must not crash the whole agent -- it
    should register with an empty attestation_uri and surface
    `attestationFault` on the provider record."""
    registered = asyncio.Event()
    seen_register: dict[str, object] = {}
    provider_record_bodies: list[dict[str, object]] = []

    async def fake_advisor(ws: websockets.WebSocketServerProtocol) -> None:
        register = json.loads(await ws.recv())
        seen_register.update(register)
        registered.set()
        await ws.wait_closed()

    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "llama-3.1-8b"}]})

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        if request.url.path == "/xrpc/com.atproto.repo.listRecords":
            return httpx.Response(200, json={"records": []})
        if request.url.path == "/api/pds/getServiceAuth":
            return httpx.Response(200, json={"token": "jwt.abc"})
        if request.url.path == "/api/pds/createRecord":
            body = json.loads(request.content)
            if body["collection"] == "dev.cocore.compute.attestation":
                return httpx.Response(500, text="pds unavailable")
            if body["collection"] == "dev.cocore.compute.provider":
                provider_record_bodies.append(body["record"])
                return httpx.Response(
                    200,
                    json={
                        "uri": "at://did:plc:p/dev.cocore.compute.provider/prov1",
                        "cid": "bafyprov",
                    },
                )
            raise AssertionError(f"unexpected collection: {body['collection']}")
        raise AssertionError(f"unexpected console call: {request.url.path}")

    monkeypatch.setattr(
        "cocore_provider.cli._build_lmstudio_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = AgentConfig(
            advisor_url=f"ws://localhost:{port}/v1/agent",
            advisor_did="did:web:advisor.cocore.dev",
            api_base="https://console.example",
            api_key="key123",
            lmstudio_url="http://localhost:1234",
            identity_path=tmp_path / "identity.json",
            machine_label="test-machine",
        )
        serve_task = asyncio.create_task(serve(config, provider_did="did:plc:abc"))
        await asyncio.wait_for(registered.wait(), timeout=10)
        serve_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await serve_task

    assert seen_register["attestation_uri"] == ""
    assert provider_record_bodies[0]["attestationFault"]["code"] == "attestation-publish-failed"
