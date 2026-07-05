from __future__ import annotations

import base64

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import Box, PrivateKey, PublicKey

from cocore_provider.crypto import open_from_requester
from cocore_provider.identity import Identity
from cocore_provider.lmstudio import LMStudioClient
from cocore_provider.pds_client import PdsClient
from cocore_provider.protocol import InferenceRequestFrame
from cocore_provider.session import SessionContext, run_session


def _identity() -> Identity:
    return Identity(
        signing_key=ec.generate_private_key(ec.SECP256R1()),
        encryption_key=PrivateKey.generate(),
    )


def _seal(plaintext: bytes, provider_pub: PublicKey, requester_priv: PrivateKey) -> bytes:
    from nacl.utils import random as nacl_random

    box = Box(requester_priv, provider_pub)
    nonce = nacl_random(Box.NONCE_SIZE)
    return nonce + box.encrypt(plaintext, nonce).ciphertext


@pytest.mark.asyncio
async def test_run_session_happy_path_streams_and_publishes_receipt() -> None:
    identity = _identity()
    requester_priv = PrivateKey.generate()
    requester_pub_b64 = base64.b64encode(bytes(requester_priv.public_key)).decode("ascii")

    ciphertext = _seal(b"say hi", identity.encryption_key.public_key, requester_priv)
    req = InferenceRequestFrame(
        job_uri="at://did:plc:r/dev.cocore.compute.job/1",
        job_cid="bafyjob",
        requester_did="did:plc:r",
        requester_pub_key=requester_pub_b64,
        model="llama-3.1-8b",
        max_tokens_out=64,
        ciphertext_b64=base64.b64encode(ciphertext).decode("ascii"),
        session_id="s1",
    )

    sse_body = (
        'data: {"choices":[{"delta":{"content":"Hi!"},"finish_reason":"stop"}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )

    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=sse_body, headers={"content-type": "text/event-stream"})

    def pds_handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/pds/createRecord"
        return httpx.Response(
            200, json={"uri": "at://did:plc:p/dev.cocore.compute.receipt/1", "cid": "bafyrec"}
        )

    lmstudio = LMStudioClient(
        base_url="http://localhost:1234",
        http=httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(pds_handler)),
    )
    ctx = SessionContext(
        identity=identity,
        provider_did="did:plc:p",
        lmstudio=lmstudio,
        pds=pds,
        attestation_uri="at://did:plc:p/dev.cocore.compute.attestation/1",
        attestation_cid="bafyatt",
    )

    sent: list[dict[str, object]] = []

    async def send(frame: dict[str, object]) -> None:
        sent.append(frame)

    await run_session(req, send, ctx)

    chunk_frames = [f for f in sent if f["type"] == "inference_chunk"]
    complete_frames = [f for f in sent if f["type"] == "inference_complete"]
    assert len(complete_frames) == 1
    complete = complete_frames[0]
    assert complete["receipt_uri"] == "at://did:plc:p/dev.cocore.compute.receipt/1"
    assert complete["tokens_in"] == 3
    assert complete["tokens_out"] == 2

    # decrypt every chunk and confirm the plaintext reconstructs the reply
    plaintext = b"".join(
        open_from_requester(
            base64.b64decode(f["ciphertext"]),  # type: ignore[arg-type]
            identity.encryption_public_b64,
            requester_priv,
        )
        for f in chunk_frames
    )
    assert plaintext == b"Hi!"


@pytest.mark.asyncio
async def test_run_session_lmstudio_failure_sends_error_chunk_and_empty_receipt() -> None:
    identity = _identity()
    requester_priv = PrivateKey.generate()
    requester_pub_b64 = base64.b64encode(bytes(requester_priv.public_key)).decode("ascii")
    ciphertext = _seal(b"say hi", identity.encryption_key.public_key, requester_priv)
    req = InferenceRequestFrame(
        job_uri="at://did:plc:r/dev.cocore.compute.job/1",
        job_cid="bafyjob",
        requester_did="did:plc:r",
        requester_pub_key=requester_pub_b64,
        model="llama-3.1-8b",
        max_tokens_out=64,
        ciphertext_b64=base64.b64encode(ciphertext).decode("ascii"),
        session_id="s1",
    )

    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="model crashed")

    def pds_handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("must not publish a receipt on a failed job")

    lmstudio = LMStudioClient(
        base_url="http://localhost:1234",
        http=httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(pds_handler)),
    )
    ctx = SessionContext(
        identity=identity,
        provider_did="did:plc:p",
        lmstudio=lmstudio,
        pds=pds,
        attestation_uri="at://did:plc:p/dev.cocore.compute.attestation/1",
        attestation_cid="bafyatt",
    )

    sent: list[dict[str, object]] = []

    async def send(frame: dict[str, object]) -> None:
        sent.append(frame)

    await run_session(req, send, ctx)

    chunk_frames = [f for f in sent if f["type"] == "inference_chunk"]
    complete_frames = [f for f in sent if f["type"] == "inference_complete"]
    assert len(chunk_frames) == 1  # the sealed error message
    assert complete_frames == [
        {
            "type": "inference_complete",
            "session_id": "s1",
            "tokens_in": 0,
            "tokens_out": 0,
            "receipt_uri": "",
        }
    ]
