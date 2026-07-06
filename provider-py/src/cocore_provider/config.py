"""Environment-driven configuration, mirroring the Rust provider's env
vars and defaults (`provider/src/main.rs`, `provider/src/advisor.rs`) so an
operator familiar with the Rust agent recognizes the same knobs. An
optional TOML config file (see `config_file.py`) can supply any of these
settings too -- per setting, the config file's value wins if present and
non-empty; the environment variable is only consulted when the file
omits that key (or there's no config file at all)."""

from __future__ import annotations

import platform
import socket
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

DEFAULT_ADVISOR_URL = "wss://advisor.cocore.dev/v1/agent"
DEFAULT_ADVISOR_DID = "did:web:advisor.cocore.dev"
DEFAULT_LMSTUDIO_URL = "http://localhost:1234"
REGISTER_LXM = "dev.cocore.compute.register"

HEARTBEAT_INTERVAL_SECS = 30.0
RECV_IDLE_TIMEOUT_SECS = 70.0
STREAM_KEEPALIVE_INTERVAL_SECS = 10.0


class ConfigError(RuntimeError):
    pass


@dataclass
class AgentConfig:
    advisor_url: str
    advisor_did: str
    api_base: str
    api_key: str
    lmstudio_url: str
    identity_path: Path
    machine_label: str


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes")


def _resolve(
    key: str,
    *,
    file: Mapping[str, object],
    env: Mapping[str, str],
    env_key: str,
    default: str | None = None,
) -> str | None:
    """File value wins if present and a non-empty string; else the env
    var if present and non-empty; else `default`. A non-string file value
    (wrong TOML type for this key) is treated as absent, not an error --
    one malformed key shouldn't block every other setting from resolving."""
    file_value = file.get(key)
    if isinstance(file_value, str) and file_value:
        return file_value
    env_value = env.get(env_key)
    if env_value:
        return env_value
    return default


def _resolve_bool(
    key: str, *, file: Mapping[str, object], env: Mapping[str, str], env_key: str
) -> bool:
    file_value = file.get(key)
    if isinstance(file_value, bool):
        return file_value
    if isinstance(file_value, str) and file_value:
        return _truthy(file_value)
    return _truthy(env.get(env_key))


def load_config(
    env: Mapping[str, str], *, config_file: Mapping[str, object] | None = None
) -> AgentConfig:
    file: Mapping[str, object] = config_file if config_file is not None else {}

    api_key = _resolve("api_key", file=file, env=env, env_key="COCORE_API_KEY")
    if not api_key:
        raise ConfigError("COCORE_API_KEY is required (console API key)")
    api_base = _resolve("api_base", file=file, env=env, env_key="COCORE_API_BASE")
    if not api_base:
        raise ConfigError("COCORE_API_BASE is required (console URL)")

    advisor_url = _resolve(
        "advisor_url", file=file, env=env, env_key="COCORE_ADVISOR", default=DEFAULT_ADVISOR_URL
    )
    assert advisor_url is not None  # `default` guarantees a value
    scheme = advisor_url.split("://", 1)[0].lower()
    allow_insecure = _resolve_bool(
        "allow_insecure_advisor", file=file, env=env, env_key="COCORE_ALLOW_INSECURE_ADVISOR"
    )
    if scheme != "wss" and not allow_insecure:
        raise ConfigError(
            f"refusing insecure advisor URL {advisor_url!r} (scheme {scheme!r}); "
            "use a wss:// URL or set allow_insecure_advisor "
            "(config file) / COCORE_ALLOW_INSECURE_ADVISOR (env) for local dev"
        )

    advisor_did = _resolve(
        "advisor_did",
        file=file,
        env=env,
        env_key="COCORE_ADVISOR_DID",
        default=DEFAULT_ADVISOR_DID,
    )
    lmstudio_url = _resolve(
        "lmstudio_url",
        file=file,
        env=env,
        env_key="COCORE_LMSTUDIO_URL",
        default=DEFAULT_LMSTUDIO_URL,
    )
    assert advisor_did is not None
    assert lmstudio_url is not None

    identity_path_raw = _resolve(
        "identity_path", file=file, env=env, env_key="COCORE_IDENTITY_PATH"
    )
    identity_path = (
        Path(identity_path_raw)
        if identity_path_raw
        else Path.home() / ".cocore" / "provider-py" / "identity.json"
    )
    machine_label = _resolve(
        "machine_label", file=file, env=env, env_key="COCORE_MACHINE_LABEL"
    ) or (socket.gethostname() or platform.node())

    return AgentConfig(
        advisor_url=advisor_url,
        advisor_did=advisor_did,
        api_base=api_base,
        api_key=api_key,
        lmstudio_url=lmstudio_url,
        identity_path=identity_path,
        machine_label=machine_label,
    )
