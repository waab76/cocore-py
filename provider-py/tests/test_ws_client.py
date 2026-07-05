# provider-py/tests/test_ws_client.py
from __future__ import annotations

import asyncio
import json

import pytest
import websockets
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey

from cocore_provider.config import AgentConfig
from cocore_provider.identity import Identity
from cocore_provider.ws_client import AdvisorConnection


def _config(url: str) -> AgentConfig:
    from pathlib import Path

    return AgentConfig(
        advisor_url=url,
        advisor_did="did:web:advisor.cocore.dev",
        api_base="https://console.example",
        api_key="key123",
        lmstudio_url="http://localhost:1234",
        identity_path=Path("/tmp/unused-identity.json"),
        machine_label="test-machine",
    )


def _identity() -> Identity:
    return Identity(
        signing_key=ec.generate_private_key(ec.SECP256R1()),
        encryption_key=PrivateKey.generate(),
    )


@pytest.mark.asyncio
async def test_register_then_inference_dispatch_calls_callback() -> None:
    received_register = asyncio.Event()
    dispatched = asyncio.Event()
    seen_model: list[str] = []

    async def fake_advisor(ws: websockets.WebSocketServerProtocol) -> None:
        first = json.loads(await ws.recv())
        assert first["type"] == "register"
        assert first["provider_did"] == "did:plc:abc"
        received_register.set()

        await ws.send(
            json.dumps(
                {
                    "type": "inference_request",
                    "job_uri": "at://did:plc:r/dev.cocore.compute.job/1",
                    "job_cid": "bafyjob",
                    "requester_did": "did:plc:r",
                    "requester_pub_key": "rpk==",
                    "model": "llama-3.1-8b",
                    "max_tokens_out": 16,
                    "ciphertext": "Y2lwaGVy",
                    "session_id": "s1",
                }
            )
        )
        await dispatched.wait()

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = _config(f"ws://localhost:{port}/v1/agent")
        conn = AdvisorConnection(
            config=config,
            identity=_identity(),
            provider_did="did:plc:abc",
            mint_auth_jwt=lambda: _async_none(),
        )

        async def on_request(req: object, send: object) -> None:
            seen_model.append(req.model)  # type: ignore[attr-defined]
            dispatched.set()

        run_task = asyncio.create_task(conn.run(on_inference_request=on_request))
        await asyncio.wait_for(received_register.wait(), timeout=5)
        await asyncio.wait_for(dispatched.wait(), timeout=5)
        run_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run_task

    assert seen_model == ["llama-3.1-8b"]


async def _async_none() -> None:
    return None
