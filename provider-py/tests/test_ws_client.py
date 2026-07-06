# provider-py/tests/test_ws_client.py
from __future__ import annotations

import asyncio
import json

import httpx
import pytest
import websockets
from cryptography.hazmat.primitives.asymmetric import ec
from nacl.public import PrivateKey

import cocore_provider.ws_client as ws_client_module
from cocore_provider.config import AgentConfig
from cocore_provider.identity import Identity
from cocore_provider.pds_client import PdsClient
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


def _never_stopped_pds() -> PdsClient:
    """A PdsClient whose reads always fail cleanly (a plain non-200, not a
    raised exception) so `get_provider_active` falls back to `None` ->
    `_is_active()` treats the machine as active. Used by tests that don't
    care about the owner-stop feature, so they behave exactly as before it
    existed."""
    return PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404))),
        did="did:plc:abc",
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
        assert first["attestation_uri"] == "at://did:plc:abc/dev.cocore.compute.attestation/1"
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
            machine_id="m1",
            pds=_never_stopped_pds(),
            mint_auth_jwt=lambda: _async_none(),
            attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
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


# Number of bare `await asyncio.sleep(0)` event-loop turns to let elapse
# between aborting the connection and calling `.cancel()` on the task
# running `conn.run()` in the regression test below. See that test's
# docstring for exactly what this is tuned to hit and why.
_RACE_YIELD_COUNT = 5


@pytest.mark.asyncio
async def test_run_propagates_cancellation_when_connection_drop_races_with_cancel() -> None:
    """Regression test for the race between an external `.cancel()` on the
    task running `AdvisorConnection.run()` and an ordinary connection
    failure inside `_receive_loop` (`ConnectionClosed`, or -- in production --
    the `wait_for` idle-timeout firing).

    Mechanism: `asyncio.TaskGroup.__aexit__` (see cpython
    `Lib/asyncio/taskgroups.py:_aexit`) gives an ordinary child-task error
    priority over a bare `CancelledError`. When a genuine external cancel()
    on the parent task (the task running `run()`) and an ordinary failure in
    a child task (`_heartbeat_loop`/`_receive_loop`) are *both* still being
    processed when `__aexit__` finishes unwinding the group, `__aexit__`
    raises the child's real exception -- wrapped in an `ExceptionGroup` --
    instead of a bare `CancelledError`, even though the parent task's own
    cancellation request is still outstanding (`Task.cancelling() > 0`).
    That's because TaskGroup only ever rebalances, via `uncancel()`, the one
    cancel-to-interrupt-the-wait call *it* makes internally when a child
    fails; it never rebalances a genuine external cancel(), so that debt
    survives. Before the fix, `run()`'s `except Exception:` handler had no
    way to tell the two situations apart: it logged "reconnecting" and
    looped back into `_run_once`, ignoring the pending cancellation -- a
    shutdown signal racing a connection drop would not stop the provider
    promptly (this matches the empirically-observed "5+ reconnect attempts
    against an already-dead server before a hard kill was needed").

    Forcing the exact race deterministically isn't practical (it hinges on
    which of two independently-scheduled asyncio callbacks -- the child
    task's done-callback vs. the future our cancel() targets -- the event
    loop happens to process first), so this test gets as close as
    practically possible and was tuned empirically against this exact
    module:

    1. Abort the server-side transport *synchronously* (`transport.abort()`,
       no clean WS close handshake) so `_receive_loop`'s `ws.recv()` fails
       with an ordinary `ConnectionClosedError` rather than being pre-empted
       by our own cancellation.
    2. Let exactly `_RACE_YIELD_COUNT` bare event-loop turns
       (`await asyncio.sleep(0)`) elapse. This is the window between "the
       child task's failure has been recorded" and "TaskGroup has fully
       unwound" -- too few turns and our external cancel() still wins the
       race outright (receive_loop gets pre-emptively cancelled before its
       real exception is recorded, `TaskGroup` raises a bare
       `CancelledError`, and the bug never had a chance to trigger); too
       many and `_run_once` has already returned/raised by the time we
       cancel, which is just an ordinary "cancelled during backoff sleep"
       and also doesn't exercise the bug.
    3. Call `run_task.cancel()` while the TaskGroup is inside that window.

    Verified locally by temporarily reverting just the `run()` fix (keeping
    this test as-is): with `_RACE_YIELD_COUNT` in a broad range (empirically
    3-9 turns on this module/Python/websockets version), the test reliably
    failed -- `run()` swallowed an `ExceptionGroup` wrapping
    `ConnectionClosedError` while `Task.cancelling() > 0`, logged
    "reconnecting", slept out the first backoff, attempted (and failed) a
    real reconnect against the aborted server, and the test's
    `asyncio.wait_for(run_task, timeout=5)` timed out instead of observing a
    `CancelledError`. With the fix restored, the same range of turn counts
    reliably passes. `_RACE_YIELD_COUNT = 5` sits in the middle of that
    empirically-confirmed window.
    """
    registered = asyncio.Event()
    server_conns: list[websockets.ServerConnection] = []

    async def fake_advisor(ws: websockets.ServerConnection) -> None:
        first = json.loads(await ws.recv())
        assert first["type"] == "register"
        server_conns.append(ws)
        registered.set()
        # Tie this handler's lifetime to the connection itself (rather than
        # e.g. sleeping) so that once the test aborts the transport below,
        # the handler -- and thus `websockets.serve`'s teardown -- unwinds
        # promptly instead of leaking a task.
        await ws.wait_closed()

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = _config(f"ws://localhost:{port}/v1/agent")
        conn = AdvisorConnection(
            config=config,
            identity=_identity(),
            provider_did="did:plc:abc",
            machine_id="m1",
            pds=_never_stopped_pds(),
            mint_auth_jwt=lambda: _async_none(),
            attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        )

        async def on_request(req: object, send: object) -> None:
            return None

        run_task = asyncio.create_task(conn.run(on_inference_request=on_request))
        await asyncio.wait_for(registered.wait(), timeout=5)

        server_conns[0].transport.abort()
        for _ in range(_RACE_YIELD_COUNT):
            await asyncio.sleep(0)
        run_task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(run_task, timeout=5)


