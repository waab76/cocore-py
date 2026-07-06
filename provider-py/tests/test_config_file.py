from __future__ import annotations

from pathlib import Path

import pytest

from cocore_provider.config import ConfigError
from cocore_provider.config_file import DEFAULT_CONFIG_PATH, find_config_path, load_config_file


def test_find_config_path_prefers_cli_arg() -> None:
    path = find_config_path(cli_arg="/tmp/custom.toml", env={"COCORE_CONFIG_PATH": "/tmp/env.toml"})
    assert path == Path("/tmp/custom.toml")


def test_find_config_path_falls_back_to_env() -> None:
    path = find_config_path(cli_arg=None, env={"COCORE_CONFIG_PATH": "/tmp/env.toml"})
    assert path == Path("/tmp/env.toml")


def test_find_config_path_falls_back_to_default() -> None:
    path = find_config_path(cli_arg=None, env={})
    assert path == DEFAULT_CONFIG_PATH


def test_find_config_path_expands_tilde_in_cli_arg(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Regression: a literal "~/..." must resolve against the real home dir
    # via expanduser(), not become a relative "~" directory under whatever
    # the process's cwd happens to be. `expanduser()` reads $HOME directly
    # (not `Path.home()`), so that's what has to be patched here.
    monkeypatch.setenv("HOME", str(tmp_path))
    path = find_config_path(cli_arg="~/custom.toml", env={})
    assert path == tmp_path / "custom.toml"


def test_find_config_path_expands_tilde_in_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    path = find_config_path(cli_arg=None, env={"COCORE_CONFIG_PATH": "~/custom.toml"})
    assert path == tmp_path / "custom.toml"


def test_find_config_path_default_honors_monkeypatched_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression test: the default path used to be pinned to the
    DEFAULT_CONFIG_PATH module constant, which is computed once at import
    time -- before any test gets a chance to monkeypatch Path.home. That
    silently defeated every test's attempt to keep the default-path case
    out of the real ~/.cocore directory (it would still read/write there
    even with Path.home patched), until this machine happened to grow a
    real ~/.cocore/provider-py/config.toml and a supposedly-isolated test
    started reading the real API key out of it."""
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    path = find_config_path(cli_arg=None, env={})
    assert path == tmp_path / ".cocore" / "provider-py" / "config.toml"


def test_load_config_file_returns_empty_dict_when_missing_and_not_explicit(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "config.toml"
    assert load_config_file(missing, is_explicit=False) == {}


def test_load_config_file_raises_when_missing_and_explicit(tmp_path: Path) -> None:
    missing = tmp_path / "config.toml"
    with pytest.raises(ConfigError, match=r"does not exist"):
        load_config_file(missing, is_explicit=True)


def test_load_config_file_parses_valid_toml(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text('api_key = "key123"\napi_base = "https://console.example"\n')
    result = load_config_file(path, is_explicit=False)
    assert result == {"api_key": "key123", "api_base": "https://console.example"}


def test_load_config_file_raises_config_error_on_malformed_toml(tmp_path: Path) -> None:
    path = tmp_path / "config.toml"
    path.write_text("this is not [valid toml")
    with pytest.raises(ConfigError, match="not valid TOML"):
        load_config_file(path, is_explicit=False)


def test_load_config_file_raises_config_error_when_path_is_directory(
    tmp_path: Path,
) -> None:
    dir_path = tmp_path / "a_directory"
    dir_path.mkdir()
    with pytest.raises(ConfigError, match="cannot be read"):
        load_config_file(dir_path, is_explicit=True)


def test_example_config_file_parses_as_valid_toml() -> None:
    example_path = Path(__file__).parent.parent / "config.toml.example"
    result = load_config_file(example_path, is_explicit=True)
    # every key in the example is commented out, so it should parse to an
    # empty dict -- this test exists to catch a syntax error in the example
    # file itself, not to check its (commented-out) contents.
    assert result == {}
