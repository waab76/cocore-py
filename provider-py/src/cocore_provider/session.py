"""Orchestrates one InferenceRequest end to end: decrypt, call LMStudio,
stream sealed chunks back, build+sign+publish the receipt, send
inference_complete. On a recoverable failure, mirrors
`provider/src/advisor.rs`'s convention exactly: a sealed error string as a
single content chunk, then inference_complete with zero tokens and an empty
receipt_uri (no receipt is published for a failed job)."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime

from cocore_provider import pricing
from cocore_provider.config import STREAM_KEEPALIVE_INTERVAL_SECS
from cocore_provider.crypto import open_from_requester, seal_to_requester
from cocore_provider.identity import Identity
from cocore_provider.lmstudio import LMStudioClient, LMStudioError
from cocore_provider.pds_client import PdsClient, PdsError
from cocore_provider.protocol import (
    InferenceRequestFrame,
    build_inference_chunk,
    build_inference_complete,
    build_inference_keepalive,
)
from cocore_provider.receipt import ReceiptInputs, build_receipt

logger = logging.getLogger(__name__)

Send = Callable[[dict[str, object]], Awaitable[None]]


async def _stream_keepalives(send: Send, session_id: str) -> None:
    """Ticks every STREAM_KEEPALIVE_INTERVAL_SECS while a job is in flight,
    so the advisor's session idle-timer (main.ts SessionManager) doesn't
    expire during a slow model load or a long silent generation gap.
    Mirrors provider/src/advisor.rs's STREAM_KEEPALIVE_INTERVAL ticker --
    without this, a job whose first token takes longer than the advisor's
    firstChunkTimeoutMs (120s default) is killed as `idle-timeout` even
    though the provider is still working."""
    while True:
        await asyncio.sleep(STREAM_KEEPALIVE_INTERVAL_SECS)
        await send(build_inference_keepalive(session_id=session_id))


@dataclass
class SessionContext:
    identity: Identity
    provider_did: str
    lmstudio: LMStudioClient
    pds: PdsClient
    attestation_uri: str
    attestation_cid: str


async def _send_empty_completion(send: Send, session_id: str) -> None:
    await send(
        build_inference_complete(session_id=session_id, tokens_in=0, tokens_out=0, receipt_uri="")
    )


async def run_session(req: InferenceRequestFrame, send: Send, ctx: SessionContext) -> None:
    started_at = datetime.now(UTC)

    try:
        plaintext = open_from_requester(
            base64.b64decode(req.ciphertext_b64), req.requester_pub_key, ctx.identity.encryption_key
        )
    except Exception:
        logger.warning(
            "failed to open inference ciphertext for session %s", req.session_id, exc_info=True
        )
        return  # matches the Rust provider: a hard decrypt failure drops the session silently

    input_commitment = hashlib.sha256(plaintext).hexdigest()
    prompt = plaintext.decode("utf-8", errors="replace")
    logger.info("session %s started: model=%s", req.session_id, req.model)

    output_parts: list[str] = []
    tokens_in: int | None = None
    tokens_out: int | None = None
    seq = 0

    keepalive_task = asyncio.create_task(_stream_keepalives(send, req.session_id))
    try:
        try:
            async for delta in ctx.lmstudio.stream_chat(
                model=req.model, prompt=prompt, max_tokens=req.max_tokens_out
            ):
                if delta.usage is not None:
                    tokens_in, tokens_out = delta.usage
                    continue
                if not delta.content:
                    continue
                output_parts.append(delta.content)
                framed = seal_to_requester(
                    delta.content.encode("utf-8"),
                    req.requester_pub_key,
                    ctx.identity.encryption_key,
                )
                await send(
                    build_inference_chunk(
                        session_id=req.session_id,
                        seq=seq,
                        ciphertext_b64=base64.b64encode(framed).decode("ascii"),
                    )
                )
                seq += 1
        except LMStudioError:
            logger.warning("LMStudio failure for session %s", req.session_id, exc_info=True)
            error_text = "[cocore provider] the local LMStudio backend failed to complete this job"
            framed = seal_to_requester(
                error_text.encode("utf-8"), req.requester_pub_key, ctx.identity.encryption_key
            )
            await send(
                build_inference_chunk(
                    session_id=req.session_id,
                    seq=seq,
                    ciphertext_b64=base64.b64encode(framed).decode("ascii"),
                )
            )
            await _send_empty_completion(send, req.session_id)
            return
    finally:
        keepalive_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await keepalive_task

    output_bytes = "".join(output_parts).encode("utf-8")
    output_commitment = hashlib.sha256(output_bytes).hexdigest()
    if tokens_in is None:
        tokens_in = pricing.estimate_tokens(plaintext)
    if tokens_out is None:
        tokens_out = pricing.estimate_tokens(output_bytes)

    completed_at = datetime.now(UTC)
    price_amount = pricing.price_minor(tokens_in, tokens_out)

    receipt_uri = ""
    if req.job_cid and not ctx.attestation_uri:
        # attestationFault: this serve has no attestation to strong-ref (its
        # publish failed at boot). A receipt without one is invalid per the
        # lexicon, so -- matching the Rust agent -- the job still answers,
        # it just doesn't get a receipt.
        logger.warning(
            "skipping receipt for session %s: no attestation available (attestationFault)",
            req.session_id,
        )
    elif req.job_cid:
        receipt = build_receipt(
            ctx.identity,
            ReceiptInputs(
                job_uri=req.job_uri,
                job_cid=req.job_cid,
                requester_did=req.requester_did,
                model=req.model,
                input_commitment=input_commitment,
                output_commitment=output_commitment,
                tokens_in=tokens_in,
                tokens_out=tokens_out,
                started_at=started_at,
                completed_at=completed_at,
                price_amount=price_amount,
                price_currency=pricing.UNIFORM_CURRENCY,
                attestation_uri=ctx.attestation_uri,
                attestation_cid=ctx.attestation_cid,
            ),
        )
        try:
            published = await ctx.pds.publish("dev.cocore.compute.receipt", receipt)
            receipt_uri = published.uri
        except PdsError:
            logger.warning("receipt publish failed for session %s", req.session_id, exc_info=True)

    logger.info(
        "session %s complete: tokens_in=%d tokens_out=%d receipt=%s",
        req.session_id,
        tokens_in,
        tokens_out,
        receipt_uri or "(none)",
    )
    await send(
        build_inference_complete(
            session_id=req.session_id,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
            receipt_uri=receipt_uri,
        )
    )
