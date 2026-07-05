"""Environment-driven configuration, mirroring the Rust provider's env
vars and defaults (`provider/src/main.rs`, `provider/src/advisor.rs`) so an
operator familiar with the Rust agent recognizes the same knobs."""

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


def load_config(env: Mapping[str, str]) -> AgentConfig:
    api_key = env.get("COCORE_API_KEY")
    if not api_key:
        raise ConfigError("COCORE_API_KEY is required (console API key)")
    api_base = env.get("COCORE_API_BASE")
    if not api_base:
        raise ConfigError("COCORE_API_BASE is required (console URL)")

    advisor_url = env.get("COCORE_ADVISOR", DEFAULT_ADVISOR_URL)
    scheme = advisor_url.split("://", 1)[0].lower()
    if scheme != "wss" and not _truthy(env.get("COCORE_ALLOW_INSECURE_ADVISOR")):
        raise ConfigError(
            f"refusing insecure advisor URL {advisor_url!r} (scheme {scheme!r}); "
            "use a wss:// URL or set COCORE_ALLOW_INSECURE_ADVISOR=1 for local dev"
        )

    advisor_did = env.get("COCORE_ADVISOR_DID") or DEFAULT_ADVISOR_DID
    lmstudio_url = env.get("COCORE_LMSTUDIO_URL", DEFAULT_LMSTUDIO_URL)
    identity_path_raw = env.get("COCORE_IDENTITY_PATH")
    identity_path = (
        Path(identity_path_raw)
        if identity_path_raw
        else Path.home() / ".cocore" / "provider-py" / "identity.json"
    )
    machine_label = env.get("COCORE_MACHINE_LABEL") or socket.gethostname() or platform.node()

    return AgentConfig(
        advisor_url=advisor_url,
        advisor_did=advisor_did,
        api_base=api_base,
        api_key=api_key,
        lmstudio_url=lmstudio_url,
        identity_path=identity_path,
        machine_label=machine_label,
    )
