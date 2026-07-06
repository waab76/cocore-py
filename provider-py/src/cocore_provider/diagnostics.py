"""Read-only health checks backing `cocore-provider doctor` and
`cocore-provider attestation-status`. Unlike the Rust agent's `doctor --fix`,
there is no automatic repair path here -- provider-py has no LaunchAgent/
launchctl equivalent to bounce, so this module only diagnoses, it never
mutates anything. Mirrors the checks in `provider/src/doctor.rs` that are
still meaningful for a config-file/env-var-only, no-pairing-flow agent (see
docs/plans/0004-provider-py-rust-parity-gap-analysis.md item 2)."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from cocore_provider.config import AgentConfig
from cocore_provider.identity import Identity
from cocore_provider.lmstudio import LMStudioClient, LMStudioError
from cocore_provider.pds_client import PdsClient, PdsError

REQUEST_TIMEOUT_SECS = 6.0


@dataclass
class Check:
    name: str
    ok: bool
    note: str


def format_check(check: Check) -> str:
    mark = "✓" if check.ok else "✗"
    return f"  [{mark}] {check.name} — {check.note}"


async def check_lmstudio(lmstudio_url: str, http: httpx.AsyncClient) -> Check:
    client = LMStudioClient(base_url=lmstudio_url, http=http)
    try:
        models = await client.list_models()
    except LMStudioError as e:
        return Check(name="LMStudio", ok=False, note=f"unreachable at {lmstudio_url}: {e}")
    if not models:
        return Check(
            name="LMStudio", ok=False, note=f"reachable at {lmstudio_url} but no models loaded"
        )
    return Check(name="LMStudio", ok=True, note=f"{lmstudio_url} serving: {', '.join(models)}")


async def check_whoami(api_base: str, api_key: str, http: httpx.AsyncClient) -> Check:
    url = f"{api_base.rstrip('/')}/api/agent/whoami"
    try:
        resp = await http.get(
            url, headers={"Authorization": f"Bearer {api_key}"}, timeout=REQUEST_TIMEOUT_SECS
        )
    except httpx.HTTPError as e:
        return Check(name="API key", ok=False, note=f"GET {url} failed: {e}")
    if resp.status_code == 401:
        return Check(
            name="API key",
            ok=False,
            note="401 from the console — COCORE_API_KEY is invalid or revoked; mint a fresh one.",
        )
    if resp.status_code != 200:
        return Check(name="API key", ok=False, note=f"GET {url} returned {resp.status_code}")
    try:
        body = resp.json()
        valid = bool(body["valid"])
        did = str(body["did"])
    except (KeyError, ValueError) as e:
        return Check(name="API key", ok=False, note=f"parse whoami response: {e}")
    if not valid:
        return Check(name="API key", ok=False, note="console returned 200 but valid=false")
    return Check(name="API key", ok=True, note=f"valid; resolves to {did}")


async def check_health(api_base: str, api_key: str, http: httpx.AsyncClient) -> Check:
    url = f"{api_base.rstrip('/')}/api/agent/health"
    try:
        resp = await http.get(
            url, headers={"Authorization": f"Bearer {api_key}"}, timeout=REQUEST_TIMEOUT_SECS
        )
    except httpx.HTTPError as e:
        return Check(name="cross-system health", ok=False, note=f"GET {url} failed: {e}")
    if resp.status_code != 200:
        return Check(
            name="cross-system health", ok=False, note=f"GET {url} returned {resp.status_code}"
        )
    try:
        body = resp.json()
        diagnosis = str(body["diagnosis"])
        hint = str(body["hint"])
        advisor_online = bool(body["advisor"]["online"])
        provider_record = body["pds"]["providerRecord"]
    except (KeyError, ValueError, TypeError) as e:
        return Check(name="cross-system health", ok=False, note=f"parse health response: {e}")
    advisor_summary = "advisor sees us" if advisor_online else "advisor offline"
    pds_summary = (
        f"provider record at {provider_record['uri']}"
        if provider_record
        else "no provider record on PDS"
    )
    return Check(
        name="cross-system health",
        ok=diagnosis == "healthy",
        note=f"{advisor_summary} · {pds_summary} · diagnosis={diagnosis} — {hint}",
    )


async def run_doctor(
    config: AgentConfig, *, lmstudio_http: httpx.AsyncClient, console_http: httpx.AsyncClient
) -> list[Check]:
    checks = [await check_lmstudio(config.lmstudio_url, lmstudio_http)]
    whoami = await check_whoami(config.api_base, config.api_key, console_http)
    checks.append(whoami)
    if whoami.ok:
        checks.append(await check_health(config.api_base, config.api_key, console_http))
    else:
        checks.append(
            Check(
                name="cross-system health",
                ok=False,
                note="skipped because the API key check above failed.",
            )
        )
    return checks


def _value_field(record: dict[str, object], field: str) -> object:
    value = record.get("value")
    return value.get(field) if isinstance(value, dict) else None


async def check_attestation_status(pds: PdsClient, identity: Identity) -> Check:
    pub_key = identity.signing_public_b64
    try:
        attestations = await pds.list_records("dev.cocore.compute.attestation")
    except PdsError as e:
        return Check(name="attestation", ok=False, note=f"could not read attestation records: {e}")

    mine = [r for r in attestations if _value_field(r, "publicKey") == pub_key]
    if not mine:
        return Check(
            name="attestation",
            ok=False,
            note=(
                "no attestation record published yet for this identity — run `serve` at least once."
            ),
        )
    mine.sort(key=lambda r: str(_value_field(r, "attestedAt") or ""), reverse=True)
    latest = mine[0]
    attested_at = str(_value_field(latest, "attestedAt") or "")
    expires_at_raw = str(_value_field(latest, "expiresAt") or "")
    expired = False
    if expires_at_raw:
        try:
            expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            expired = datetime.now(UTC) > expires_at
        except ValueError:
            pass

    fault_note = ""
    try:
        providers = await pds.list_records("dev.cocore.compute.provider")
    except PdsError:
        providers = []
    mine_providers = [r for r in providers if _value_field(r, "attestationPubKey") == pub_key]
    if mine_providers:
        fault = _value_field(mine_providers[0], "attestationFault")
        if isinstance(fault, dict):
            fault_note = f" · attestationFault: {fault.get('code')} — {fault.get('message')}"

    uri = str(latest.get("uri", ""))
    status = "expired" if expired else "valid"
    return Check(
        name="attestation",
        ok=not expired and not fault_note,
        note=(
            f"{uri} attestedAt={attested_at} expiresAt={expires_at_raw} ({status}), "
            f"tier=best-effort{fault_note}"
        ),
    )
