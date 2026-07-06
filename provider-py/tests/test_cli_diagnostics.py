from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from cocore_provider.cli import main
from cocore_provider.identity import load_or_create


def test_doctor_command_all_checks_pass(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"id": "llama-3.1-8b"}]})

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/whoami":
            return httpx.Response(200, json={"did": "did:plc:abc", "valid": True})
        if request.url.path == "/api/agent/health":
            return httpx.Response(
                200,
                json={
                    "diagnosis": "healthy",
                    "hint": "you're good",
                    "advisor": {"online": True},
                    "pds": {
                        "providerRecord": {"uri": "at://did:plc:abc/dev.cocore.compute.provider/1"}
                    },
                },
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
    monkeypatch.setenv("COCORE_API_KEY", "key123")
    monkeypatch.setenv("COCORE_API_BASE", "https://console.example")
    monkeypatch.setenv("COCORE_IDENTITY_PATH", str(tmp_path / "identity.json"))
    config_path = tmp_path / "config.toml"
    config_path.write_text("")

    exit_code = main(["doctor", "--provider-did", "did:plc:abc", "--config", str(config_path)])
    assert exit_code == 0


def test_doctor_command_reports_failure_exit_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def lmstudio_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="connection refused")

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/agent/whoami":
            return httpx.Response(401, text="unauthorized")
        raise AssertionError(f"unexpected console call: {request.url.path}")

    monkeypatch.setattr(
        "cocore_provider.cli._build_lmstudio_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(lmstudio_handler)),
    )
    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )
    monkeypatch.setenv("COCORE_API_KEY", "key123")
    monkeypatch.setenv("COCORE_API_BASE", "https://console.example")
    monkeypatch.setenv("COCORE_IDENTITY_PATH", str(tmp_path / "identity.json"))
    config_path = tmp_path / "config.toml"
    config_path.write_text("")

    exit_code = main(["doctor", "--provider-did", "did:plc:abc", "--config", str(config_path)])
    assert exit_code == 1


def test_attestation_status_command_no_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        return httpx.Response(200, json={"records": []})

    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )
    monkeypatch.setenv("COCORE_API_KEY", "key123")
    monkeypatch.setenv("COCORE_API_BASE", "https://console.example")
    monkeypatch.setenv("COCORE_IDENTITY_PATH", str(tmp_path / "identity.json"))
    config_path = tmp_path / "config.toml"
    config_path.write_text("")

    exit_code = main(
        ["attestation-status", "--provider-did", "did:plc:abc", "--config", str(config_path)]
    )
    assert exit_code == 1


def test_attestation_status_command_valid_record(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    identity_path = tmp_path / "identity.json"
    identity = load_or_create(identity_path)
    pub_key = identity.signing_public_b64

    def console_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "plc.directory":
            return httpx.Response(
                200,
                json={
                    "service": [{"id": "#atproto_pds", "serviceEndpoint": "https://pds.example"}]
                },
            )
        collection = request.url.params.get("collection")
        if collection == "dev.cocore.compute.attestation":
            return httpx.Response(
                200,
                json={
                    "records": [
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
                },
            )
        return httpx.Response(200, json={"records": []})

    monkeypatch.setattr(
        "cocore_provider.cli._build_console_http",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(console_handler)),
    )
    monkeypatch.setenv("COCORE_API_KEY", "key123")
    monkeypatch.setenv("COCORE_API_BASE", "https://console.example")
    monkeypatch.setenv("COCORE_IDENTITY_PATH", str(identity_path))
    config_path = tmp_path / "config.toml"
    config_path.write_text("")

    exit_code = main(
        ["attestation-status", "--provider-did", "did:plc:abc", "--config", str(config_path)]
    )
    assert exit_code == 0
