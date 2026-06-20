"""Requester-side, fail-closed provider verification (mirror of
packages/sdk/src/verify-provider.ts).

Run BEFORE sealing a prompt. Returns ``attested-confidential`` only when ALL of:
the attestation's selfSignature verifies; a bound MDA chain (leaf key ==
publicKey) to the Apple root; cdHash (and optionally metallibHash) in the
known-good set; the hardened posture (sip, secureBoot, hardenedRuntime,
libraryValidation, not getTaskAllow, inProcessBackend, antiDebug,
coreDumpsDisabled, envScrubbed); osVersion >= floor; unexpired; and — when a
SessionKey is supplied — a valid enclave signature over {attestationCid,
ephemeralPubKey, nonce}. Anything weaker is best-effort, and when the caller
demanded confidential it FAILS CLOSED (ok=False).
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Optional

from .canonical import canonical_bytes
from .mda import MdaError, verify_chain, verify_chain_against
from .p256 import verify_attestation_signature, verify_p256


def session_key_message(sk: Mapping[str, str]) -> bytes:
    """Canonical bytes an enclave signs for a SessionKey — byte-identical to the
    Rust producer and the TS sessionKeyMessage."""
    return canonical_bytes(
        {
            "attestationCid": sk["attestationCid"],
            "ephemeralPubKey": sk["ephemeralPubKey"],
            "nonce": sk["nonce"],
        }
    )


@dataclass
class VerifyResult:
    tier: str
    ok: bool
    findings: list[dict] = field(default_factory=list)
    seal_to_key: Optional[str] = None

    def codes(self) -> list[str]:
        return [f["code"] for f in self.findings]


def verify_provider_for_seal(
    attestation: Mapping[str, Any],
    mda_chain: Optional[list[str]],
    *,
    require_confidential: bool = False,
    known_good_cdhashes: Iterable[str] = (),
    known_good_metallib_hashes: Iterable[str] = (),
    known_good_engine_lib_hashes: Iterable[str] = (),
    os_floor: Optional[str] = None,
    attestation_cid: Optional[str] = None,
    nonce: Optional[str] = None,
    session_key: Optional[Mapping[str, str]] = None,
    require_session_key: bool = False,
    trust_anchor_der: Optional[bytes] = None,
    now: Optional[datetime] = None,
) -> VerifyResult:
    now = now or datetime.now(timezone.utc)
    known_good = {h.strip().lower() for h in known_good_cdhashes if h}
    known_good_metallibs = {h.strip().lower() for h in known_good_metallib_hashes if h}
    known_good_engine_libs = {h.strip().lower() for h in known_good_engine_lib_hashes if h}
    blockers: list[tuple[str, str]] = []

    def block(code: str, message: str) -> None:
        blockers.append((code, message))

    # 0. The attestation must be self-signed by its own publicKey — this
    #    authenticates every posture field below.
    if not verify_attestation_signature(attestation, attestation.get("publicKey", "")):
        block(
            "attestation-signature-invalid",
            "attestation.selfSignature did not verify against attestation.publicKey",
        )

    # 1+2. MDA chain present, verifies, bound to the signing key.
    mda = None
    if not mda_chain:
        block("no-mda-chain", "attestation carries no MDA certificate chain")
    else:
        chain_der = [base64.b64decode(c) for c in mda_chain]
        try:
            mda = (
                verify_chain_against(chain_der, trust_anchor_der, now)
                if trust_anchor_der is not None
                else verify_chain(chain_der)
            )
        except MdaError as exc:
            block("mda-invalid", f"MDA chain did not verify: {exc}")
        if mda is not None:
            if not mda.valid:
                block("mda-invalid", "MDA chain did not verify")
            if not mda.leaf_public_key:
                block("mda-no-leaf-key", "MDA leaf has no extractable P-256 key to bind")
            elif mda.leaf_public_key != attestation.get("publicKey"):
                block("mda-unbound", "MDA leaf key != attestation.publicKey (chain not bound)")

    # 3. cdHash in the known-good set.
    cd = attestation.get("cdHash")
    if not cd:
        block("no-cdhash", "attestation has no measured cdHash")
    elif not known_good:
        block("no-known-good-set", "no known-good cdHash set supplied; cannot trust any build")
    elif cd.lower() not in known_good:
        block("cdhash-unknown", f"cdHash {cd} is not in the known-good set")

    # Metallib pin (when supplied).
    if known_good_metallibs:
        mh = attestation.get("metallibHash")
        if not mh:
            block("no-metallib-hash", "attestation has no measured metallibHash")
        elif mh.lower() not in known_good_metallibs:
            block("metallib-unknown", f"metallibHash {mh} is not in the known-good set")

    # Engine-dylib pin (when supplied).
    if known_good_engine_libs:
        eh = attestation.get("engineLibHash")
        if not eh:
            block("no-engine-lib-hash", "attestation has no measured engineLibHash")
        elif eh.lower() not in known_good_engine_libs:
            block("engine-lib-unknown", f"engineLibHash {eh} is not in the known-good set")

    # 4. Hardened-runtime posture (absent booleans treated as the unsafe value).
    if attestation.get("sipEnabled") is not True:
        block("sip-off", "SIP is not enabled")
    if attestation.get("secureBootEnabled") is not True:
        block("secure-boot-off", "Secure Boot is not enabled")
    if attestation.get("hardenedRuntime") is not True:
        block("no-hardened-runtime", "binary is not running under the hardened runtime")
    if attestation.get("libraryValidation") is not True:
        block("no-library-validation", "library validation is not enforced")
    if attestation.get("getTaskAllow") is not False:
        block("get-task-allow", "get-task-allow is not provably false")
    if attestation.get("inProcessBackend") is not True:
        block("not-in-process", "inference does not run in-process in the measured binary")
    if attestation.get("antiDebug") is not True:
        block("no-anti-debug", "PT_DENY_ATTACH not applied")
    if attestation.get("coreDumpsDisabled") is not True:
        block("core-dumps-enabled", "core dumps not disabled")
    if attestation.get("envScrubbed") is not True:
        block("env-not-scrubbed", "DYLD_* env not scrubbed")
    if mda is not None and mda.sip_enabled is False:
        block("mda-sip-off", "MDA chain reports SIP disabled")
    if mda is not None and mda.secure_boot_enabled is False:
        block("mda-secure-boot-off", "MDA chain reports Secure Boot disabled")

    # 5. OS floor.
    if os_floor and _cmp_os(attestation.get("osVersion", ""), os_floor) < 0:
        block("os-below-floor", f"osVersion {attestation.get('osVersion')} below floor {os_floor}")

    # 6. Freshness window.
    attested_at = _parse_dt(attestation.get("attestedAt"))
    expires_at = _parse_dt(attestation.get("expiresAt"))
    if attested_at is None or expires_at is None or not (attested_at <= now <= expires_at):
        block("attestation-expired", "attestation is outside its [attestedAt, expiresAt] window")

    # 7. Optional enclave-signed session key (advisor-trustless freshness).
    if session_key:
        if not nonce or session_key.get("nonce") != nonce:
            block("session-nonce-mismatch", "session key nonce does not match the request nonce")
        if not attestation_cid or session_key.get("attestationCid") != attestation_cid:
            block("session-attestation-mismatch", "session key not bound to the attestation CID")
        if not verify_p256(
            attestation.get("publicKey", ""),
            session_key.get("signature", ""),
            session_key_message(session_key),
        ):
            block("session-signature-invalid", "session key signature did not verify")
    elif require_session_key:
        block("no-session-key", "advisor-trustless freshness required but no session key supplied")
    elif not attestation.get("encryptionPubKey"):
        block("no-encryption-key", "attestation has no encryptionPubKey to seal to")

    confidential = not blockers
    tier = "attested-confidential" if confidential else "best-effort"
    severity = "error" if require_confidential else "warn"
    findings = [{"severity": severity, "code": c, "message": m} for c, m in blockers]
    result = VerifyResult(
        tier=tier, ok=confidential or not require_confidential, findings=findings
    )
    if confidential:
        result.seal_to_key = (
            session_key["ephemeralPubKey"] if session_key else attestation.get("encryptionPubKey")
        )
    return result


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _cmp_os(a: str, b: str) -> int:
    pa, pb = _ver(a), _ver(b)
    for i in range(max(len(pa), len(pb))):
        x = pa[i] if i < len(pa) else 0
        y = pb[i] if i < len(pb) else 0
        if x != y:
            return -1 if x < y else 1
    return 0


def _ver(s: str) -> list[int]:
    m = re.search(r"\d+(?:\.\d+)*", s)
    if not m:
        return [-1]
    return [int(p) for p in m.group(0).split(".")]
