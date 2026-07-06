"""Advisor WS connection: register, heartbeat, attestation-challenge
handling, and inference-job dispatch. One in-flight job at a time
(Approach A from the design spec) — matches one local LMStudio instance."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from cocore_provider.attestation import build_challenge_response
from cocore_provider.config import (
    HEARTBEAT_INTERVAL_SECS,
    AgentConfig,
)
from cocore_provider.identity import Identity
from cocore_provider.protocol import (
    InferenceRequestFrame,
    build_heartbeat,
    build_pong,
    build_register,
    frame_type,
    parse_attestation_challenge,
    parse_inference_request,
    parse_ping,
)

logger = logging.getLogger(__name__)

OnInferenceRequest = Callable[
    [InferenceRequestFrame, Callable[[dict[str, object]], Awaitable[None]]], Awaitable[None]
]

RECONNECT_BACKOFFS = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)


class AdvisorConnection:
    def __init__(
        self,
        *,
        config: AgentConfig,
        identity: Identity,
        provider_did: str,
        machine_id: str,
        mint_auth_jwt: Callable[[], Awaitable[str | None]],
        attestation_uri: str,
        supported_models: list[str] | None = None,
        ram_gb: int = 0,
    ) -> None:
        self._config = config
        self._identity = identity
        self._provider_did = provider_did
        self._machine_id = machine_id
        self._mint_auth_jwt = mint_auth_jwt
        self._attestation_uri = attestation_uri
        self._supported_models = supported_models or []
        self._ram_gb = ram_gb
        self._busy = False

    async def run(self, *, on_inference_request: OnInferenceRequest) -> None:
        backoff_idx = 0
        while True:
            try:
                await self._run_once(on_inference_request)
                backoff_idx = 0
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                # asyncio.TaskGroup.__aexit__ gives an ordinary child-task
                # error priority over a bare CancelledError: if an external
                # cancel() on *this* task races with an ordinary failure in
                # _heartbeat_loop/_receive_loop (e.g. ConnectionClosed),
                # __aexit__ can raise the child's real exception -- bare, or
                # wrapped in an
                # ExceptionGroup/BaseExceptionGroup -- instead of surfacing a
                # plain CancelledError, even though this task's own
                # cancellation request may still be outstanding. See cpython
                # Lib/asyncio/taskgroups.py:_on_task_done/_aexit: whenever a
                # child ends with an ordinary exception, TaskGroup
                # unconditionally calls .cancel() on *this* (parent) task
                # once, purely to interrupt its internal wait -- and that
                # call is only ever rebalanced by the `_parent_cancel_requested`
                # check at the very top of `_aexit`, which runs once,
                # synchronously, before any child could plausibly have
                # failed yet. So that internal cancel is never rebalanced on
                # this path, and Task.cancelling() reads > 0 after *every*
                # single-child TaskGroup failure -- not just a genuine
                # external cancellation. Rebalance that one expected internal
                # cancel ourselves; whatever remains is a real external
                # cancel() our caller issued, which we treat as "stop", not
                # "reconnect".
                current_task = asyncio.current_task()
                if current_task is not None:
                    current_task.uncancel()
                    if current_task.cancelling() > 0:
                        raise asyncio.CancelledError() from exc
                logger.exception("advisor connection dropped; reconnecting")
            delay = RECONNECT_BACKOFFS[min(backoff_idx, len(RECONNECT_BACKOFFS) - 1)]
            backoff_idx += 1
            logger.info("reconnecting to advisor in %.0fs", delay)
            await asyncio.sleep(delay)

    async def _run_once(self, on_inference_request: OnInferenceRequest) -> None:
        async with websockets.connect(self._config.advisor_url) as ws:
            auth_jwt = await self._mint_auth_jwt()
            register = build_register(
                provider_did=self._provider_did,
                machine_id=self._machine_id,
                machine_label=self._config.machine_label,
                chip=f"lmstudio:{_platform_name()}",
                ram_gb=self._ram_gb,
                supported_models=self._supported_models,
                encryption_pub_key=self._identity.encryption_public_b64,
                attestation_pub_key=self._identity.signing_public_b64,
                attestation_uri=self._attestation_uri,
                tier="best-effort",
                auth_jwt=auth_jwt,
            )
            await ws.send(_dumps(register))
            logger.info("registered with advisor at %s", self._config.advisor_url)

            async def send(frame: dict[str, object]) -> None:
                await ws.send(_dumps(frame))

            async with asyncio.TaskGroup() as tg:
                tg.create_task(self._heartbeat_loop(send))
                tg.create_task(self._receive_loop(ws, send, on_inference_request))

    async def _heartbeat_loop(self, send: Callable[[dict[str, object]], Awaitable[None]]) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECS)
            logger.debug("sending heartbeat (busy=%s)", self._busy)
            await send(
                build_heartbeat(load=1.0 if self._busy else 0.0, queue_depth=int(self._busy))
            )

    async def _receive_loop(
        self,
        ws: ClientConnection,
        send: Callable[[dict[str, object]], Awaitable[None]],
        on_inference_request: OnInferenceRequest,
    ) -> None:
        while True:
            # No app-level idle timeout here: `websockets.connect()`'s default
            # ping_interval=20/ping_timeout=20 already probes the actual
            # connection and raises ConnectionClosedError within ~40s if the
            # link is genuinely dead (handled below via the ordinary
            # reconnect-on-Exception path). The advisor otherwise stays quiet
            # for extended periods with no job in flight (its own WS-level
            # keepalive ping isn't visible here -- `recv()` only yields data
            # frames, not control frames -- but it doesn't need to be: the
            # client's own keepalive already proves the link is alive).
            raw = await ws.recv()
            msg: dict[str, Any] = _loads(raw)
            msg_type = frame_type(msg)

            if msg_type == "attestation_challenge":
                logger.debug("responding to attestation_challenge")
                challenge = parse_attestation_challenge(msg)
                response = build_challenge_response(self._identity, challenge)
                await send(
                    {**response, "type": "attestation_response", "timestamp": challenge.timestamp}
                )
            elif msg_type == "ping":
                ping = parse_ping(msg)
                await send(build_pong(nonce=ping.nonce))
            elif msg_type == "inference_request":
                if self._busy:
                    logger.warning("dropping inference_request while a job is already in flight")
                    continue
                req = parse_inference_request(msg)
                logger.info(
                    "dispatching inference_request session=%s model=%s", req.session_id, req.model
                )
                self._busy = True

                async def run_job(req: InferenceRequestFrame = req) -> None:
                    try:
                        await on_inference_request(req, send)
                    finally:
                        self._busy = False

                asyncio.create_task(run_job())
            else:
                logger.debug("ignoring unhandled frame type %r", msg_type)


def _platform_name() -> str:
    import platform

    return platform.system().lower()


def _dumps(frame: dict[str, object]) -> str:
    import json

    return json.dumps(frame)


def _loads(raw: str | bytes) -> dict[str, Any]:
    import json

    return dict(json.loads(raw))
