from __future__ import annotations

from pathlib import Path

import pytest

from cocore_provider.cli import _resolve_agent_config, build_parser
from cocore_provider.config import ConfigError


def test_parser_accepts_config_flag() -> None:
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", "/tmp/foo.toml", "--provider-did", "did:plc:x"])
    assert args.config == "/tmp/foo.toml"


def test_parser_config_flag_defaults_to_none() -> None:
    parser = build_parser()
    args = parser.parse_args(["serve", "--provider-did", "did:plc:x"])
    assert args.config is None


def test_parser_provider_did_flag_defaults_to_none() -> None:
    parser = build_parser()
    args = parser.parse_args(["serve"])
    assert args.provider_did is None


def test_resolve_agent_config_uses_explicit_config_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('api_key = "filekey"\napi_base = "https://file.example"\n')
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(config_path), "--provider-did", "did:plc:x"])
    config, provider_did = _resolve_agent_config(args, {})
    assert config.api_key == "filekey"
    assert config.api_base == "https://file.example"
    assert provider_did == "did:plc:x"


def test_resolve_agent_config_env_fills_gap_from_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('api_key = "filekey"\n')
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(config_path), "--provider-did", "did:plc:x"])
    config, _ = _resolve_agent_config(args, {"COCORE_API_BASE": "https://env.example"})
    assert config.api_key == "filekey"
    assert config.api_base == "https://env.example"


def test_resolve_agent_config_raises_config_error_for_missing_explicit_file(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "does-not-exist.toml"
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(missing), "--provider-did", "did:plc:x"])
    with pytest.raises(ConfigError, match=r"does not exist"):
        _resolve_agent_config(args, {})


def test_resolve_agent_config_no_config_flag_falls_back_to_default_path_silently(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # No --config given and no COCORE_CONFIG_PATH: falls back to the
    # default path. Monkeypatch home so this test never touches the
    # real ~/.cocore directory.
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    parser = build_parser()
    args = parser.parse_args(["serve", "--provider-did", "did:plc:x"])
    config, _ = _resolve_agent_config(
        args, {"COCORE_API_KEY": "key123", "COCORE_API_BASE": "https://env.example"}
    )
    assert config.api_key == "key123"


def test_resolve_agent_config_provider_did_from_config_file(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        'api_key = "key123"\napi_base = "https://console.example"\n'
        'provider_did = "did:plc:from-file"\n'
    )
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(config_path)])
    _, provider_did = _resolve_agent_config(args, {})
    assert provider_did == "did:plc:from-file"


def test_resolve_agent_config_provider_did_from_env(tmp_path: Path) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('api_key = "key123"\napi_base = "https://console.example"\n')
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(config_path)])
    _, provider_did = _resolve_agent_config(args, {"COCORE_PROVIDER_DID": "did:plc:from-env"})
    assert provider_did == "did:plc:from-env"


def test_resolve_agent_config_provider_did_cli_flag_overrides_config_file(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text(
        'api_key = "key123"\napi_base = "https://console.example"\n'
        'provider_did = "did:plc:from-file"\n'
    )
    parser = build_parser()
    args = parser.parse_args(
        ["serve", "--config", str(config_path), "--provider-did", "did:plc:from-cli"]
    )
    _, provider_did = _resolve_agent_config(args, {})
    assert provider_did == "did:plc:from-cli"


def test_resolve_agent_config_raises_when_provider_did_missing_everywhere(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "config.toml"
    config_path.write_text('api_key = "key123"\napi_base = "https://console.example"\n')
    parser = build_parser()
    args = parser.parse_args(["serve", "--config", str(config_path)])
    with pytest.raises(ConfigError, match="provider_did is required"):
        _resolve_agent_config(args, {})
