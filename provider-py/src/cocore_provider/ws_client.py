"""Advisor WS connection: register, heartbeat, attestation-challenge
handling, and inference-job dispatch. One in-flight job at a time
(Approach A from the design spec) — matches one local LMStudio instance."""

from __future__ import annotations

import asyncio
import logging
import socket
import ssl
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
from websockets.asyncio.client import ClientConnection

from cocore_provider import __version__
from cocore_provider.attestation import build_challenge_response
from cocore_provider.config import (
    ACTIVE_POLL_INTERVAL_SECS,
    ADVISOR_FAULT_THRESHOLD,
    HEARTBEAT_INTERVAL_SECS,
    AgentConfig,
)
from cocore_provider.identity import Identity
from cocore_provider.lmstudio import LMStudioClient, LMStudioError
from cocore_provider.pds_client import PdsClient, PdsError
from cocore_provider.protocol import (
    InferenceRequestFrame,
    build_heartbeat,
    build_pong,
    build_recover_result,
    build_register,
    frame_type,
    parse_attestation_challenge,
    parse_control_changed,
    parse_health_notice,
    parse_inference_request,
    parse_ping,
    parse_recover_request,
)
from cocore_provider.provider_record import (
    build_advisor_fault,
    models_changed,
    patch_provider_fault,
)

logger = logging.getLogger(__name__)

OnInferenceRequest = Callable[
    [InferenceRequestFrame, Callable[[dict[str, object]], Awaitable[None]]], Awaitable[None]
]

RECONNECT_BACKOFFS = (1.0, 2.0, 4.0, 8.0, 16.0, 30.0)


class _AdvisorConnectError(Exception):
    """Raised when `websockets.connect()` itself failed to establish the
    connection at all -- distinct from an ordinary drop after a successful
    connect+register. `run()` catches this by name to drive the
    `advisorFault` threshold/classification; anything else lands in the
    generic reconnect path unchanged."""

    def __init__(self, cause: BaseException) -> None:
        super().__init__(str(cause))
        self.cause = cause


def _classify_connect_error(exc: BaseException) -> str:
    """Best-effort classification of a connect failure into one of the
    lexicon's known `advisorFault` codes. Mirrors the code list documented on
    `dev.cocore.compute.provider#advisorFault`; an unrecognized shape falls
    back to `network-unreachable` rather than guessing -- the lexicon
    requires consumers to treat an unknown code as generic anyway."""
    if isinstance(exc, TimeoutError):
        return "connect-timeout"
    if isinstance(exc, ConnectionRefusedError):
        return "connect-refused"
    if isinstance(exc, socket.gaierror):
        return "dns-failure"
    if isinstance(exc, ssl.SSLError):
        return "tls-failure"
    status = getattr(exc, "status_code", None)
    if status is None:
        response = getattr(exc, "response", None)
        status = getattr(response, "status_code", None)
    if isinstance(status, int):
        return f"http-{status}"
    close_code = getattr(exc, "code", None)
    if isinstance(close_code, int):
        return f"closed-{close_code}"
    return "network-unreachable"