@pytest.mark.asyncio
async def test_run_reconnects_after_ordinary_failure_without_external_cancel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression test for a false positive in the external-cancel check added
    by 611e416: `asyncio.TaskGroup` unconditionally issues one `.cancel()`
    against its parent task to interrupt the wait whenever a child task ends
    with an ordinary (non-cancelled) exception -- e.g. `_receive_loop`
    getting an ordinary `ConnectionClosedError` while `_heartbeat_loop` is
    still asleep -- and, in that path, never rebalances it with `uncancel()`
    because `_parent_cancel_requested` is only inspected once, synchronously,
    at the very start of `TaskGroup._aexit` (before any child could
    plausibly have failed). So `Task.cancelling() > 0` is true after *every*
    single-child TaskGroup failure, not just genuine external cancellation,
    and `run()` misread that as "an external cancel is racing this failure,
    propagate CancelledError and stop" for a perfectly ordinary,
    reconnect-worthy connection drop -- crashing the whole provider instead
    of reconnecting.

    No task's `.cancel()` is ever called here by the test itself, so if
    `run()` still exits instead of looping back into `_run_once`, the bug
    has regressed.
    """
    monkeypatch.setattr(ws_client_module, "HEARTBEAT_INTERVAL_SECS", 10.0)

    connect_count = 0
    reconnected = asyncio.Event()
    server_conns: list[websockets.ServerConnection] = []

    async def fake_advisor(ws: websockets.ServerConnection) -> None:
        nonlocal connect_count
        first = json.loads(await ws.recv())
        assert first["type"] == "register"
        connect_count += 1
        if connect_count == 1:
            # Kill the transport synchronously (no clean close handshake) so
            # _receive_loop's next `ws.recv()` fails with an ordinary
            # ConnectionClosedError -- the case this test is about -- rather
            # than the loop just idling.
            server_conns.append(ws)
            ws.transport.abort()
            return
        reconnected.set()
        await ws.wait_closed()

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = _config(f"ws://localhost:{port}/v1/agent")
        conn = AdvisorConnection(
            config=config,
            identity=_identity(),
            provider_did="did:plc:abc",
            machine_id="m1",
            pds=_never_stopped_pds(),
            mint_auth_jwt=lambda: _async_none(),
            attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        )

        async def on_request(req: object, send: object) -> None:
            return None

        run_task = asyncio.create_task(conn.run(on_inference_request=on_request))
        try:
            # Generous timeout: establishing a fresh loopback connection on
            # this platform is occasionally slow (~2s) for reasons unrelated
            # to what this test is checking; the assertion is that it
            # reconnects at all, not how fast.
            await asyncio.wait_for(reconnected.wait(), timeout=15)
            assert not run_task.done()
        finally:
            run_task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await run_task


def _stopped_pds() -> PdsClient:
    """A PdsClient reporting `active: False` for the one provider record it
    knows about, unconditionally."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        return httpx.Response(
            200,
            json={
                "records": [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/m1",
                        "cid": "bafy",
                        "value": {"active": False},
                    }
                ]
            },
        )

    return PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )


