from __future__ import annotations

from pathlib import Path

import pytest

from cocore_provider.config import ConfigError, load_config


def test_defaults_when_only_required_vars_set() -> None:
    env = {"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"}
    config = load_config(env)
    assert config.advisor_url == "wss://advisor.cocore.dev/v1/agent"
    assert config.advisor_did == "did:web:advisor.cocore.dev"
    assert config.lmstudio_url == "http://localhost:1234"
    assert config.api_key == "key123"
    assert config.api_base == "https://console.example"
    assert config.identity_path == Path.home() / ".cocore" / "provider-py" / "identity.json"


def test_overrides_are_honored() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_ADVISOR": "wss://custom.example/v1/agent",
        "COCORE_ADVISOR_DID": "did:web:custom.example",
        "COCORE_LMSTUDIO_URL": "http://localhost:9999",
        "COCORE_MACHINE_LABEL": "my-gaming-pc",
    }
    config = load_config(env)
    assert config.advisor_url == "wss://custom.example/v1/agent"
    assert config.advisor_did == "did:web:custom.example"
    assert config.lmstudio_url == "http://localhost:9999"
    assert config.machine_label == "my-gaming-pc"


def test_missing_required_var_raises_config_error() -> None:
    with pytest.raises(ConfigError, match="COCORE_API_KEY"):
        load_config({"COCORE_API_BASE": "https://console.example"})


def test_insecure_advisor_url_rejected_without_escape_hatch() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_ADVISOR": "ws://localhost:8080/v1/agent",
    }
    with pytest.raises(ConfigError, match="insecure"):
        load_config(env)


def test_insecure_advisor_url_allowed_with_escape_hatch() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_ADVISOR": "ws://localhost:8080/v1/agent",
        "COCORE_ALLOW_INSECURE_ADVISOR": "1",
    }
    config = load_config(env)
    assert config.advisor_url == "ws://localhost:8080/v1/agent"