class AdvisorConnection:
    def __init__(
        self,
        *,
        config: AgentConfig,
        identity: Identity,
        provider_did: str,
        machine_id: str,
        pds: PdsClient,
        mint_auth_jwt: Callable[[], Awaitable[str | None]],
        attestation_uri: str,
        supported_models: list[str] | None = None,
        ram_gb: int = 0,
        lmstudio: LMStudioClient | None = None,
    ) -> None:
        self._config = config
        self._identity = identity
        self._provider_did = provider_did
        self._machine_id = machine_id
        self._pds = pds
        self._mint_auth_jwt = mint_auth_jwt
        self._attestation_uri = attestation_uri
        self._supported_models = supported_models or []
        self._ram_gb = ram_gb
        # Used only to answer a `recover_request` with a real reachability
        # check. `None` (test callers, or a caller that doesn't care) means
        # recover_request is simply ignored rather than answered with a
        # guessed result.
        self._lmstudio = lmstudio
        self._busy = False
        # The owner's start/stop switch, last read from our own PDS record.
        # Reported in every heartbeat and re-checked every
        # ACTIVE_POLL_INTERVAL_SECS by `_active_poll_loop` -- or immediately,
        # off-cycle, when a `control_changed` nudge sets `_recheck_active`.
        # Absent/unreadable == serving (the lexicon default), so this starts
        # True.
        self._active = True
        self._recheck_active = asyncio.Event()
        # True once an `advisorFault` has actually been published (i.e. the
        # consecutive-connect-failure streak crossed ADVISOR_FAULT_THRESHOLD),
        # so a successful reconnect only bothers clearing it when there's
        # something to clear.
        self._advisor_fault_published = False
        # Last `desiredModels` seen from the PDS record, so
        # `_check_desired_models` logs on a CHANGE (the owner editing their
        # pick) rather than once per poll tick for as long as it stays
        # mismatched. `None` means "never read one yet".
        self._last_desired_models: list[str] | None = None

    async def _is_active(self) -> bool:
        active = await self._pds.get_provider_active(self._machine_id)
        return True if active is None else active

    async def _check_desired_models(self) -> None:
        """Diagnostic-only counterpart to the Rust agent's `desiredModels`
        reconciliation (`provider/src/advisor.rs`'s `models_changed` check):
        Rust actually reloads its engines to match the owner's console pick.
        provider-py has no lever to load/unload a model in LMStudio, so this
        only logs when the console's pick changes and doesn't match what
        LMStudio is actually serving -- visibility instead of a silent
        no-op, not a fix."""
        desired = await self._pds.get_provider_desired_models(self._machine_id)
        if desired is None or desired == self._last_desired_models:
            return
        self._last_desired_models = desired
        if models_changed(desired, self._supported_models):
            logger.warning(
                "console desiredModels %s does not match what LMStudio is actually "
                "serving %s -- provider-py cannot load/unload LMStudio models; "
                "load the requested model(s) in LMStudio manually",
                desired,
                self._supported_models,
            )

    async def run(self, *, on_inference_request: OnInferenceRequest) -> None:
        backoff_idx = 0
        # Consecutive CONNECT failures -- the WS never came up at all. An
        # ordinary drop after a successful connect (the `except Exception`
        # branch below) resets this to 0, matching
        # `provider/src/main.rs::AdvisorFaultTracker`'s "cleared on the next
        # successful registration" contract.
        consecutive_connect_failures = 0
        while True:
            if not await self._is_active():
                logger.info(
                    "owner has this machine stopped; waiting to be re-enabled from the console"
                )
                await asyncio.sleep(ACTIVE_POLL_INTERVAL_SECS)
                continue
            try:
                await self._run_once(on_inference_request)
                backoff_idx = 0
                consecutive_connect_failures = 0
            except _AdvisorConnectError as e:
                consecutive_connect_failures += 1
                logger.warning(
                    "failed to connect to advisor (%d consecutive): %s",
                    consecutive_connect_failures,
                    e.cause,
                )
                if consecutive_connect_failures >= ADVISOR_FAULT_THRESHOLD:
                    await self._report_advisor_fault(e.cause)
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
                # This attempt's WS DID come up (registration succeeded) and
                # then dropped for an ordinary reason -- not a connect
                # failure. Clear any standing streak/fault from earlier.
                consecutive_connect_failures = 0
                await self._clear_advisor_fault()
            delay = RECONNECT_BACKOFFS[min(backoff_idx, len(RECONNECT_BACKOFFS) - 1)]
            backoff_idx += 1
            logger.info("reconnecting to advisor in %.0fs", delay)
            await asyncio.sleep(delay)

    async def _run_once(self, on_inference_request: OnInferenceRequest) -> None:
        try:
            ws = await websockets.connect(self._config.advisor_url)
        except Exception as e:
            # Anything raised establishing the connection itself (DNS, TLS,
            # refused, timeout, a non-101 upgrade response) -- distinct from
            # a failure after we're connected, which is everything below.
            raise _AdvisorConnectError(e) from e
        try:
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
                binary_version=__version__,
            )
            await ws.send(_dumps(register))
            logger.info("registered with advisor at %s", self._config.advisor_url)

            async def send(frame: dict[str, object]) -> None:
                await ws.send(_dumps(frame))

            async with asyncio.TaskGroup() as tg:
                tg.create_task(self._heartbeat_loop(send))
                tg.create_task(self._receive_loop(ws, send, on_inference_request))
                tg.create_task(self._active_poll_loop(ws))
        finally:
            await ws.close()

    async def _report_advisor_fault(self, cause: BaseException) -> None:
        """Publish `advisorFault` after ADVISOR_FAULT_THRESHOLD consecutive
        connect failures -- the remote diagnosability for "serving locally,
        invisible on the network" (LMStudio and PDS writes still work over
        plain HTTPS; only the advisor WebSocket is blocked). Mirrors
        `provider/src/main.rs::AdvisorFaultTracker`."""
        code = _classify_connect_error(cause)
        fault = build_advisor_fault(code=code, message=f"advisor connect failed: {cause}")
        try:
            published = await patch_provider_fault(
                self._pds, self._identity.signing_public_b64, "advisorFault", fault
            )
            if published:
                self._advisor_fault_published = True
                logger.error("published advisorFault (%s) on provider record", code)
        except PdsError:
            logger.warning("failed to publish advisorFault", exc_info=True)

    async def _clear_advisor_fault(self) -> None:
        if not self._advisor_fault_published:
            return
        try:
            await patch_provider_fault(
                self._pds, self._identity.signing_public_b64, "advisorFault", None
            )
            self._advisor_fault_published = False
            logger.info("cleared advisorFault on provider record after successful registration")
        except PdsError:
            logger.warning("failed to clear advisorFault", exc_info=True)

    async def _heartbeat_loop(self, send: Callable[[dict[str, object]], Awaitable[None]]) -> None:
        while True:
            await asyncio.sleep(HEARTBEAT_INTERVAL_SECS)
            logger.debug("sending heartbeat (busy=%s, active=%s)", self._busy, self._active)
            await send(
                build_heartbeat(
                    load=1.0 if self._busy else 0.0,
                    queue_depth=int(self._busy),
                    active=self._active,
                )
            )

    async def _active_poll_loop(self, ws: ClientConnection) -> None:
        """Re-reads the owner's PDS active switch every
        ACTIVE_POLL_INTERVAL_SECS -- or immediately when `_receive_loop` sets
        `_recheck_active` on a `control_changed` nudge, the fast path mirroring
        provider/src/advisor.rs's dual poll+nudge design. Closing our own end
        of the socket -- rather than raising some bespoke signal -- lets an
        owner-stop reuse the exact same, already-tested
        disconnect/backoff/reconnect path as an ordinary network drop;
        `run()`'s gate at the top of its loop is what actually holds us out
        of the registry afterward instead of immediately reconnecting."""
        while True:
            try:
                await asyncio.wait_for(
                    self._recheck_active.wait(), timeout=ACTIVE_POLL_INTERVAL_SECS
                )
            except TimeoutError:
                pass
            self._recheck_active.clear()
            self._active = await self._is_active()
            if not self._active:
                logger.info("owner stopped this machine from the console; disconnecting")
                await ws.close(code=1000, reason="owner-stopped")
                return
            await self._check_desired_models()

    async def _handle_recover_request(
        self, send: Callable[[dict[str, object]], Awaitable[None]]
    ) -> None:
        """Answer a `recover_request` with a real LMStudio reachability check
        (there's no supervised engine subprocess to restart here, unlike the
        Rust agent's bounded-restart self-right). Reporting `recovered: True`
        lets the advisor clear this machine's unhealthy standing immediately
        (`connection.ts`'s `recover_result` handler) instead of waiting for
        the next re-probe sweep."""
        if self._lmstudio is None:
            return
        try:
            models = await self._lmstudio.list_models()
            recovered = len(models) > 0
            detail = None if recovered else "LMStudio reported no loaded models"
        except LMStudioError as e:
            recovered = False
            detail = f"LMStudio unreachable: {e}"
        await send(build_recover_result(recovered=recovered, detail=detail))

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
            elif msg_type == "control_changed":
                control = parse_control_changed(msg)
                logger.info(
                    "advisor nudged control_changed (reason=%s); re-checking active switch now",
                    control.reason,
                )
                self._recheck_active.set()
            elif msg_type == "recover_request":
                recover = parse_recover_request(msg)
                logger.info("advisor requested recovery (reason=%s)", recover.reason)
                asyncio.create_task(self._handle_recover_request(send))
            elif msg_type == "health_notice":
                notice = parse_health_notice(msg)
                if notice.standing == "bad":
                    logger.warning(
                        "advisor marked this machine unhealthy: %s",
                        notice.reason or "(no reason given)",
                    )
                else:
                    logger.info("advisor cleared this machine's unhealthy standing")
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