@pytest.mark.asyncio
async def test_run_gates_on_owner_stopped_before_connecting() -> None:
    connected = asyncio.Event()

    async def fake_advisor(ws: websockets.ServerConnection) -> None:
        connected.set()
        await ws.wait_closed()

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = _config(f"ws://localhost:{port}/v1/agent")
        conn = AdvisorConnection(
            config=config,
            identity=_identity(),
            provider_did="did:plc:abc",
            machine_id="m1",
            pds=_stopped_pds(),
            mint_auth_jwt=lambda: _async_none(),
            attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        )

        async def on_request(req: object, send: object) -> None:
            return None

        run_task = asyncio.create_task(conn.run(on_inference_request=on_request))
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(connected.wait(), timeout=0.3)
        assert not run_task.done()
        run_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run_task


@pytest.mark.asyncio
async def test_run_disconnects_when_owner_stops_mid_connection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ws_client_module, "ACTIVE_POLL_INTERVAL_SECS", 0.05)
    monkeypatch.setattr(ws_client_module, "HEARTBEAT_INTERVAL_SECS", 10.0)

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
        # Active on the very first read (the pre-connect gate), stopped on
        # every read after (the in-connection poll).
        active = calls <= 1
        return httpx.Response(
            200,
            json={
                "records": [
                    {
                        "uri": "at://did:plc:abc/dev.cocore.compute.provider/m1",
                        "cid": "bafy",
                        "value": {"active": active},
                    }
                ]
            },
        )

    pds = PdsClient(
        api_base="https://console.example",
        api_key="key123",
        http=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        did="did:plc:abc",
    )

    disconnected = asyncio.Event()

    async def fake_advisor(ws: websockets.ServerConnection) -> None:
        first = json.loads(await ws.recv())
        assert first["type"] == "register"
        try:
            await ws.wait_closed()
        finally:
            disconnected.set()

    async with websockets.serve(fake_advisor, "localhost", 0) as server:
        port = server.sockets[0].getsockname()[1]  # type: ignore[union-attr,index]
        config = _config(f"ws://localhost:{port}/v1/agent")
        conn = AdvisorConnection(
            config=config,
            identity=_identity(),
            provider_did="did:plc:abc",
            machine_id="m1",
            pds=pds,
            mint_auth_jwt=lambda: _async_none(),
            attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        )

        async def on_request(req: object, send: object) -> None:
            return None

        run_task = asyncio.create_task(conn.run(on_inference_request=on_request))
        await asyncio.wait_for(disconnected.wait(), timeout=5)
        # run() must not have exited/crashed -- it should have looped back
        # into the owner-stopped gate and be sleeping there.
        await asyncio.sleep(0.1)
        assert not run_task.done()
        run_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await run_task


async def _async_none() -> None:
    return None
