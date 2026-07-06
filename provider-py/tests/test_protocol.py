from __future__ import annotations

import json

import pytest

from cocore_provider.protocol import (
    ProtocolError,
    build_attestation_response,
    build_heartbeat,
    build_inference_chunk,
    build_inference_complete,
    build_inference_keepalive,
    build_pong,
    build_recover_result,
    build_register,
    frame_type,
    parse_attestation_challenge,
    parse_control_changed,
    parse_health_notice,
    parse_inference_request,
    parse_ping,
    parse_recover_request,
)


def test_build_register_matches_wire_field_names() -> None:
    frame = build_register(
        provider_did="did:plc:abc",
        machine_id="win-1",
        machine_label="my-pc",
        chip="lmstudio:windows",
        ram_gb=32,
        supported_models=["llama-3.1-8b"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        tier="best-effort",
        auth_jwt="jwt.token.here",
    )
    assert frame["type"] == "register"
    assert frame["provider_did"] == "did:plc:abc"
    assert frame["machine_id"] == "win-1"
    assert frame["supported_models"] == ["llama-3.1-8b"]
    assert frame["encryption_pub_key"] == "epk=="
    assert frame["attestation_pub_key"] == "apk=="
    assert frame["tier"] == "best-effort"
    assert frame["auth_jwt"] == "jwt.token.here"
    assert "binary_version" not in frame
    json.dumps(frame)  # must be JSON-serializable


def test_build_register_includes_binary_version_when_given() -> None:
    frame = build_register(
        provider_did="did:plc:abc",
        machine_id="win-1",
        machine_label="my-pc",
        chip="lmstudio:windows",
        ram_gb=32,
        supported_models=["llama-3.1-8b"],
        encryption_pub_key="epk==",
        attestation_pub_key="apk==",
        attestation_uri="at://did:plc:abc/dev.cocore.compute.attestation/1",
        tier="best-effort",
        auth_jwt=None,
        binary_version="0.1.0",
    )
    assert frame["binary_version"] == "0.1.0"


def test_build_heartbeat() -> None:
    frame = build_heartbeat(load=0.5, queue_depth=1)
    assert frame == {
        "type": "heartbeat",
        "load": 0.5,
        "queue_depth": 1,
        "at": frame["at"],
        "active": True,
    }
    assert isinstance(frame["at"], str)


def test_build_heartbeat_active_false() -> None:
    frame = build_heartbeat(load=0.0, queue_depth=0, active=False)
    assert frame["active"] is False


def test_build_inference_chunk_and_complete() -> None:
    chunk = build_inference_chunk(session_id="s1", seq=0, ciphertext_b64="Y2lwaGVy")
    assert chunk == {
        "type": "inference_chunk",
        "session_id": "s1",
        "seq": 0,
        "channel": "content",
        "ciphertext": "Y2lwaGVy",
    }
    complete = build_inference_complete(
        session_id="s1", tokens_in=10, tokens_out=20, receipt_uri="at://foo"
    )
    assert complete == {
        "type": "inference_complete",
        "session_id": "s1",
        "tokens_in": 10,
        "tokens_out": 20,
        "receipt_uri": "at://foo",
    }


def test_build_keepalive_and_pong() -> None:
    assert build_inference_keepalive(session_id="s1") == {
        "type": "inference_keepalive",
        "session_id": "s1",
    }
    assert build_pong(nonce="n1") == {"type": "pong", "nonce": "n1"}


def test_build_attestation_response() -> None:
    frame = build_attestation_response(
        nonce="n1", timestamp="2026-01-01T00:00:00Z", sip_enabled=False, signature="sig=="
    )
    assert frame == {
        "type": "attestation_response",
        "nonce": "n1",
        "timestamp": "2026-01-01T00:00:00Z",
        "sip_enabled": False,
        "signature": "sig==",
    }


def test_frame_type() -> None:
    assert frame_type({"type": "ping", "nonce": "abc"}) == "ping"


def test_frame_type_missing_raises() -> None:
    with pytest.raises(ProtocolError):
        frame_type({"nonce": "abc"})


def test_parse_attestation_challenge() -> None:
    challenge = parse_attestation_challenge(
        {"type": "attestation_challenge", "nonce": "n1", "timestamp": "2026-01-01T00:00:00Z"}
    )
    assert challenge.nonce == "n1"
    assert challenge.timestamp == "2026-01-01T00:00:00Z"


def test_parse_attestation_challenge_missing_field_raises() -> None:
    with pytest.raises(ProtocolError, match="nonce"):
        parse_attestation_challenge({"type": "attestation_challenge"})


def test_parse_inference_request() -> None:
    req = parse_inference_request(
        {
            "type": "inference_request",
            "job_uri": "at://did:plc:r/dev.cocore.compute.job/1",
            "job_cid": "bafyjob",
            "requester_did": "did:plc:r",
            "requester_pub_key": "rpk==",
            "model": "llama-3.1-8b",
            "max_tokens_out": 512,
            "ciphertext": "Y2lwaGVy",
            "session_id": "s1",
        }
    )
    assert req.job_uri == "at://did:plc:r/dev.cocore.compute.job/1"
    assert req.job_cid == "bafyjob"
    assert req.requester_pub_key == "rpk=="
    assert req.max_tokens_out == 512
    assert req.ciphertext_b64 == "Y2lwaGVy"


def test_parse_inference_request_missing_field_raises() -> None:
    with pytest.raises(ProtocolError, match="requester_pub_key"):
        parse_inference_request(
            {
                "type": "inference_request",
                "job_uri": "at://x",
                "requester_did": "did:plc:r",
                "model": "m",
                "max_tokens_out": 1,
                "ciphertext": "Y2lwaGVy",
                "session_id": "s1",
            }
        )


def test_parse_inference_request_ciphertext_byte_array_matches_base64() -> None:
    base = {
        "type": "inference_request",
        "job_uri": "at://did:plc:r/dev.cocore.compute.job/1",
        "job_cid": "bafyjob",
        "requester_did": "did:plc:r",
        "requester_pub_key": "rpk==",
        "model": "llama-3.1-8b",
        "max_tokens_out": 512,
        "session_id": "s1",
    }
    req_str = parse_inference_request({**base, "ciphertext": "Y2lwaGVy"})
    req_arr = parse_inference_request({**base, "ciphertext": list(b"cipher")})
    assert req_arr.ciphertext_b64 == req_str.ciphertext_b64 == "Y2lwaGVy"


def test_parse_inference_request_ciphertext_invalid_type_raises() -> None:
    base = {
        "type": "inference_request",
        "job_uri": "at://x",
        "requester_did": "did:plc:r",
        "requester_pub_key": "rpk==",
        "model": "m",
        "max_tokens_out": 1,
        "session_id": "s1",
    }
    with pytest.raises(ProtocolError, match="ciphertext"):
        parse_inference_request({**base, "ciphertext": {"not": "valid"}})


def test_parse_inference_request_ciphertext_out_of_range_int_raises() -> None:
    base = {
        "type": "inference_request",
        "job_uri": "at://x",
        "requester_did": "did:plc:r",
        "requester_pub_key": "rpk==",
        "model": "m",
        "max_tokens_out": 1,
        "session_id": "s1",
    }
    with pytest.raises(ProtocolError, match="ciphertext"):
        parse_inference_request({**base, "ciphertext": [1, 2, 300]})
    with pytest.raises(ProtocolError, match="ciphertext"):
        parse_inference_request({**base, "ciphertext": [1, "x", 3]})


def test_parse_ping() -> None:
    assert parse_ping({"type": "ping", "nonce": "n1"}).nonce == "n1"


def test_build_recover_result_without_detail() -> None:
    assert build_recover_result(recovered=True) == {"type": "recover_result", "recovered": True}


def test_build_recover_result_with_detail() -> None:
    frame = build_recover_result(recovered=False, detail="LMStudio unreachable")
    assert frame == {
        "type": "recover_result",
        "recovered": False,
        "detail": "LMStudio unreachable",
    }


def test_parse_control_changed() -> None:
    assert parse_control_changed({"type": "control_changed"}).reason is None
    assert (
        parse_control_changed({"type": "control_changed", "reason": "owner edit"}).reason
        == "owner edit"
    )


def test_parse_control_changed_bad_reason_raises() -> None:
    with pytest.raises(ProtocolError, match="reason"):
        parse_control_changed({"type": "control_changed", "reason": 5})


def test_parse_recover_request() -> None:
    assert parse_recover_request({"type": "recover_request"}).reason is None
    assert (
        parse_recover_request({"type": "recover_request", "reason": "idle-timeout"}).reason
        == "idle-timeout"
    )


def test_parse_health_notice() -> None:
    notice = parse_health_notice({"type": "health_notice", "standing": "bad", "reason": "x"})
    assert notice.standing == "bad"
    assert notice.reason == "x"


def test_parse_health_notice_requires_standing() -> None:
    with pytest.raises(ProtocolError, match="standing"):
        parse_health_notice({"type": "health_notice"})
