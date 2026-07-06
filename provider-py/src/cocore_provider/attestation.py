"""Best-effort `dev.cocore.compute.attestation` record + attestation_challenge
responder. There is no Secure Enclave / TPM-backed measurement path here —
this is exactly the software fallback `provider/src/secure_enclave.rs` uses
on non-Apple-silicon hardware, self-attested and admitted at the advisor's
`best-effort` tier only. Every posture boolean that would need real hardware
measurement (secureBootEnabled, secureEnclaveAvailable, authenticatedRootEnabled)
is honestly reported False rather than guessed."""

from __future__ import annotations

import hashlib
import platform
from datetime import UTC, datetime, timedelta

from cocore.canonical import canonical_bytes
from cocore.p256 import sign_p256

from cocore_provider import __version__, hypervisor
from cocore_provider.identity import Identity
from cocore_provider.protocol import AttestationChallenge

ATTESTATION_VALIDITY = timedelta(hours=24)


def _rfc3339(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def build_attestation_record(identity: Identity, *, provider_did: str) -> dict[str, object]:
    now = datetime.now(UTC)
    serial_hash = hashlib.sha256(f"no-hardware-serial:{provider_did}".encode()).hexdigest()
    binary_hash = hashlib.sha256(f"cocore-provider-py/{__version__}".encode()).hexdigest()

    body: dict[str, object] = {
        "publicKey": identity.signing_public_b64,
        "encryptionPubKey": identity.encryption_public_b64,
        "chipName": f"lmstudio:{platform.system().lower()}",
        "hardwareModel": platform.machine() or "unknown",
        "serialNumberHash": serial_hash,
        "osVersion": platform.platform(),
        "binaryHash": binary_hash,
        "sipEnabled": False,
        "secureBootEnabled": False,
        "secureEnclaveAvailable": False,
        "authenticatedRootEnabled": False,
        "attestedAt": _rfc3339(now),
        "expiresAt": _rfc3339(now + ATTESTATION_VALIDITY),
    }
    signature = sign_p256(identity.signing_key, canonical_bytes(body))
    return {**body, "selfSignature": signature}


def build_challenge_response(
    identity: Identity, challenge: AttestationChallenge
) -> dict[str, object]:
    sip_enabled = False
    hypervisor_present = hypervisor.detect()
    payload: dict[str, object] = {
        "nonce": challenge.nonce,
        "sipEnabled": sip_enabled,
        "timestamp": challenge.timestamp,
    }
    if hypervisor_present is not None:
        payload["hypervisorPresent"] = hypervisor_present
    signature = sign_p256(identity.signing_key, canonical_bytes(payload))
    response: dict[str, object] = {
        "nonce": challenge.nonce,
        "sip_enabled": sip_enabled,
        "signature": signature,
    }
    if hypervisor_present is not None:
        response["hypervisor_present"] = hypervisor_present
    return response
