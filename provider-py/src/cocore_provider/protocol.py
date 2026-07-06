"""Advisor <-> provider WS wire types. Field names and shapes are byte-for-
byte what `infra/advisor/src/protocol.ts` expects/emits — this module was
written against that file, not guessed. `AdvisorMessage` there is a tagged
union of JSON objects with a `type` discriminator; we mirror that as plain
dicts (outbound) and validated dataclasses (inbound), matching the
hand-written `validateFrame` validation style on the TS side rather than a
full schema library."""

from __future__ import annotations

import base64
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any


class ProtocolError(ValueError):
    pass


def _now_rfc3339() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _require_str(raw: Mapping[str, Any], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise ProtocolError(f"missing or non-string field {key!r}")
    return value


def _require_int(raw: Mapping[str, Any], key: str) -> int:
    value = raw.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ProtocolError(f"missing or non-integer field {key!r}")
    return value


def _require_ciphertext_b64(raw: Mapping[str, Any], key: str) -> str:
    """Normalize the wire `ciphertext` field to a base64 string.

    The real wire protocol (`infra/advisor/src/protocol.ts` `isBytes()` /
    `bytesToBase64`) allows `ciphertext: number[] | string`. The production
    requester (`packages/console/src/lib/inference-dispatch.server.ts`) sends
    a plain JSON array of byte values, not base64 — the advisor forwards it
    unchanged. Accept either shape here and normalize to base64.
    """
    value = raw.get(key)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        byte_values: list[int] = []
        for item in value:
            if not isinstance(item, int) or isinstance(item, bool) or not (0 <= item <= 255):
                raise ProtocolError(f"field {key!r} array must contain only ints in 0-255")
            byte_values.append(item)
        return base64.b64encode(bytes(byte_values)).decode("ascii")
    raise ProtocolError(f"missing or invalid field {key!r}: expected string or byte array")


def frame_type(raw: Mapping[str, Any]) -> str:
    return _require_str(raw, "type")


# --- Outbound (provider -> advisor) ----------------------------------


def build_register(
    *,
    provider_did: str,
    machine_id: str,
    machine_label: str,
    chip: str,
    ram_gb: int,
    supported_models: list[str],
    encryption_pub_key: str,
    attestation_pub_key: str,
    attestation_uri: str,
    tier: str,
    auth_jwt: str | None,
    binary_version: str | None = None,
) -> dict[str, object]:
    frame: dict[str, object] = {
        "type": "register",
        "provider_did": provider_did,
        "machine_id": machine_id,
        "machine_label": machine_label,
        "chip": chip,
        "ram_gb": ram_gb,
        "supported_models": supported_models,
        "encryption_pub_key": encryption_pub_key,
        "attestation_pub_key": attestation_pub_key,
        "attestation_uri": attestation_uri,
        "tier": tier,
    }
    if auth_jwt is not None:
        frame["auth_jwt"] = auth_jwt
    if binary_version is not None:
        frame["binary_version"] = binary_version
    return frame


def build_heartbeat(*, load: float, queue_depth: int, active: bool = True) -> dict[str, object]:
    return {
        "type": "heartbeat",
        "load": load,
        "queue_depth": queue_depth,
        "at": _now_rfc3339(),
        "active": active,
    }


def build_attestation_response(
    *, nonce: str, timestamp: str, sip_enabled: bool, signature: str
) -> dict[str, object]:
    return {
        "type": "attestation_response",
        "nonce": nonce,
        "timestamp": timestamp,
        "sip_enabled": sip_enabled,
        "signature": signature,
    }


def build_inference_chunk(*, session_id: str, seq: int, ciphertext_b64: str) -> dict[str, object]:
    return {
        "type": "inference_chunk",
        "session_id": session_id,
        "seq": seq,
        "channel": "content",
        "ciphertext": ciphertext_b64,
    }


def build_inference_keepalive(*, session_id: str) -> dict[str, object]:
    return {"type": "inference_keepalive", "session_id": session_id}


def build_inference_complete(
    *, session_id: str, tokens_in: int, tokens_out: int, receipt_uri: str
) -> dict[str, object]:
    return {
        "type": "inference_complete",
        "session_id": session_id,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "receipt_uri": receipt_uri,
    }


def build_pong(*, nonce: str) -> dict[str, object]:
    return {"type": "pong", "nonce": nonce}


def build_recover_result(*, recovered: bool, detail: str | None = None) -> dict[str, object]:
    frame: dict[str, object] = {"type": "recover_result", "recovered": recovered}
    if detail is not None:
        frame["detail"] = detail
    return frame


# --- Inbound (advisor -> provider) ------------------------------------


@dataclass
class AttestationChallenge:
    nonce: str
    timestamp: str


def parse_attestation_challenge(raw: Mapping[str, Any]) -> AttestationChallenge:
    return AttestationChallenge(
        nonce=_require_str(raw, "nonce"), timestamp=_require_str(raw, "timestamp")
    )


@dataclass
class InferenceRequestFrame:
    job_uri: str
    job_cid: str | None
    requester_did: str
    requester_pub_key: str
    model: str
    max_tokens_out: int
    ciphertext_b64: str
    session_id: str


def parse_inference_request(raw: Mapping[str, Any]) -> InferenceRequestFrame:
    job_cid = raw.get("job_cid")
    if job_cid is not None and not isinstance(job_cid, str):
        raise ProtocolError("job_cid must be a string when present")
    return InferenceRequestFrame(
        job_uri=_require_str(raw, "job_uri"),
        job_cid=job_cid,
        requester_did=_require_str(raw, "requester_did"),
        requester_pub_key=_require_str(raw, "requester_pub_key"),
        model=_require_str(raw, "model"),
        max_tokens_out=_require_int(raw, "max_tokens_out"),
        ciphertext_b64=_require_ciphertext_b64(raw, "ciphertext"),
        session_id=_require_str(raw, "session_id"),
    )


@dataclass
class PingFrame:
    nonce: str


def parse_ping(raw: Mapping[str, Any]) -> PingFrame:
    return PingFrame(nonce=_require_str(raw, "nonce"))


def _optional_str(raw: Mapping[str, Any], key: str) -> str | None:
    value = raw.get(key)
    if value is not None and not isinstance(value, str):
        raise ProtocolError(f"{key!r} must be a string when present")
    return value


@dataclass
class ControlChangedFrame:
    reason: str | None


def parse_control_changed(raw: Mapping[str, Any]) -> ControlChangedFrame:
    return ControlChangedFrame(reason=_optional_str(raw, "reason"))


@dataclass
class RecoverRequestFrame:
    reason: str | None


def parse_recover_request(raw: Mapping[str, Any]) -> RecoverRequestFrame:
    return RecoverRequestFrame(reason=_optional_str(raw, "reason"))


@dataclass
class HealthNoticeFrame:
    standing: str
    reason: str | None


def parse_health_notice(raw: Mapping[str, Any]) -> HealthNoticeFrame:
    return HealthNoticeFrame(
        standing=_require_str(raw, "standing"), reason=_optional_str(raw, "reason")
    )
