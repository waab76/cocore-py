from __future__ import annotations

from pathlib import Path

import pytest

from cocore_provider.config import ConfigError, load_config, resolve_provider_did


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


def test_empty_string_advisor_url_falls_back_to_default() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_ADVISOR": "",
    }
    config = load_config(env)
    assert config.advisor_url == "wss://advisor.cocore.dev/v1/agent"


def test_empty_string_lmstudio_url_falls_back_to_default() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_LMSTUDIO_URL": "",
    }
    config = load_config(env)
    assert config.lmstudio_url == "http://localhost:1234"


def test_empty_string_advisor_did_falls_back_to_default() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_ADVISOR_DID": "",
    }
    config = load_config(env)
    assert config.advisor_did == "did:web:advisor.cocore.dev"


def test_empty_string_machine_label_falls_back_to_default() -> None:
    env = {
        "COCORE_API_KEY": "key123",
        "COCORE_API_BASE": "https://console.example",
        "COCORE_MACHINE_LABEL": "",
    }
    config = load_config(env)
    # Should fall back to socket.gethostname() or platform.node()
    assert config.machine_label != ""


def test_config_file_value_wins_over_env() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_ADVISOR": "wss://from-env.example/v1/agent",
        },
        config_file={"advisor_url": "wss://from-file.example/v1/agent"},
    )
    assert config.advisor_url == "wss://from-file.example/v1/agent"


def test_config_file_supplies_required_fields_with_no_env() -> None:
    config = load_config({}, config_file={"api_key": "filekey", "api_base": "https://file.example"})
    assert config.api_key == "filekey"
    assert config.api_base == "https://file.example"


def test_env_fills_gap_left_by_config_file() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_MACHINE_LABEL": "from-env",
        },
        config_file={"advisor_url": "wss://from-file.example/v1/agent"},
    )
    assert config.advisor_url == "wss://from-file.example/v1/agent"
    assert config.machine_label == "from-env"


def test_empty_string_in_config_file_treated_as_unset() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_ADVISOR": "wss://from-env.example/v1/agent",
        },
        config_file={"advisor_url": ""},
    )
    assert config.advisor_url == "wss://from-env.example/v1/agent"


def test_config_file_allow_insecure_advisor_bool() -> None:
    config = load_config(
        {"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"},
        config_file={
            "advisor_url": "ws://localhost:8080/v1/agent",
            "allow_insecure_advisor": True,
        },
    )
    assert config.advisor_url == "ws://localhost:8080/v1/agent"


def test_config_file_wrong_type_falls_through_to_env() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_MACHINE_LABEL": "from-env",
        },
        config_file={"machine_label": 12345},  # wrong type: int, not str
    )
    assert config.machine_label == "from-env"


def test_no_config_file_argument_still_works() -> None:
    config = load_config({"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"})
    assert config.api_key == "key123"


def test_log_level_defaults_to_info() -> None:
    config = load_config({"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"})
    assert config.log_level == "INFO"


def test_log_level_from_env_is_normalized_to_uppercase() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_LOG_LEVEL": "debug",
        }
    )
    assert config.log_level == "DEBUG"


def test_invalid_log_level_raises_config_error() -> None:
    with pytest.raises(ConfigError, match="invalid log_level"):
        load_config(
            {
                "COCORE_API_KEY": "key123",
                "COCORE_API_BASE": "https://console.example",
                "COCORE_LOG_LEVEL": "VERBOSE",
            }
        )


def test_log_file_defaults_to_home_dir_path() -> None:
    config = load_config({"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"})
    assert config.log_file == Path.home() / ".cocore" / "provider-py" / "provider.log"


def test_log_file_default_honors_monkeypatched_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Same bug class as find_config_path's: a module-level constant built
    # from Path.home() at import time would ignore this monkeypatch.
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    config = load_config({"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://console.example"})
    assert config.log_file == tmp_path / ".cocore" / "provider-py" / "provider.log"


def test_log_file_from_config_file_wins_over_env() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_LOG_FILE": "/env/provider.log",
        },
        config_file={"log_file": "/file/provider.log"},
    )
    assert config.log_file == Path("/file/provider.log")


def test_log_file_none_sentinel_disables_file_logging() -> None:
    config = load_config(
        {
            "COCORE_API_KEY": "key123",
            "COCORE_API_BASE": "https://console.example",
            "COCORE_LOG_FILE": "none",
        }
    )
    assert config.log_file is None


def test_resolve_provider_did_cli_arg_wins_over_everything() -> None:
    provider_did = resolve_provider_did(
        cli_arg="did:plc:cli",
        file={"provider_did": "did:plc:file"},
        env={"COCORE_PROVIDER_DID": "did:plc:env"},
    )
    assert provider_did == "did:plc:cli"


def test_resolve_provider_did_file_wins_over_env_when_no_cli_arg() -> None:
    provider_did = resolve_provider_did(
        cli_arg=None,
        file={"provider_did": "did:plc:file"},
        env={"COCORE_PROVIDER_DID": "did:plc:env"},
    )
    assert provider_did == "did:plc:file"


def test_resolve_provider_did_falls_back_to_env() -> None:
    provider_did = resolve_provider_did(
        cli_arg=None, file={}, env={"COCORE_PROVIDER_DID": "did:plc:env"}
    )
    assert provider_did == "did:plc:env"


def test_resolve_provider_did_raises_when_missing_everywhere() -> None:
    with pytest.raises(ConfigError, match="provider_did is required"):
        resolve_provider_did(cli_arg=None, file={}, env={})


def test_resolve_provider_did_empty_cli_arg_falls_through_to_file() -> None:
    provider_did = resolve_provider_did(cli_arg="", file={"provider_did": "did:plc:file"}, env={})
    assert provider_did == "did:plc:file"
