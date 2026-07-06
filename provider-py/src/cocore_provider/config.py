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
DEFAULT_LOG_LEVEL = "INFO"
VALID_LOG_LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"})
REGISTER_LXM = "dev.cocore.compute.register"

HEARTBEAT_INTERVAL_SECS = 30.0
STREAM_KEEPALIVE_INTERVAL_SECS = 10.0
# How often the agent re-reads the owner's start/stop switch off its own
# `dev.cocore.compute.provider` PDS record (provider/src/advisor.rs's
# `active_poll` ticker uses the same 30s cadence as its heartbeat).
ACTIVE_POLL_INTERVAL_SECS = 30.0


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
    log_level: str = DEFAULT_LOG_LEVEL
    log_file: Path | None = None
    # Total RAM (GB) of the machine actually running the models, for the
    # published provider record. `None` means auto-detect via psutil on the
    # machine this agent process runs on — correct only when `lmstudio_url`
    # points at localhost. When LMStudio runs on a different host (e.g. a
    # remote/network LMStudio server), psutil measures the wrong machine;
    # LMStudio's REST API exposes no system/hardware endpoint to read the
    # real figure from, so the operator must set this explicitly instead.
    ram_gb: int | None = None


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


def _resolve_int(
    key: str, *, file: Mapping[str, object], env: Mapping[str, str], env_key: str
) -> int | None:
    """Same file-wins-over-env precedence as `_resolve`, but for an integer
    setting. A present value that doesn't parse as an int raises rather than
    silently falling through, since a typo'd override should not be treated
    as "unset" (which for `ram_gb` means "you get a different, silently
    wrong, auto-detected value")."""
    file_value = file.get(key)
    if isinstance(file_value, int) and not isinstance(file_value, bool):
        return file_value
    if isinstance(file_value, str) and file_value:
        try:
            return int(file_value)
        except ValueError as e:
            raise ConfigError(f"{key!r} must be an integer, got {file_value!r}") from e
    env_value = env.get(env_key)
    if env_value:
        try:
            return int(env_value)
        except ValueError as e:
            raise ConfigError(f"{env_key} must be an integer, got {env_value!r}") from e
    return None


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

    log_level_raw = _resolve(
        "log_level", file=file, env=env, env_key="COCORE_LOG_LEVEL", default=DEFAULT_LOG_LEVEL
    )
    assert log_level_raw is not None  # `default` guarantees a value
    log_level = log_level_raw.upper()
    if log_level not in VALID_LOG_LEVELS:
        raise ConfigError(
            f"invalid log_level {log_level_raw!r}; must be one of {sorted(VALID_LOG_LEVELS)}"
        )

    log_file_raw = _resolve("log_file", file=file, env=env, env_key="COCORE_LOG_FILE")
    if log_file_raw and log_file_raw.strip().lower() == "none":
        log_file = None
    elif log_file_raw:
        log_file = Path(log_file_raw)
    else:
        # Computed fresh rather than a module-level constant: see
        # find_config_path()'s identical fix for why a Path.home()-based
        # default must not be frozen at import time.
        log_file = Path.home() / ".cocore" / "provider-py" / "provider.log"

    ram_gb = _resolve_int("ram_gb", file=file, env=env, env_key="COCORE_RAM_GB")
    if ram_gb is not None and ram_gb < 1:
        raise ConfigError(f"ram_gb must be >= 1, got {ram_gb}")

    return AgentConfig(
        advisor_url=advisor_url,
        advisor_did=advisor_did,
        api_base=api_base,
        api_key=api_key,
        lmstudio_url=lmstudio_url,
        identity_path=identity_path,
        machine_label=machine_label,
        ram_gb=ram_gb,
        log_level=log_level,
        log_file=log_file,
    )


def resolve_provider_did(
    *, cli_arg: str | None, file: Mapping[str, object], env: Mapping[str, str]
) -> str:
    """Resolve this provider's DID: an explicit `--provider-did` flag wins
    outright (same override precedence `--config` has over
    `COCORE_CONFIG_PATH`), else the config file's `provider_did` key, else
    `COCORE_PROVIDER_DID`. Kept separate from `AgentConfig`/`load_config`
    since it's a per-invocation identity value, not a connection setting,
    and the CLI flag needs to short-circuit the config-file-wins-over-env
    rule that governs everything else in `load_config`."""
    provider_did = cli_arg or _resolve(
        "provider_did", file=file, env=env, env_key="COCORE_PROVIDER_DID"
    )
    if not provider_did:
        raise ConfigError(
            "provider_did is required (--provider-did flag, provider_did config file key, "
            "or COCORE_PROVIDER_DID env var)"
        )
    return provider_did
