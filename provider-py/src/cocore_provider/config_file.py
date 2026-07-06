"""Finds and parses the optional TOML config file: --config flag, then
COCORE_CONFIG_PATH env var, then ~/.cocore/provider-py/config.toml. The
file is entirely optional -- provider-py behaves exactly as it does today
if it's absent. Precedence between the file and individual env vars is
config.py's concern (`_resolve`/`_resolve_bool`); this module only locates
and parses the file itself."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from cocore_provider.config import ConfigError

DEFAULT_CONFIG_PATH = Path.home() / ".cocore" / "provider-py" / "config.toml"


def find_config_path(*, cli_arg: str | None, env: Mapping[str, str]) -> Path:
    if cli_arg:
        return Path(cli_arg)
    env_path = env.get("COCORE_CONFIG_PATH")
    if env_path:
        return Path(env_path)
    # Computed fresh rather than returning the DEFAULT_CONFIG_PATH module
    # constant above: that constant is fixed at import time, before a test
    # can monkeypatch Path.home, so returning it here would silently read
    # the real ~/.cocore even from a test that patched Path.home
    # specifically to avoid that.
    return Path.home() / ".cocore" / "provider-py" / "config.toml"


def load_config_file(path: Path, *, is_explicit: bool) -> dict[str, Any]:
    if not path.exists():
        if is_explicit:
            raise ConfigError(f"config file {path} does not exist")
        return {}
    try:
        with path.open("rb") as f:
            return tomllib.load(f)
    except tomllib.TOMLDecodeError as e:
        raise ConfigError(f"config file {path} is not valid TOML: {e}") from e
    except OSError as e:
        raise ConfigError(f"config file {path} cannot be read: {e}") from e
